import { Octokit } from '@octokit/core';
import { throttling } from '@octokit/plugin-throttling';
import { execFileSync } from 'node:child_process';
import type { Config } from './config.js';
import { OpsError } from './errors.js';
import { queries, type QueryName } from './queries.js';
import { RateGate, type Clock, type WindowStorage } from './rate.js';

export interface WireRequest { method: 'GET' | 'POST'; path: string; query?: string; variables?: Record<string, string | number | null> }
export interface WireResponse { status: number; headers: Record<string, string | undefined>; data: unknown }
export type Transport = (request: WireRequest) => Promise<WireResponse>;
export interface RequestTimings { networkMs: number; pacingWaitMs: number; quotaWaitMs: number; retryWaitMs: number }
export interface ClientActivity { phase: 'network' | 'pacing-wait' | 'quota-wait' | 'retry-wait' | 'idle'; operation: string; bucket: string; waitMs?: number; startedAt?: number; requests: number; timings: RequestTimings }

export function authentication(config: Config): string {
  if (config.auth.method === 'env') {
    const token = process.env[config.auth.token_env];
    if (!token) throw new OpsError('Selected authentication environment variable is not set.', 'CONFIG_ERROR', 'AUTH_MISSING');
    return token;
  }
  try { return execFileSync('gh', ['auth', 'token', '--hostname', 'github.com', '--user', config.auth.account], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 }).trim(); }
  catch { throw new OpsError('gh authentication is unavailable for the configured account. Check existing gh authentication locally.', 'CONFIG_ERROR', 'AUTH_UNAVAILABLE'); }
}

export function octokitTransport(token: string, fetchImplementation: typeof fetch = fetch): Transport {
  const Client = Octokit.plugin(throttling);
  let pluginWait = 0;
  let pluginLimited = false;
  const api = new Client({
    auth: token,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    request: { timeout: 15000, fetch: fetchImplementation },
    throttle: {
      // The plugin derives server wait durations. One outer controller owns all retries.
      onRateLimit: (retryAfter: number) => { pluginLimited = true; pluginWait = Math.max(pluginWait, retryAfter); return false; },
      onSecondaryRateLimit: (retryAfter: number) => { pluginLimited = true; pluginWait = Math.max(pluginWait, retryAfter); return false; },
    },
  });
  return async request => {
    pluginWait = 0;
    pluginLimited = false;
    try {
      const response = request.method === 'GET' ? await api.request(`GET ${request.path}`) : await api.request('POST /graphql', { query: request.query, variables: request.variables });
      return { status: response.status, headers: response.headers as Record<string, string>, data: response.data };
    } catch (error) {
      const failure = error as { status?: number; response?: { status?: number; headers?: Record<string, string> } };
      // Discard dependency error bodies and request/authorization objects.
      const headers = { ...failure.response?.headers };
      if (pluginWait) headers['retry-after'] = String(pluginWait);
      // Octokit assigns status 500 to fetch failures without an HTTP response.
      // Only response metadata establishes an HTTP status; transport failures use 0.
      return { status: pluginLimited ? 429 : failure.response?.status ?? 0, headers, data: null };
    }
  };
}

export class GithubClient {
  private queue: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private readonly counters: Record<string, number> = {};
  private readonly timingTotals: RequestTimings = { networkMs: 0, pacingWaitMs: 0, quotaWaitMs: 0, retryWaitMs: 0 };
  timings(): RequestTimings { return { ...this.timingTotals }; }
  private activity(phase: ClientActivity['phase'], operation: string, bucket: string, waitMs?: number): void { this.onActivity?.({ phase, operation, bucket, waitMs, startedAt: this.clock.now(), requests: Object.values(this.counters).reduce((sum, count) => sum + count, 0), timings: this.timings() }); }
  private async wait(milliseconds: number, phase: 'pacing-wait' | 'quota-wait' | 'retry-wait', operation: string, bucket: string): Promise<void> {
    this.activity(phase, operation, bucket, milliseconds); const start = this.clock.now();
    await this.clock.sleep(milliseconds);
    const key = phase === 'pacing-wait' ? 'pacingWaitMs' : phase === 'quota-wait' ? 'quotaWaitMs' : 'retryWaitMs';
    this.timingTotals[key] += Math.max(0, this.clock.now() - start);
  }
  constructor(private readonly transport: Transport, private readonly gate: RateGate, private readonly clock: Clock, private readonly config: Config['rate_limit'], private readonly windows: WindowStorage, private readonly account: string, private readonly onActivity?: (activity: ClientActivity) => void, private readonly onIdentityConfirmed?: () => void) {}
  confirmIdentity(login: string): void {
    if (login.toLowerCase() !== this.account.toLowerCase()) throw new OpsError('Authenticated account differs from configuration.', 'FAILED', 'ACCOUNT_MISMATCH');
    this.onIdentityConfirmed?.();
  }
  budgets() { return { core: this.gate.summary('core'), graphql: this.gate.summary('graphql') }; }
  counts(): Record<string, number> { return { ...this.counters }; }
  private serialize<T>(work: () => Promise<T>): Promise<T> { const result = this.queue.then(work, work); this.queue = result.catch(() => undefined); return result; }

  private async execute(request: WireRequest, operation: string, bucket: 'core' | 'graphql', cost: number, quotaProbe = false): Promise<unknown> {
    return this.serialize(() => this.executeNow(request, operation, bucket, cost, quotaProbe));
  }
  private async executeNow(request: WireRequest, operation: string, bucket: 'core' | 'graphql', cost: number, quotaProbe = false): Promise<unknown> {
      if (this.stopped) throw new OpsError('The synchronization round stopped after persistent throttling.', 'PAUSED', 'ROUND_PAUSED');
      for (let attempt = 0; attempt <= this.config.max_retries; attempt++) {
        const paceKey = `${this.account.toLowerCase()}:pacing`;
        const prior = this.windows.get(paceKey);
        const wait = Math.max(0, (prior?.nextAt ?? 0) - this.clock.now());
        if (wait > 60000) throw new OpsError('A recorded server wait is pending.', 'PAUSED', 'WAIT_PENDING');
        if (wait) await this.wait(wait, 'pacing-wait', operation, bucket);
        if (!quotaProbe) {
          try { await this.gate.reserve(bucket, cost, ms => this.wait(ms, 'quota-wait', operation, bucket)); }
          catch (error) {
            if (!(error instanceof OpsError) || error.code !== 'QUOTA_REFRESH_REQUIRED') throw error;
            // Already inside the single queue: probe directly, never enqueue recursively.
            await this.refreshQuotaNow();
            const afterProbe = Math.max(0, (this.windows.get(paceKey)?.nextAt ?? 0) - this.clock.now());
            if (afterProbe > 60000) throw new OpsError('A recorded server wait is pending.', 'PAUSED', 'WAIT_PENDING');
            if (afterProbe) await this.wait(afterProbe, 'pacing-wait', operation, bucket);
            await this.gate.reserve(bucket, cost, ms => this.wait(ms, 'quota-wait', operation, bucket));
          }
        }
        this.windows.set(paceKey, { limit: 1, remaining: 1, used: 0, resetAt: this.clock.now() + this.config.min_interval_ms, nextAt: this.clock.now() + this.config.min_interval_ms, lastCost: 0 });
        this.counters[operation] = (this.counters[operation] ?? 0) + 1;
        let response: WireResponse;
        this.activity('network', operation, bucket); const networkStart = this.clock.now();
        try { response = await this.transport(request); }
        catch { response = { status: 0, headers: {}, data: null }; }
        this.timingTotals.networkMs += Math.max(0, this.clock.now() - networkStart);
        this.activity('idle', operation, bucket);
        const headers = response.headers;
        let quotaError: unknown;
        try {
          if (bucket === 'core' && headers['x-ratelimit-limit']) this.gate.update(headers['x-ratelimit-resource'] ?? 'core', {
            limit: Number(headers['x-ratelimit-limit']), remaining: Number(headers['x-ratelimit-remaining']), resetAt: Number(headers['x-ratelimit-reset']) * 1000, cost: quotaProbe ? 0 : 1,
          }, quotaProbe ? 0 : cost, quotaProbe);
        } catch (error) {
          if (!(error instanceof OpsError) || error.code !== 'QUOTA_UNKNOWN') throw error;
          // Invalid quota metadata must never discard a valid server-directed wait.
          quotaError = error;
        }
        const graphErrors = (response.data as { errors?: { type?: string }[] } | null)?.errors;
        const limited = response.status === 429 || graphErrors?.some(error => error.type === 'RATE_LIMITED') || (response.status === 403 && (headers['retry-after'] !== undefined || headers['x-ratelimit-remaining'] === '0'));
        if (limited) {
          const seconds = headers['retry-after'];
          const retryDate = seconds && !/^\d+(?:\.\d+)?$/.test(seconds) ? Date.parse(seconds) : NaN;
          const milliseconds = Math.max(this.config.min_interval_ms, Number.isFinite(retryDate) ? retryDate - this.clock.now() : seconds ? Number(seconds) * 1000 : headers['x-ratelimit-reset'] ? Number(headers['x-ratelimit-reset']) * 1000 - this.clock.now() : 60000);
          this.gate.defer(bucket, milliseconds);
          const pacing = this.windows.get(paceKey)!;
          this.windows.set(paceKey, { ...pacing, nextAt: this.clock.now() + milliseconds });
          if (attempt === this.config.max_retries || milliseconds > 60000) { this.stopped = true; throw new OpsError('GitHub throttled this round. Resume after the saved wait.', 'PAUSED', 'SERVER_THROTTLED'); }
          if (quotaError) throw quotaError;
          await this.wait(milliseconds, 'retry-wait', operation, bucket);
          continue;
        }
        if ([0, 408, 500, 502, 503, 504].includes(response.status)) {
          const after = headers['retry-after'];
          const requested = after ? /^\d+(?:\.\d+)?$/.test(after) ? Number(after) * 1000 : Date.parse(after) - this.clock.now() : NaN;
          const milliseconds = Math.max(this.config.min_interval_ms, Number.isFinite(requested) ? requested : 5000 * 2 ** attempt);
          this.gate.defer(bucket, milliseconds);
          const pacing = this.windows.get(paceKey)!;
          this.windows.set(paceKey, { ...pacing, nextAt: Math.max(pacing.nextAt, this.clock.now() + milliseconds) });
          if (milliseconds > 60000) { this.stopped = true; throw new OpsError('A server wait is pending. Resume after the recorded allowed time.', 'PAUSED', 'WAIT_PENDING'); }
          if (quotaError) throw quotaError;
          if (attempt < this.config.max_retries) { await this.wait(milliseconds, 'retry-wait', operation, bucket); continue; }
        }
        if (response.status < 200 || response.status >= 300) throw new OpsError(response.status === 0 ? 'GitHub could not be reached.' : `GitHub read failed with HTTP ${response.status}.`, 'FAILED', response.status ? `HTTP_${response.status}` : 'NETWORK_UNAVAILABLE');
        if (quotaError) throw quotaError;
        if (bucket === 'graphql') {
          const body = response.data as { data?: { rateLimit?: { cost: number; limit: number; remaining: number; resetAt: string } }; errors?: unknown[] };
          const quota = body.data?.rateLimit;
          if (headers['x-ratelimit-limit']) {
            this.gate.update('graphql', { limit: Number(headers['x-ratelimit-limit']), remaining: Number(headers['x-ratelimit-remaining']), resetAt: Number(headers['x-ratelimit-reset']) * 1000, cost: quota?.cost ?? cost }, cost);
          } else if (quota) this.gate.update('graphql', { ...quota, resetAt: Date.parse(quota.resetAt) }, cost);
          if (body.errors?.length || !body.data) throw new OpsError('GraphQL read returned incomplete data; pagination is not marked complete.', 'PARTIAL', 'GRAPHQL_PARTIAL');
          return body.data;
        }
        return response.data;
      }
      throw new OpsError('Request stopped.', 'PAUSED');
  }

  viewer(): Promise<{ login: string; id: number }> { return this.execute({ method: 'GET', path: '/user' }, 'viewer', 'core', 1) as Promise<{ login: string; id: number }>; }
  refreshQuota(): Promise<void> { return this.serialize(() => this.refreshQuotaNow()); }
  private async refreshQuotaNow(): Promise<void> {
    const result = await this.executeNow({ method: 'GET', path: '/rate_limit' }, 'quota', 'core', 0, true) as { resources?: Record<string, { limit: number; remaining: number; reset: number }> };
    if (!result.resources?.core || !result.resources.graphql) throw new OpsError('GitHub rate limits are unavailable.', 'PAUSED', 'QUOTA_UNKNOWN');
    for (const name of ['core', 'graphql']) {
      const resource = result.resources[name]!;
      this.gate.update(name, { limit: resource.limit, remaining: resource.remaining, resetAt: resource.reset * 1000, cost: 0 }, 0, true);
    }
  }
  query<T>(name: QueryName, variables: Record<string, string | number | null>): Promise<T> {
    if (!Object.hasOwn(queries, name)) return Promise.reject(new OpsError('Only registered read-only queries are permitted.', 'FAILED', 'READ_ONLY'));
    const cost = Math.max(name === 'index' || name === 'indexOpen' || name === 'threads' ? 5 : 1, this.gate.state('graphql')?.lastCost ?? 1);
    return this.execute({ method: 'POST', path: '/graphql', query: queries[name], variables }, name, 'graphql', cost) as Promise<T>;
  }
}

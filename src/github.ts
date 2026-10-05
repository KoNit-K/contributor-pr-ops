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
  constructor(private readonly transport: Transport, private readonly gate: RateGate, private readonly clock: Clock, private readonly config: Config['rate_limit'], private readonly windows: WindowStorage, private readonly account: string) {}
  counts(): Record<string, number> { return { ...this.counters }; }
  private serialize<T>(work: () => Promise<T>): Promise<T> { const result = this.queue.then(work, work); this.queue = result.catch(() => undefined); return result; }

  private async execute(request: WireRequest, operation: string, bucket: 'core' | 'graphql', cost: number, quotaProbe = false): Promise<unknown> {
    return this.serialize(async () => {
      if (this.stopped) throw new OpsError('The synchronization round stopped after persistent throttling.', 'PAUSED', 'ROUND_PAUSED');
      for (let attempt = 0; attempt <= this.config.max_retries; attempt++) {
        const paceKey = `${this.account.toLowerCase()}:pacing`;
        const prior = this.windows.get(paceKey);
        const wait = Math.max(0, (prior?.nextAt ?? 0) - this.clock.now());
        if (wait > 60000) throw new OpsError('A recorded server wait is pending.', 'PAUSED', 'WAIT_PENDING');
        if (wait) await this.clock.sleep(wait);
        if (!quotaProbe) await this.gate.reserve(bucket, cost);
        this.windows.set(paceKey, { limit: 1, remaining: 1, used: 0, resetAt: this.clock.now() + this.config.min_interval_ms, nextAt: this.clock.now() + this.config.min_interval_ms, lastCost: 0 });
        this.counters[operation] = (this.counters[operation] ?? 0) + 1;
        let response: WireResponse;
        try { response = await this.transport(request); }
        catch { throw new OpsError('GitHub transport failed; no successful snapshot was recorded.', 'FAILED', 'NETWORK_UNAVAILABLE'); }
        const headers = response.headers;
        if (bucket === 'core' && headers['x-ratelimit-limit']) this.gate.update(headers['x-ratelimit-resource'] ?? 'core', {
          limit: Number(headers['x-ratelimit-limit']), remaining: Number(headers['x-ratelimit-remaining']), resetAt: Number(headers['x-ratelimit-reset']) * 1000, cost: quotaProbe ? 0 : 1,
        }, quotaProbe ? 0 : cost);
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
          await this.clock.sleep(milliseconds);
          continue;
        }
        if (response.status < 200 || response.status >= 300) throw new OpsError(response.status === 0 ? 'GitHub could not be reached.' : `GitHub read failed with HTTP ${response.status}.`, 'FAILED', response.status ? `HTTP_${response.status}` : 'NETWORK_UNAVAILABLE');
        if (bucket === 'graphql') {
          const body = response.data as { data?: { rateLimit?: { cost: number; limit: number; remaining: number; resetAt: string } }; errors?: unknown[] };
          const quota = body.data?.rateLimit;
          if (quota) this.gate.update('graphql', { ...quota, resetAt: Date.parse(quota.resetAt) }, cost);
          if (body.errors?.length || !body.data) throw new OpsError('GraphQL read returned incomplete data; pagination is not marked complete.', 'PARTIAL', 'GRAPHQL_PARTIAL');
          return body.data;
        }
        return response.data;
      }
      throw new OpsError('Request stopped.', 'PAUSED');
    });
  }

  viewer(): Promise<{ login: string; id: number }> { return this.execute({ method: 'GET', path: '/user' }, 'viewer', 'core', 1) as Promise<{ login: string; id: number }>; }
  async refreshQuota(): Promise<void> {
    const result = await this.execute({ method: 'GET', path: '/rate_limit' }, 'quota', 'core', 0, true) as { resources?: Record<string, { limit: number; remaining: number; reset: number }> };
    if (!result.resources?.core || !result.resources.graphql) throw new OpsError('GitHub rate limits are unavailable.', 'PAUSED', 'QUOTA_UNKNOWN');
    for (const [name, resource] of Object.entries(result.resources)) this.gate.update(name, { limit: resource.limit, remaining: resource.remaining, resetAt: resource.reset * 1000, cost: 0 });
  }
  query<T>(name: QueryName, variables: Record<string, string | number | null>): Promise<T> {
    if (!Object.hasOwn(queries, name)) return Promise.reject(new OpsError('Only registered read-only queries are permitted.', 'FAILED', 'READ_ONLY'));
    const cost = Math.max(name === 'index' || name === 'threads' ? 5 : 1, this.gate.state('graphql')?.lastCost ?? 1);
    return this.execute({ method: 'POST', path: '/graphql', query: queries[name], variables }, name, 'graphql', cost) as Promise<T>;
  }
}

import type { Config } from './config.js';
import { OpsError } from './errors.js';

export interface Clock { now(): number; sleep(milliseconds: number): Promise<void> }
export const systemClock: Clock = { now: Date.now, sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) };
export interface BucketState { limit: number; remaining: number; resetAt: number; used: number; nextAt: number; lastCost: number }
export interface WindowStorage { get(key: string): BucketState | undefined; set(key: string, state: BucketState): void }
export interface QuotaResponse { limit: number; remaining: number; resetAt: number; cost: number }

export class RateGate {
  constructor(private readonly config: Config['rate_limit'], private readonly clock: Clock, private readonly storage: WindowStorage, private readonly account: string) {}
  private key(bucket: string): string { return `${this.account.toLowerCase()}:${bucket}`; }
  state(bucket: string): BucketState | undefined { return this.storage.get(this.key(bucket)); }

  update(bucket: string, response: QuotaResponse, reserved = 0, quotaProbe = false): void {
    if (![response.limit, response.remaining, response.resetAt, response.cost].every(Number.isFinite) || response.limit <= 0 || response.remaining < 0 || response.cost < 0) throw new OpsError('Invalid rate-limit response.', 'PAUSED', 'QUOTA_UNKNOWN');
    const old = this.state(bucket);
    // Reset timestamps can disagree across responses. Only expiration may grant
    // a fresh project budget; a charged response must preserve it too.
    const active = !!old && old.resetAt > this.clock.now();
    const sameWindow = !!old && (old.resetAt === response.resetAt || active);
    const used = sameWindow ? Math.max(0, old.used + response.cost - reserved) : response.cost;
    this.storage.set(this.key(bucket), {
      limit: response.limit, remaining: sameWindow && quotaProbe ? Math.min(old.remaining, response.remaining) : response.remaining,
      resetAt: active ? quotaProbe ? old.resetAt : Math.max(old.resetAt, response.resetAt) : response.resetAt, used,
      nextAt: sameWindow ? old.nextAt : this.clock.now(), lastCost: response.cost || old?.lastCost || 1,
    });
  }

  async reserve(bucket: string, cost: number, sleep?: (milliseconds: number) => Promise<void>): Promise<void> {
    const state = this.state(bucket);
    if (!state || this.clock.now() >= state.resetAt) throw new OpsError('Rate window requires an explicit quota refresh.', 'PAUSED', 'QUOTA_REFRESH_REQUIRED');
    const allowed = Math.floor(state.limit * this.config.quota_fraction);
    if (cost < 1 || state.used + cost > allowed || cost > state.remaining) throw new OpsError('Quota reached. Resume after the recorded reset time.', 'PAUSED', 'QUOTA_EXHAUSTED');
    const wait = Math.max(0, state.nextAt - this.clock.now());
    if (wait > 60000) throw new OpsError('Server wait is pending. Resume after the recorded allowed time.', 'PAUSED', 'WAIT_PENDING');
    if (wait) await (sleep ? sleep(wait) : this.clock.sleep(wait));
    if (this.clock.now() >= state.resetAt) throw new OpsError('Rate window expired while waiting; refresh before sending.', 'PAUSED', 'QUOTA_REFRESH_REQUIRED');
    // Uniformly distribute the remaining project/server allowance over the remaining window.
    const interval = Math.max(this.config.min_interval_ms, Math.ceil((state.resetAt - this.clock.now()) * cost / Math.max(1, Math.min(allowed - state.used, state.remaining))));
    this.storage.set(this.key(bucket), { ...state, used: state.used + cost, remaining: state.remaining - cost, nextAt: this.clock.now() + interval });
  }

  defer(bucket: string, milliseconds: number): void {
    const state = this.state(bucket);
    if (state) this.storage.set(this.key(bucket), { ...state, nextAt: Math.max(state.nextAt, this.clock.now() + milliseconds) });
  }
}

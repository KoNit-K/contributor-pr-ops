import type { Config } from './config.js';
import { OpsError } from './errors.js';

export interface Clock { now(): number; sleep(milliseconds: number): Promise<void> }
export const systemClock: Clock = { now: Date.now, sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) };
export interface BucketState { limit: number; remaining: number; resetAt: number; used: number; nextAt: number; lastCost: number; reservation?: { at: number; cost: number; allowance: number }; deferredUntil?: number; serverResetAt?: number; lastResetAt?: number; observedAt?: number; observation?: { reserved: number; cost: number; usedBefore: number; usedAfter: number } }
export interface WindowStorage { get(key: string): BucketState | undefined; set(key: string, state: BucketState): void }
export interface QuotaResponse { limit: number; remaining: number; resetAt: number; cost: number }

export class RateGate {
  constructor(private readonly config: Config['rate_limit'], private readonly clock: Clock, private readonly storage: WindowStorage, private readonly account: string) {}
  private key(bucket: string): string { return `${this.account.toLowerCase()}:${bucket}`; }
  state(bucket: string): BucketState | undefined { return this.storage.get(this.key(bucket)); }

  update(bucket: string, response: QuotaResponse, reserved = 0, quotaProbe = false): void {
    if (![response.limit, response.remaining, response.resetAt, response.cost].every(Number.isFinite) || response.limit <= 0 || response.remaining < 0 || response.cost < 0 || response.resetAt <= this.clock.now()) throw new OpsError('Invalid rate-limit response.', 'PAUSED', 'QUOTA_UNKNOWN');
    const old = this.state(bucket);
    // Reset timestamps can disagree across responses. Only expiration may grant
    // a fresh project budget; a charged response must preserve it too.
    const active = !!old && old.resetAt > this.clock.now();
    const sameWindow = active;
    const used = sameWindow ? Math.max(0, old.used + response.cost - reserved) : response.cost;
    let nextAt = sameWindow ? old.nextAt : Math.max(this.clock.now(), old?.deferredUntil ?? 0, old && old.serverResetAt === undefined ? old.nextAt : 0);
    const reservation = old?.reservation;
    // Correct only the matching reservation in an unchanged window. Unknown or
    // disagreeing window metadata retains the conservative saved deadline.
    if (sameWindow && !quotaProbe && reserved > 0 && reservation?.cost === reserved && response.resetAt === old.resetAt) {
      const allowance = Math.max(1, Math.min(reservation.allowance, Math.floor(response.limit * this.config.quota_fraction) - (used - response.cost), response.remaining + response.cost));
      const interval = Math.max(this.config.min_interval_ms, Math.ceil((response.resetAt - reservation.at) * response.cost / allowance));
      nextAt = Math.max(reservation.at + interval, old.deferredUntil ?? 0);
    }
    this.storage.set(this.key(bucket), {
      limit: response.limit, remaining: sameWindow && quotaProbe ? Math.min(old.remaining, response.remaining) : response.remaining,
      resetAt: active ? old.resetAt : response.resetAt, serverResetAt: response.resetAt, used,
      lastResetAt: active ? old.lastResetAt : this.clock.now(), observedAt: this.clock.now(),
      observation: { reserved, cost: response.cost, usedBefore: old?.used ?? 0, usedAfter: used },
      nextAt, lastCost: response.cost || old?.lastCost || 1,
      deferredUntil: old?.deferredUntil,
      ...(sameWindow && quotaProbe ? { reservation: old.reservation } : {}),
    });
  }

  summary(bucket: string) {
    const state = this.state(bucket); if (!state) return null;
    return { ...state, projectRemaining: Math.max(0, Math.floor(state.limit * this.config.quota_fraction) - state.used), serverRemaining: state.remaining, projectResetAt: state.resetAt, serverResetAt: state.serverResetAt ?? state.resetAt, refreshRequired: this.clock.now() >= state.resetAt };
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
    this.storage.set(this.key(bucket), { ...state, used: state.used + cost, remaining: state.remaining - cost, nextAt: this.clock.now() + interval, reservation: { at: this.clock.now(), cost, allowance: Math.max(1, Math.min(allowed - state.used, state.remaining)) } });
  }

  defer(bucket: string, milliseconds: number): void {
    const state = this.state(bucket);
    if (state) this.storage.set(this.key(bucket), { ...state, nextAt: Math.max(state.nextAt, this.clock.now() + milliseconds), deferredUntil: Math.max(state.deferredUntil ?? 0, this.clock.now() + milliseconds) });
  }
}

import { describe, it, expect } from 'vitest';
import { RateGate, type BucketState, type Clock } from '../src/rate.js';

function fixture(fraction = 0.4, minInterval = 0) {
  let now = 0;
  const clock: Clock = { now: () => now, sleep: async ms => { now += ms; } };
  const data = new Map<string, BucketState>();
  const gate = new RateGate({ quota_fraction: fraction, min_interval_ms: minInterval, max_retries: 2 }, clock, {
    get: key => data.get(key), set: (key, value) => { data.set(key, structuredClone(value)); },
  }, 'synthetic-account');
  gate.update('core', { limit: 100, remaining: 100, resetAt: 100000, cost: 0 });
  return { gate, clock, data };
}
describe('A03 rate windows', () => {
  it.each([0.3, 0.4, 0.5])('permits exactly the configured fraction %s in a static window', async fraction => {
    const { gate, clock } = fixture(fraction);
    for (let n = 0; n < 100 * fraction; n++) await gate.reserve('core', 1);
    expect(gate.state('core')!.used).toBe(100 * fraction);
    await expect(gate.reserve('core', 1)).rejects.toMatchObject({ outcome: 'PAUSED' });
    expect(clock.now()).toBeLessThan(100000);
  });
  it('spaces requests and retains state across process recreation', async () => {
    const { gate, clock, data } = fixture(0.4, 2000);
    await gate.reserve('core', 1);
    await gate.reserve('core', 1);
    expect(clock.now()).toBeGreaterThanOrEqual(2500);
    const restarted = new RateGate({ quota_fraction: 0.4, min_interval_ms: 2000, max_retries: 2 }, clock, { get: k => data.get(k), set: (k, v) => { data.set(k, v); } }, 'synthetic-account');
    expect(restarted.state('core')?.used).toBe(2);
    await restarted.reserve('core', 1);
    expect(restarted.state('core')?.used).toBe(3);
  });
  it('accounts for GraphQL points and stops after an underestimated cost', async () => {
    const { gate } = fixture();
    gate.update('graphql', { limit: 100, remaining: 100, resetAt: 100000, cost: 0 });
    await gate.reserve('graphql', 5);
    gate.update('graphql', { limit: 100, remaining: 50, resetAt: 100000, cost: 50 }, 5);
    expect(gate.state('graphql')?.used).toBe(50);
    await expect(gate.reserve('graphql', 1)).rejects.toMatchObject({ outcome: 'PAUSED' });
  });
  it('does not treat unknown quota as a free unlimited bucket', async () => {
    const { gate } = fixture();
    await expect(gate.reserve('search', 1)).rejects.toMatchObject({ outcome: 'PAUSED' });
  });
  it('rechecks expiration after a delayed wake-up crosses the reset boundary', async () => {
    const { gate } = fixture(0.4, 2000);
    gate.update('core', { limit: 100, remaining: 100, resetAt: 1000, cost: 0 });
    await gate.reserve('core', 1);
    await expect(gate.reserve('core', 1)).rejects.toMatchObject({ code: 'QUOTA_REFRESH_REQUIRED' });
    expect(gate.state('core')?.used).toBe(1);
  });
});

import { describe, it, expect } from 'vitest';
import { RateGate, type BucketState, type Clock } from '../src/rate.js';

function fixture(fraction = 0.4, minInterval = 0, resetAt = 100000) {
  let now = 0;
  const clock: Clock = { now: () => now, sleep: async ms => { now += ms; } };
  const data = new Map<string, BucketState>();
  const gate = new RateGate({ quota_fraction: fraction, min_interval_ms: minInterval, max_retries: 2 }, clock, {
    get: key => data.get(key), set: (key, value) => { data.set(key, structuredClone(value)); },
  }, 'synthetic-account');
  gate.update('core', { limit: 100, remaining: 100, resetAt, cost: 0 });
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
    const { gate } = fixture(0.4, 2000, 1000);
    await gate.reserve('core', 1);
    await expect(gate.reserve('core', 1)).rejects.toMatchObject({ code: 'QUOTA_REFRESH_REQUIRED' });
    expect(gate.state('core')?.used).toBe(1);
  });
});

it('does not grant a new budget when a quota probe disagrees with the active reset', async () => {
  const { gate, clock } = fixture();
  await gate.reserve('core', 39);
  gate.defer('core', 5000);
  const saved = gate.state('core')!;
  // REST quota probes can disagree with the bucket's established response window.
  gate.update('core', { limit: 100, remaining: 100, resetAt: 120000, cost: 0 }, 0, true);
  expect(gate.state('core')!.used).toBe(39);
  expect(gate.state('core')!.resetAt).toBe(saved.resetAt);
  expect(gate.state('core')!.nextAt).toBe(saved.nextAt);
  await expect(gate.reserve('core', 2)).rejects.toMatchObject({ code: 'QUOTA_EXHAUSTED' });
  await clock.sleep(100001);
  gate.update('core', { limit: 100, remaining: 100, resetAt: 220000, cost: 0 }, 0, true);
  expect(gate.state('core')!.used).toBe(0);
  await expect(gate.reserve('core', 1)).resolves.toBeUndefined();
});

it.each([90000, 120000])('preserves charged usage and pacing when an active response changes reset to %s', async resetAt => {
  const { gate, clock } = fixture();
  await gate.reserve('core', 35);
  gate.update('core', { limit: 100, remaining: 65, resetAt: 100000, cost: 35 }, 35);
  await clock.sleep(gate.state('core')!.nextAt - clock.now());
  await gate.reserve('core', 5);
  const reserved = gate.state('core')!;
  gate.update('core', { limit: 100, remaining: 61, resetAt, cost: 4 }, 5);
  expect(gate.state('core')!.used).toBe(39);
  expect(gate.state('core')!.nextAt).toBe(reserved.nextAt);
  expect(gate.state('core')!.resetAt).toBe(Math.max(100000, resetAt));
  await expect(gate.reserve('core', 2)).rejects.toMatchObject({ code: 'QUOTA_EXHAUSTED' });
  await clock.sleep(Math.max(100000, resetAt) + 1);
  gate.update('core', { limit: 100, remaining: 100, resetAt: 220000, cost: 0 }, 0, true);
  expect(gate.state('core')!.used).toBe(0);
});

it('corrects an overestimated cost interval while keeping actual usage and minimum spacing', async () => {
  const { gate, clock } = fixture(0.8, 200, 80000);
  await gate.reserve('core', 5); expect(gate.state('core')!.nextAt).toBe(5000);
  await clock.sleep(100); gate.update('core', { limit: 100, remaining: 99, resetAt: 80000, cost: 1 }, 5);
  expect(gate.state('core')!.nextAt).toBe(1000); expect(gate.state('core')!.used).toBe(1);
  await gate.reserve('core', 1); expect(clock.now()).toBe(1000);
});
it('never shortens a recorded server wait during actual-cost correction', async () => {
  const { gate } = fixture(0.8, 200, 80000); await gate.reserve('core', 5); gate.defer('core', 10000);
  gate.update('core', { limit: 100, remaining: 99, resetAt: 80000, cost: 1 }, 5);
  expect(gate.state('core')!.nextAt).toBe(10000);
});

it('keeps the minimum floor and persisted server deadline after recreation', async () => {
  const { gate, clock, data } = fixture(0.8, 200, 1000); await gate.reserve('core', 5); gate.defer('core', 500);
  const resumed = new RateGate({ quota_fraction: 0.8, min_interval_ms: 200, max_retries: 2 }, clock, { get: k => data.get(k), set: (k, v) => { data.set(k, v); } }, 'synthetic-account');
  resumed.update('core', { limit: 100, remaining: 99, resetAt: 1000, cost: 1 }, 5); expect(resumed.state('core')!.nextAt).toBe(500);
  await resumed.reserve('core', 1); expect(clock.now()).toBe(500);
});

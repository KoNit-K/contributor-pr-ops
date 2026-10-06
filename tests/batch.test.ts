import { expect, it } from 'vitest';
import { GithubClient, type Transport } from '../src/github.js';
import { RateGate, type BucketState } from '../src/rate.js';
import { config, rawPr } from './helpers.js';

function client(transport: Transport) {
  let now = 0;
  const clock = { now: () => now, sleep: async (ms: number) => { now += ms; } };
  const states = new Map<string, BucketState>();
  const storage = { get: (key: string) => states.get(key), set: (key: string, state: BucketState) => { states.set(key, state); } };
  const settings = { ...config().rate_limit, min_interval_ms: 0 };
  const gate = new RateGate(settings, clock, storage, 'reader');
  gate.update('graphql', { limit: 5000, remaining: 5000, cost: 0, resetAt: 3600000 });
  return new GithubClient(transport, gate, clock, settings, storage, 'reader');
}
const targets = Array.from({ length: 20 }, (_, i) => ({ owner: 'example-org', repo: 'example-repo', number: i + 1 }));
const quota = { cost: 1, limit: 5000, remaining: 4999, resetAt: new Date(3626000).toISOString() };
it('isolates alias errors and serializes registered batches through the shared client', async () => {
  let active = 0, maxActive = 0;
  const api = client(async request => {
    active++; maxActive = Math.max(maxActive, active); await Promise.resolve(); active--;
    expect(request.query).toContain('p0: repository');
    return { status: 200, headers: {}, data: { data: { p0: { pullRequest: rawPr(1) }, p1: null, rateLimit: quota }, errors: [{ type: 'FORBIDDEN', path: ['p1', 'pullRequest'] }] } };
  });
  const [a, b] = await Promise.all([api.queryBatch('preflight', targets.slice(0, 2)), api.queryBatch('preflight', targets.slice(0, 2))]);
  expect(a[0].value).toHaveProperty('repository.pullRequest.number', 1);
  expect(a[1].error?.code).toBe('GRAPHQL_PARTIAL'); expect(b[1].error).toBeDefined(); expect(maxActive).toBe(1);
});
it('shares three attempts across resource splits, without retry multiplication', async () => {
  const sizes: number[] = [];
  const api = client(async request => {
    const size = Object.keys(request.variables!).filter(key => key.startsWith('number')).length; sizes.push(size);
    if (size > 1) return { status: 200, headers: {}, data: { data: { rateLimit: quota }, errors: [{ type: 'MAX_NODE_LIMIT_EXCEEDED' }] } };
    return { status: 200, headers: {}, data: { data: { rateLimit: quota, p0: { pullRequest: rawPr(Number(request.variables!.number0)) } } } };
  });
  const results = await api.queryBatch('preflight', targets);
  expect(results.every(item => item.value && !item.error)).toBe(true);
  expect(sizes).toEqual([20, 5, ...Array(5).fill(1), 5, ...Array(5).fill(1), 5, ...Array(5).fill(1), 5, ...Array(5).fill(1)]);
  expect(api.metrics().downgrades).toBe(5);
});
it('rejects arbitrary query types and unlocatable partial errors without inventing success', async () => {
  const api = client(async () => ({ status: 200, headers: {}, data: { data: { p0: { pullRequest: rawPr(1) }, rateLimit: quota }, errors: [{ type: 'FORBIDDEN' }] } }));
  expect((await api.queryBatch('preflight', targets.slice(0, 1)))[0].error?.code).toBe('GRAPHQL_PARTIAL');
  await expect(api.queryBatch('mutation' as 'preflight', targets)).rejects.toMatchObject({ code: 'READ_ONLY' });
});

it('does not multiply retries before a resource split or split ordinary HTTP permission errors', async () => {
  let calls = 0;
  const api = client(async () => {
    calls++;
    if (calls === 1) return { status: 0, headers: {}, data: null };
    return { status: 200, headers: {}, data: { data: { rateLimit: quota }, errors: [{ type: 'MAX_NODE_LIMIT_EXCEEDED' }] } };
  });
  expect((await api.queryBatch('preflight', targets)).every(item => item.error)).toBe(true);
  expect(calls).toBe(6); // initial + network retry + four five-target requests; three attempts per target
  expect(api.metrics().graphqlCostComplete).toBe(false);
  let denied = 0;
  const restricted = client(async () => { denied++; return { status: 403, headers: {}, data: null }; });
  await expect(restricted.queryBatch('preflight', targets)).rejects.toMatchObject({ code: 'HTTP_403' }); expect(denied).toBe(1);
});
it('keeps missing objects incomplete and reports unknown actual costs explicitly', async () => {
  const api = client(async () => ({ status: 200, headers: {}, data: { data: { p0: null, p1: { pullRequest: rawPr(2) } } } }));
  const result = await api.queryBatch('preflight', targets.slice(0, 2));
  expect(result[0].error).toBeDefined(); expect(result[1].value).toBeDefined();
  expect(api.metrics()).toMatchObject({ confirmedGraphqlCost: 0, graphqlCostComplete: false });
});

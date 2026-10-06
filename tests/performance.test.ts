import { it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { synchronize } from '../src/sync.js';
import { GithubClient, type WireRequest } from '../src/github.js';
import { RateGate, type BucketState } from '../src/rate.js';
import { config, connection, rawPr } from './helpers.js';

it('completes 500 Open PRs within 160 cold and 60 warm requests on the real client path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-ops-performance-')), c = config(); c.storage.directory = dir;
  const db = new Store(':memory:', c.scope), states = new Map<string, BucketState>();
  let time = 0, calls = 0, active = 0, maxActive = 0;
  const clock = { now: () => time, sleep: async (ms: number) => { time += ms; } };
  const storage = { get: (key: string) => states.get(key), set: (key: string, value: BucketState) => { states.set(key, value); } };
  const dataset = [...Array.from({ length: 500 }, (_, i) => rawPr(i + 1)), ...Array.from({ length: 700 }, (_, i) => rawPr(501 + i, { state: 'CLOSED' }))];
  const transport = async (request: WireRequest) => {
    calls++; active++; maxActive = Math.max(maxActive, active); await Promise.resolve(); active--;
    const quota = { cost: 1, limit: 5000, remaining: 4900, resetAt: new Date(3600000).toISOString() };
    if (request.path === '/rate_limit') return { status: 200, headers: {}, data: { resources: { core: { limit: 5000, remaining: 5000, reset: 3600 }, graphql: { limit: 5000, remaining: 4900, reset: 3600 } } } };
    if (request.path === '/user') return { status: 200, headers: {}, data: { login: c.auth.account, id: 1 } };
    const variables = request.variables!, query = request.query!;
    if (query.startsWith('query IndexOpen')) {
      expect(query).toContain('states:[OPEN]');
      const items = dataset.filter(item => item.state === 'OPEN'), start = Number(variables.cursor ?? 0), end = Math.min(start + 100, items.length);
      return { status: 200, headers: {}, data: { data: { rateLimit: quota, user: { pullRequests: { ...connection(items.slice(start, end), end < items.length, end < items.length ? String(end) : null), totalCount: items.length } } } } };
    }
    const data: Record<string, unknown> = { rateLimit: quota };
    expect(query).toMatch(/^query Batch_(preflight|details|final)/);
    const count = Object.keys(variables).filter(key => key.startsWith('number')).length;
    for (let i = 0; i < count; i++) {
      const number = Number(variables['number' + i]);
      data['p' + i] = { pullRequest: { ...rawPr(number), comments: connection([]), reviews: connection([]), reviewThreads: connection([]), commits: connection([]), timelineItems: connection([]) }, object: { oid: 'a'.repeat(40), statusCheckRollup: null } };
    }
    return { status: 200, headers: {}, data: { data } };
  };
  const makeClient = () => new GithubClient(transport, new RateGate(c.rate_limit, clock, storage, c.auth.account), clock, c.rate_limit, storage, c.auth.account);
  try {
    const cold = await synchronize(c, db, { resume: false }, makeClient());
    expect(cold.status).toBe('SUCCESS'); expect(db.all('snapshot')).toHaveLength(500); expect(db.all<{ complete: boolean }>('snapshot').every(s => s.complete)).toBe(true);
    expect(calls).toBeLessThanOrEqual(160); expect(cold.refreshed).toBe(500); expect(cold.cached).toBe(0);
    expect(cold.metrics).toMatchObject({ batchRequests: 150, batchTargets: 1500, supplementalPages: 4, downgrades: 0, graphqlCostComplete: true });
    const coldCalls = calls; calls = 0;
    const warm = await synchronize(c, db, { resume: false }, makeClient());
    expect(warm.status).toBe('SUCCESS'); expect(warm.cached).toBe(500); expect(warm.refreshed).toBe(0); expect(calls).toBeLessThanOrEqual(60);
    expect(maxActive).toBe(1);
    expect([coldCalls, calls]).toEqual([157, 57]);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
}, 30000);

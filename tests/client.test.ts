import { describe, expect, it } from 'vitest';
import { GithubClient, octokitTransport, type Transport, type WireResponse } from '../src/github.js';
import { RateGate, type BucketState, type Clock } from '../src/rate.js';

function client(transport: Transport) {
  let time = 0;
  const clock: Clock = { now: () => time, sleep: async ms => { time += ms; } };
  const state = new Map<string, BucketState>();
  const storage = { get: (key: string) => state.get(key), set: (key: string, value: BucketState) => { state.set(key, value); } };
  const config = { quota_fraction: 0.4, min_interval_ms: 2000, max_retries: 2 };
  const gate = new RateGate(config, clock, storage, 'reader');
  gate.update('core', { limit: 1000, remaining: 1000, resetAt: 3600000, cost: 0 });
  gate.update('graphql', { limit: 1000, remaining: 1000, resetAt: 3600000, cost: 0 });
  return { api: new GithubClient(transport, gate, clock, config, storage, 'reader'), clock, state };
}
const ok: WireResponse = { status: 200, headers: {}, data: { login: 'reader' } };
describe('A02/A03 shared read-only API client', () => {
  it('serializes all concurrent calls and spaces attempts', async () => {
    let active = 0; let maximum = 0; const times: number[] = [];
    const { api, clock } = client(async request => {
      expect(request.method).toBe('GET');
      active++; maximum = Math.max(maximum, active); times.push(clock.now());
      await Promise.resolve(); active--; return ok;
    });
    await Promise.all([api.viewer(), api.viewer(), api.viewer()]);
    expect(maximum).toBe(1);
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(2000);
    expect(api.counts().viewer).toBe(3);
  });
  it('retries at most twice and stops the round on persistent throttling', async () => {
    let attempts = 0;
    const { api, clock } = client(async () => { attempts++; return { status: 429, headers: { 'retry-after': '10' }, data: {} }; });
    await expect(api.viewer()).rejects.toMatchObject({ outcome: 'PAUSED' });
    expect(attempts).toBe(3);
    expect(clock.now()).toBeGreaterThanOrEqual(20000);
    await expect(api.viewer()).rejects.toMatchObject({ outcome: 'PAUSED' });
    expect(attempts).toBe(3);
  });
  it('does not retry normal permission failures', async () => {
    let attempts = 0;
    const { api } = client(async () => { attempts++; return { status: 403, headers: {}, data: {} }; });
    await expect(api.viewer()).rejects.toMatchObject({ code: 'HTTP_403' });
    expect(attempts).toBe(1);
  });
  it('accepts only registered GraphQL reads and reports partial results', async () => {
    const { api } = client(async request => {
      expect(request.method).toBe('POST');
      expect(request.query).toMatch(/^query /);
      expect(request.query).not.toMatch(/\bmutation\b/);
      return { status: 200, headers: {}, data: { data: { user: null }, errors: [{ message: 'synthetic missing resource' }] } };
    });
    await expect(api.query('index', { author: 'contributor', cursor: null })).rejects.toMatchObject({ code: 'GRAPHQL_PARTIAL' });
    await expect(api.query('write' as 'index', {})).rejects.toMatchObject({ code: 'READ_ONLY' });
  });
  it('recognizes HTTP 200 GraphQL RATE_LIMITED as a persistent round pause', async () => {
    let attempts = 0;
    const { api, state } = client(async () => { attempts++; return { status: 200, headers: { 'retry-after': '10' }, data: { errors: [{ type: 'RATE_LIMITED', message: 'synthetic rate limit' }] } }; });
    await expect(api.query('index', { author: 'contributor', cursor: null })).rejects.toMatchObject({ outcome: 'PAUSED' });
    expect(attempts).toBe(3);
    await expect(api.viewer()).rejects.toMatchObject({ outcome: 'PAUSED' });
    expect(attempts).toBe(3);
    expect(state.get('reader:pacing')?.nextAt).toBeGreaterThan(0);
  });
  it('preserves throttling from the real plugin when its error has no top-level status', async () => {
    const mockFetch: typeof fetch = async () => new Response(JSON.stringify({ errors: [{ type: 'RATE_LIMITED', message: 'synthetic limit' }] }), { status: 200, headers: { 'content-type': 'application/json', 'retry-after': '1', 'x-ratelimit-reset': '1', 'x-ratelimit-remaining': '0' } });
    const factory = octokitTransport as unknown as (token: string, fetch: typeof globalThis.fetch) => Transport;
    const transport = factory('synthetic-auth', mockFetch);
    const response = await transport({ method: 'POST', path: '/graphql', query: 'query { rateLimit { cost } }', variables: {} });
    expect(response.status).toBe(429);
    expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
  });
});

it('does not mistake an Octokit network exception for an HTTP 500 response', async () => {
  const failingFetch: typeof fetch = async () => { throw new TypeError('Synthetic transport failure with synthetic-secret-should-not-leak'); };
  const transport = octokitTransport('synthetic-auth', failingFetch);
  const response = await transport({ method: 'GET', path: '/rate_limit' });
  expect(response.status).toBe(0); expect(response.data).toBeNull(); expect(JSON.stringify(response)).not.toContain('synthetic-secret-should-not-leak');
  const { api } = client(transport); await expect(api.refreshQuota()).rejects.toMatchObject({ code: 'NETWORK_UNAVAILABLE' });
});
it('preserves a genuine HTTP 500 response as a server failure', async () => {
  const transport = octokitTransport('synthetic-auth', async () => new Response('{"message":"Synthetic failure"}', { status: 500, headers: { 'content-type': 'application/json' } }));
  const response = await transport({ method: 'GET', path: '/rate_limit' }); expect(response.status).toBe(500);
});

import { afterEach, expect, it, vi } from 'vitest';
import { authentication, octokitTransport } from '../src/github.js';
import { clientFor, checkOnline } from '../src/sync.js';
import { Store } from '../src/store.js';
import { config } from './helpers.js';

afterEach(() => vi.unstubAllEnvs());

it('uses only the selected reader variable while leaving other authentication unchanged', async () => {
  const c = config();
  vi.stubEnv('GH_TOKEN', 'synthetic-interactive-token');
  vi.stubEnv('GITHUB_TOKEN', 'synthetic-other-tool-token');
  vi.stubEnv(c.auth.token_env, 'synthetic-reader-token');
  const headers: string[] = [];
  const transport = octokitTransport(authentication(c), async (_input, options) => {
    headers.push(new Headers(options?.headers).get('authorization') ?? '');
    return new Response('{"login":"your-github-user"}', { headers: { 'content-type': 'application/json' } });
  });
  await transport({ method: 'GET', path: '/user' });
  expect(headers).toEqual(['token synthetic-reader-token']);
  expect(process.env.GH_TOKEN).toBe('synthetic-interactive-token');
  expect(process.env.GITHUB_TOKEN).toBe('synthetic-other-tool-token');
  vi.stubEnv(c.auth.token_env, undefined);
  expect(() => authentication(c)).toThrowError(expect.objectContaining({ code: 'AUTH_MISSING' }));
});

it.each([false, true])('commits bootstrap budgets only after the actual reader identity matches: %s', async matches => {
  const c = config(); c.rate_limit.min_interval_ms = 0;
  vi.stubEnv(c.auth.token_env, 'synthetic-reader-token');
  const paths: string[] = [];
  const priorFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    const path = new URL(String(input)).pathname; paths.push(path);
    const reset = Math.ceil(Date.now() / 1000) + 3600;
    const body = path === '/rate_limit' ? { resources: { core: { limit: 5000, remaining: 4999, reset }, graphql: { limit: 5000, remaining: 5000, reset } } } : { login: matches ? c.auth.account : 'different-reader', id: 42 };
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json', 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4998', 'x-ratelimit-reset': String(reset) } });
  };
  const db = new Store(':memory:', c.scope);
  try {
    const client = clientFor(c, db);
    if (matches) {
      await expect(checkOnline(client, c)).resolves.toEqual({ account: c.auth.account, id: 42 });
      expect(db.getWindow(`${c.auth.account.toLowerCase()}:core`)).toMatchObject({ used: 1 });
      expect(db.getWindow(`${c.auth.account.toLowerCase()}:graphql`)).toMatchObject({ used: 0 });
      expect(db.getWindow(`@unverified-reader:${c.auth.account.toLowerCase()}:core`)).toBeUndefined();
    } else {
      await expect(checkOnline(client, c)).rejects.toMatchObject({ code: 'ACCOUNT_MISMATCH' });
      expect(db.getWindow(`${c.auth.account.toLowerCase()}:core`)).toBeUndefined();
      expect(db.getWindow(`${c.auth.account.toLowerCase()}:graphql`)).toBeUndefined();
    }
    expect(paths).toEqual(['/rate_limit', '/user']);
  } finally { globalThis.fetch = priorFetch; db.close(); }
});

it('retains a server wait across an unverified bootstrap failure without attributing a budget', async () => {
  const c = config(); vi.stubEnv(c.auth.token_env, 'synthetic-reader-token');
  const priorFetch = globalThis.fetch; let attempts = 0;
  globalThis.fetch = async () => { attempts++; return new Response('{}', { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '120' } }); };
  const db = new Store(':memory:', c.scope);
  try {
    await expect(checkOnline(clientFor(c, db), c)).rejects.toMatchObject({ code: 'SERVER_THROTTLED' });
    expect(db.getWindow(`${c.auth.account.toLowerCase()}:graphql`)).toBeUndefined();
    await expect(checkOnline(clientFor(c, db), c)).rejects.toMatchObject({ code: 'WAIT_PENDING' });
    expect(attempts).toBe(1);
  } finally { globalThis.fetch = priorFetch; db.close(); }
});

it.each([429, 503])('retains Retry-After even when HTTP %s has an expired quota header', async status => {
  const c = config(); vi.stubEnv(c.auth.token_env, 'synthetic-reader-token');
  const priorFetch = globalThis.fetch; let attempts = 0;
  globalThis.fetch = async () => { attempts++; return new Response('{}', { status, headers: { 'content-type': 'application/json', 'retry-after': '120', 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) - 1) } }); };
  const db = new Store(':memory:', c.scope);
  try {
    await expect(checkOnline(clientFor(c, db), c)).rejects.toMatchObject({ code: status === 429 ? 'SERVER_THROTTLED' : 'WAIT_PENDING' });
    await expect(checkOnline(clientFor(c, db), c)).rejects.toMatchObject({ code: 'WAIT_PENDING' });
    expect(attempts).toBe(1);
  } finally { globalThis.fetch = priorFetch; db.close(); }
});

it('persists conservative unverified charges across failed bootstrap clients', async () => {
  const c = config(); c.rate_limit.min_interval_ms = 0; c.rate_limit.max_retries = 0;
  vi.stubEnv(c.auth.token_env, 'synthetic-reader-token');
  const priorFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    const reset = Math.ceil(Date.now() / 1000) + 3600;
    const quota = { limit: 1000000000, remaining: 1000000000, reset };
    return new Response(JSON.stringify(String(input).endsWith('/rate_limit') ? { resources: { core: quota, graphql: quota } } : {}), { status: String(input).endsWith('/rate_limit') ? 200 : 503, headers: { 'content-type': 'application/json', 'retry-after': '0', 'x-ratelimit-limit': String(quota.limit), 'x-ratelimit-remaining': String(quota.remaining - 1), 'x-ratelimit-reset': String(reset) } });
  };
  const db = new Store(':memory:', c.scope);
  try {
    const first = clientFor(c, db); await expect(checkOnline(first, c)).rejects.toMatchObject({ code: 'HTTP_503' });
    expect(first.budgets().core!.used).toBe(1);
    const second = clientFor(c, db); await expect(checkOnline(second, c)).rejects.toMatchObject({ code: 'HTTP_503' });
    expect(second.budgets().core!.used).toBe(2);
    expect(db.getWindow(`${c.auth.account.toLowerCase()}:core`)).toBeUndefined();
  } finally { globalThis.fetch = priorFetch; db.close(); }
});

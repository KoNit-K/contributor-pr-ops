import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GithubClient, type WireRequest } from '../src/github.js';
import { RateGate, type BucketState } from '../src/rate.js';
import { fingerprint } from '../src/model.js';
import { Store } from '../src/store.js';
import { synchronize } from '../src/sync.js';
import { config, rawPr, connection } from './helpers.js';

const at = '2026-01-01T00:00:00Z';
const comment = (id: string) => ({ id, body: id, url: 'https://github.com/example-org/example-repo/pull/1#issuecomment-1', createdAt: at, updatedAt: at, author: { login: 'someone', __typename: 'User' }, authorAssociation: 'NONE' });
const source = (number: number) => ({ id: 'issue-' + number, number, __typename: 'Issue', url: 'https://github.com/example-org/example-repo/issues/' + number, title: 'Source', body: '', state: 'OPEN', updatedAt: at, repository: { nameWithOwner: 'example-org/example-repo' } });
function fixture(count = 20) {
  const directory = mkdtempSync(join(tmpdir(), 'pr-ops-batch-')), c = config(); c.storage.directory = directory;
  const db = new Store(':memory:', c.scope), windows = new Map<string, BucketState>(); let time = 0;
  const clock = { now: () => time, sleep: async (ms: number) => { time += ms; } };
  const storage = { get: (k: string) => windows.get(k), set: (k: string, v: BucketState) => { windows.set(k, v); } };
  const reads: WireRequest[] = [];
  const mode = { related: false, nested: false, failTail: false, changedHead: false, denied: false, edited: false, checkTail: false, changeAfterChecks: false };
  const make = () => new GithubClient(async request => {
    reads.push(request);
    if (request.path === '/user') return { status: 200, headers: {}, data: { login: c.auth.account, id: 1 } };
    if (request.path === '/rate_limit') return { status: 200, headers: {}, data: { resources: { core: { limit: 5000, remaining: 5000, reset: 3600 }, graphql: { limit: 5000, remaining: 5000, reset: 3600 } } } };
    const v = request.variables!, q = request.query!, data: Record<string, unknown> = { rateLimit: { cost: 1, limit: 5000, remaining: 4900, resetAt: new Date(3600000).toISOString() } };
    if (q.startsWith('query IndexOpen')) data.user = { pullRequests: { ...connection(Array.from({ length: count }, (_, i) => rawPr(i + 1))), totalCount: count } };
    else if (q.startsWith('query Batch_')) {
      const indices = Object.keys(v).filter(key => /^(number|id)\d+$/.test(key)).map(key => Number(key.replace(/\D/g, '')));
      for (const i of new Set(indices)) {
        const n = Number(v['number' + i]);
        const thread = { id: 'thread-' + n, isResolved: false, isOutdated: false, comments: connection([comment('first-' + n)], true, 'thread-tail') };
        const details = { ...rawPr(n, { headRefOid: mode.changedHead && (q.startsWith('query Batch_final') || mode.changeAfterChecks) ? 'b'.repeat(40) : 'a'.repeat(40) }), comments: connection(mode.edited ? [comment('edited')] : []), reviews: connection([]), reviewThreads: connection(mode.nested ? [thread] : []), commits: connection([]), timelineItems: connection(mode.related ? [{ id: 'event-' + n, __typename: 'CrossReferencedEvent', actor: { login: 'actor-' + n }, createdAt: at, source: source(900 + n % 10) }] : []) };
        if (q.startsWith('query Batch_relationComments')) data['p' + i] = { comments: connection([comment('discussion-' + v['id' + i])], true, 'discussion-tail') };
        else if (q.startsWith('query Batch_relation')) data['p' + i] = { issueOrPullRequest: source(n) };
        else data['p' + i] = { pullRequest: details, object: { oid: 'a'.repeat(40), statusCheckRollup: mode.checkTail ? { contexts: connection([{ id: 'first-check', context: 'first', state: 'SUCCESS' }], true, 'checks-tail') } : null } };
      }
      if (mode.denied && q.startsWith('query Batch_details')) return { status: 200, headers: {}, data: { data, errors: [{ type: 'FORBIDDEN', path: ['p0', 'pullRequest', 'comments'] }] } };
    } else if (q.startsWith('query ThreadComments') || q.startsWith('query RelationComments')) {
      if (mode.failTail) return { status: 200, headers: {}, data: { data, errors: [{ type: 'FORBIDDEN' }] } };
      data.node = { comments: connection([comment('last-' + v.id)]) };
    } else if (q.startsWith('query Checks')) { if (mode.changeAfterChecks) mode.changedHead = true; data.repository = { object: { oid: 'a'.repeat(40), statusCheckRollup: { contexts: connection([{ id: 'check', context: 'CI', state: 'SUCCESS', isRequired: true }]) } } }; }
    else throw new Error('Unexpected fixture query');
    return { status: 200, headers: {}, data: { data } };
  }, new RateGate(c.rate_limit, clock, storage, c.auth.account), clock, c.rate_limit, storage, c.auth.account);
  return { c, db, reads, mode, run: (refresh = false, resume = false) => synchronize(c, db, { resume, refresh }, make()), close: () => { db.close(); rmSync(directory, { recursive: true, force: true }); } };
}
it('deduplicates shared relations but preserves referrers and reads every discussion page', async () => {
  const f = fixture(40); f.mode.related = true;
  try {
    expect((await f.run()).status).toBe('SUCCESS');
    expect(f.db.all('snapshot')).toHaveLength(40);
    expect(f.reads.filter(r => r.query?.startsWith('query Batch_relation('))).toHaveLength(1);
    expect(f.reads.filter(r => r.query?.startsWith('query Batch_relationComments'))).toHaveLength(2);
    expect(f.reads.filter(r => r.query?.startsWith('query RelationComments'))).toHaveLength(10);
    expect(f.db.snapshot(11)!.relations[0]).toMatchObject({ actor: 'actor-11', complete: true, discussion: expect.any(Array) });
    expect(f.db.snapshot(11)!.relations[0].discussion).toHaveLength(2);
  } finally { f.close(); }
});
it('retains good snapshots on nested last-page failure and resumes versioned pagination', async () => {
  const f = fixture(2);
  try {
    await f.run(); const good = f.db.snapshot(1);
    f.mode.nested = true; f.mode.failTail = true;
    expect((await f.run(true)).status).toBe('PARTIAL'); expect(f.db.snapshot(1)).toEqual(good);
    expect(f.db.all<{ format: number }>('pages').every(p => p.format === 2)).toBe(true);
    f.mode.failTail = false;
    expect((await f.run(true, true)).status).toBe('SUCCESS');
    expect(f.db.snapshot(1)!.feedback.map(item => item.id)).toEqual(['first-1', 'last-thread-1']); expect(f.db.all('pages')).toEqual([]);
  } finally { f.close(); }
});
it('rejects changed final heads and preserves isolated successful targets on alias errors', async () => {
  const f = fixture(5);
  try {
    await f.run(); const good = f.db.snapshot(1);
    f.mode.changedHead = true; expect((await f.run(true)).status).toBe('PARTIAL'); expect(f.db.snapshot(1)).toEqual(good);
    f.mode.changedHead = false; f.mode.denied = true;
    const result = await f.run(true); expect(result.remaining).toEqual([1]); expect(result.refreshed).toBe(4); expect(f.db.snapshot(1)).toEqual(good);
  } finally { f.close(); }
});
it('refreshes old comment edits explicitly without deleting confirmations or quota usage', async () => {
  const f = fixture(1);
  try {
    await f.run(); f.db.set('confirmation', 'saved', { synthetic: true }); f.mode.edited = true;
    expect((await f.run()).cached).toBe(1); expect(f.db.snapshot(1)!.feedback).toEqual([]);
    const refreshed = await f.run(true); expect(refreshed.refreshed).toBe(1); expect(f.db.snapshot(1)!.feedback[0].body).toBe('edited'); expect(f.db.get('confirmation', 'saved')).toEqual({ synthetic: true });
    expect(refreshed.budgets!.graphql!.used).toBeGreaterThan(10);
  } finally { f.close(); }
});

it('rechecks metadata after supplemental check pages and keeps all current-head check facts', async () => {
  const f = fixture(2); f.mode.checkTail = true;
  try {
    expect((await f.run()).status).toBe('SUCCESS');
    expect(f.db.snapshot(1)!.checks.map(check => check.id)).toEqual(['first-check', 'check']);
    const lastTail = f.reads.findLastIndex(r => r.query?.startsWith('query Checks'));
    expect(f.reads.slice(lastTail + 1).some(r => r.query?.startsWith('query Batch_preflight'))).toBe(true);
  } finally { f.close(); }
});
it('invalidates content at 24 hours and on a changed reading identity', async () => {
  const f = fixture(1);
  try {
    await f.run(); const old = f.db.snapshot(1)!;
    f.db.saveSnapshot({ ...old, contentCheckedAt: new Date(Date.now() - 24 * 3600000).toISOString() });
    expect((await f.run()).refreshed).toBe(1);
    f.c.auth.account = 'second-reader';
    expect((await f.run()).refreshed).toBe(1); expect(f.db.snapshot(1)!.authAccount).toBe('second-reader');
  } finally { f.close(); }
});

it('revalidates metadata when a resumed checks cursor is already the final page', async () => {
  const f = fixture(1);
  try {
    await f.run(); const old = f.db.snapshot(1)!;
    f.db.set('pages', '1:checks', { format: 2, signature: fingerprint([f.c.auth.account, old.pr.id, old.pr.head, old.pr.updatedAt]), cursor: 'checks-tail', cursors: ['checks-tail'], items: [{ id: 'previous-check', context: 'earlier', state: 'SUCCESS' }] });
    f.mode.changeAfterChecks = true;
    const result = await f.run();
    expect(result.status).toBe('PARTIAL'); expect(result.refreshed).toBe(0); expect(result.cached).toBe(0); expect(result.gaps.join()).toContain('PR_CHANGED_DURING_SCAN'); expect(f.db.snapshot(1)).toEqual(old);
  } finally { f.close(); }
});

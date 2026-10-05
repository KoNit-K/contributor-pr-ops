import { describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';
import { indexAuthor, collectSnapshot } from '../src/collect.js';
import { config, connection, rawPr } from './helpers.js';
import type { QueryName } from '../src/queries.js';
import type { ReadApi } from '../src/collect.js';
import { OpsError } from '../src/errors.js';

describe('A04/A05 author index and completeness', () => {
  it.each([0, 1, 100, 101, 1205])('enumerates exactly %i target PRs without search truncation', async count => {
    const db = new Store(':memory:', 'synthetic');
    const raw = Array.from({ length: count }, (_, i) => rawPr(i + 1));
    raw.push(rawPr(9998, { repository: { nameWithOwner: 'another-org/another-repo' } }), rawPr(9999, { author: { login: 'wrong-contributor' } }));
    const api: ReadApi = { query: async <T>(_name: QueryName, vars: Record<string, string | number | null>) => {
      const start = Number(vars.cursor ?? 0); const end = Math.min(start + 100, raw.length);
      return { user: { pullRequests: { ...connection(raw.slice(start, end), end < raw.length, end < raw.length ? String(end) : null), totalCount: raw.length } } } as T;
    } };
    try {
      const result = await indexAuthor(api, config(), db, false);
      expect(result.items.map(p => p.number).sort((a, b) => a - b)).toEqual(Array.from({ length: count }, (_, i) => i + 1));
      expect(result.complete).toBe(true);
    } finally { db.close(); }
  });
  it('keeps previous successful inventory on final-page failure and resumes idempotently', async () => {
    const db = new Store(':memory:', 'synthetic'); let fail = false;
    const api: ReadApi = { query: async <T>(_name: QueryName, vars: Record<string, string | number | null>) => {
      if (vars.cursor === 'next' && fail) throw new OpsError('Synthetic permission failure', 'FAILED', 'HTTP_403');
      return { user: { pullRequests: { ...connection(vars.cursor ? [rawPr(2)] : [rawPr(1)], !vars.cursor, vars.cursor ? null : 'next'), totalCount: 2 } } } as T;
    } };
    try {
      await indexAuthor(api, config(), db, false);
      fail = true;
      await expect(indexAuthor(api, config(), db, false)).rejects.toThrow('Synthetic permission failure');
      expect(db.get<{ numbers: number[] }>('scan', 'successful-index')?.numbers).toEqual([1, 2]);
      fail = false;
      const recovered = await indexAuthor(api, config(), db, true);
      expect(recovered.items.map(p => p.number)).toEqual([1, 2]);
      expect(db.all('index')).toHaveLength(2);
    } finally { db.close(); }
  });
  it('rejects repeated cursors instead of falsely marking completeness', async () => {
    const db = new Store(':memory:', 'synthetic');
    const api: ReadApi = { query: async <T>() => ({ user: { pullRequests: { ...connection([rawPr(1)], true, 'same'), totalCount: 2 } } }) as T };
    try { await expect(indexAuthor(api, config(), db, false)).rejects.toMatchObject({ code: 'PAGINATION_STALLED' }); }
    finally { db.close(); }
  });
  it('preserves successful snapshots and exposes a later failed attempt', async () => {
    const db = new Store(':memory:', 'synthetic'); let failComments = false;
    const api: ReadApi = { query: async <T>(name: QueryName) => {
      if (name === 'meta') return { repository: { pullRequest: rawPr(1) } } as T;
      if (name === 'checks') return { repository: { object: { oid: 'a'.repeat(40), statusCheckRollup: null } } } as T;
      if (name === 'comments' && failComments) throw new OpsError('Synthetic denied comments', 'FAILED', 'HTTP_403');
      const property = name === 'threads' ? 'reviewThreads' : name === 'timeline' ? 'timelineItems' : name;
      return { repository: { pullRequest: { [property]: connection([]) } } } as T;
    } };
    try {
      const first = await collectSnapshot(api, config(), db, 1, { force: true });
      expect(first.complete).toBe(true);
      failComments = true;
      const second = await collectSnapshot(api, config(), db, 1, { force: true });
      expect(second.complete).toBe(false);
      expect(db.snapshot(1)?.complete).toBe(true);
      expect(db.get<{ gaps: string[] }>('attempt', '1')?.gaps).toContain('comments: HTTP_403');
    } finally { db.close(); }
  });
  it('moves missing objects out of the active index only after complete success', async () => {
    const db = new Store(':memory:', 'synthetic'); let count = 2;
    const api: ReadApi = { query: async <T>() => ({ user: { pullRequests: { ...connection(Array.from({ length: count }, (_, i) => rawPr(i + 1))), totalCount: count } } }) as T };
    try {
      await indexAuthor(api, config(), db, false); count = 1;
      await indexAuthor(api, config(), db, false);
      expect(db.all<{ number: number }>('index').map(item => item.number)).toEqual([1]);
      expect(db.all<{ number: number }>('index-archive').map(item => item.number)).toEqual([2]);
    } finally { db.close(); }
  });
  it('records safe attempt metadata even when initial metadata is unavailable', async () => {
    const db = new Store(':memory:', 'synthetic');
    const api: ReadApi = { query: async () => { throw new OpsError('Synthetic denial', 'FAILED', 'HTTP_403'); } };
    try {
      await expect(collectSnapshot(api, config(), db, 1)).rejects.toMatchObject({ code: 'HTTP_403' });
      expect(db.get('attempt-status', '1')).toMatchObject({ status: 'FAILED', code: 'HTTP_403' });
      expect(db.snapshot(1)).toBeUndefined();
    } finally { db.close(); }
  });
  it('reads nested thread pages and rechecks edited relationship discussions on force', async () => {
    const db = new Store(':memory:', 'synthetic'); let body = 'Original relation comment'; let relationReads = 0;
    const comment = (id: string, value: string) => ({ id, body: value, url: 'https://github.com/example-org/example-repo/pull/1#discussion_r1', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T01:00:00Z', author: { login: 'reviewer', __typename: 'User' }, authorAssociation: 'NONE' });
    const source = { id: 'related', number: 2, __typename: 'PullRequest', url: 'https://github.com/example-org/example-repo/pull/2', title: 'Related', body: '', state: 'OPEN', updatedAt: '2026-01-01T00:00:00Z', mergedAt: null, repository: { nameWithOwner: 'example-org/example-repo' } };
    const api: ReadApi = { query: async <T>(name: QueryName) => {
      if (name === 'meta') return { repository: { pullRequest: rawPr(1) } } as T;
      if (name === 'checks') return { repository: { object: { oid: 'a'.repeat(40), statusCheckRollup: null } } } as T;
      if (name === 'threads') return { repository: { pullRequest: { reviewThreads: connection([{ id: 'thread', isResolved: false, isOutdated: false, comments: connection([comment('first', 'First comment')], true, 'inner') }]) } } } as T;
      if (name === 'threadComments') return { node: { comments: connection([comment('second', 'Second comment')]) } } as T;
      if (name === 'timeline') return { repository: { pullRequest: { timelineItems: connection([{ id: 'event', __typename: 'CrossReferencedEvent', actor: { login: 'reviewer' }, createdAt: '2026-01-01T00:00:00Z', source }]) } } } as T;
      if (name === 'relation') return { repository: { issueOrPullRequest: source } } as T;
      if (name === 'relationComments') { relationReads++; return { node: { comments: connection([comment('relation-comment', body)]) } } as T; }
      const property = name === 'reviews' ? 'reviews' : name;
      return { repository: { pullRequest: { [property]: connection([]) } } } as T;
    } };
    try {
      const first = await collectSnapshot(api, config(), db, 1, { force: true });
      expect(first.feedback.map(f => f.id)).toEqual(['first', 'second']);
      body = 'Edited relation comment';
      const second = await collectSnapshot(api, config(), db, 1, { force: true });
      expect(second.relations[0].discussion[0].body).toBe('Edited relation comment');
      expect(relationReads).toBe(2);
      expect(second.version).not.toBe(first.version);
    } finally { db.close(); }
  });
});

it('refreshes edited old comments periodically and invalidates permission caches on account change', async () => {
  const db = new Store(':memory:', 'synthetic'); let body = 'Initial'; let reads = 0;
  const api: ReadApi = { query: async <T>(name: QueryName) => {
    if (name === 'meta') return { repository: { pullRequest: rawPr(1) } } as T;
    if (name === 'checks') return { repository: { object: { oid: 'a'.repeat(40), statusCheckRollup: null } } } as T;
    const property = name === 'threads' ? 'reviewThreads' : name === 'timeline' ? 'timelineItems' : name;
    if (name === 'comments') reads++;
    return { repository: { pullRequest: { [property]: connection(name === 'comments' ? [{ id: 'old', body, url: 'https://github.com/example-org/example-repo/pull/1#issuecomment-1', author: { login: 'reviewer' }, authorAssociation: 'NONE', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }] : []) } } } as T;
  } };
  try {
    const c = config(); await collectSnapshot(api, c, db, 1, { now: new Date('2026-01-01T00:00:00Z') }); body = 'Edited';
    expect((await collectSnapshot(api, c, db, 1, { now: new Date('2026-01-01T01:00:00Z') })).cached).toBe(true); expect(reads).toBe(1);
    expect((await collectSnapshot(api, c, db, 1, { now: new Date('2026-01-01T07:00:00Z') })).feedback[0]!.body).toBe('Edited'); expect(reads).toBe(2);
    c.auth.account = 'new-reader'; body = 'Different visibility';
    expect((await collectSnapshot(api, c, db, 1, { now: new Date('2026-01-01T07:01:00Z') })).feedback[0]!.body).toBe('Different visibility'); expect(reads).toBe(3);
  } finally { db.close(); }
});
it('resumes a failed final nested page and deduplicates overlapping comments', async () => {
  const db = new Store(':memory:', 'synthetic'); let fail = true; let firstReads = 0; let lastReads = 0;
  const comment = (id: string) => ({ id, body: 'Synthetic', url: 'https://github.com/example-org/example-repo/pull/1#issuecomment-1', author: { login: 'reviewer' }, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' });
  const api: ReadApi = { query: async <T>(name: QueryName, vars: Record<string, string | number | null>) => {
    if (name === 'meta') return { repository: { pullRequest: rawPr(1) } } as T;
    if (name === 'checks') return { repository: { object: { oid: 'a'.repeat(40), statusCheckRollup: null } } } as T;
    if (name === 'comments') {
      if (!vars.cursor) { firstReads++; return { repository: { pullRequest: { comments: connection([comment('a')], true, 'next') } } } as T; }
      lastReads++; if (fail) throw new OpsError('Synthetic final page unavailable', 'PARTIAL', 'PAGE_UNAVAILABLE');
      return { repository: { pullRequest: { comments: connection([comment('a'), comment('b')]) } } } as T;
    }
    const property = name === 'threads' ? 'reviewThreads' : name === 'timeline' ? 'timelineItems' : name;
    return { repository: { pullRequest: { [property]: connection([]) } } } as T;
  } };
  try {
    expect((await collectSnapshot(api, config(), db, 1)).complete).toBe(false); fail = false;
    const recovered = await collectSnapshot(api, config(), db, 1); expect(recovered.complete).toBe(true); expect(recovered.feedback.map(f => f.id)).toEqual(['a', 'b']);
    expect(firstReads).toBe(1); expect(lastReads).toBe(2);
  } finally { db.close(); }
});
it('filters interfering repository/author objects while validating full source enumeration', async () => {
  const db = new Store(':memory:', 'synthetic');
  const api: ReadApi = { query: async <T>() => ({ user: { pullRequests: { ...connection([rawPr(1), rawPr(2, { repository: { nameWithOwner: 'other-org/other-repo' } }), rawPr(3, { author: { login: 'other-author' } })]), totalCount: 3 } } }) as T };
  try { const result = await indexAuthor(api, config(), db, false); expect(result.items.map(pr => pr.number)).toEqual([1]); expect(result.complete).toBe(true); }
  finally { db.close(); }
});

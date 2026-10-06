import { it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { config, rawPr, connection } from './helpers.js';
import { synchronize } from '../src/sync.js';
import { Store } from '../src/store.js';
import type { QueryName } from '../src/queries.js';
import { OpsError } from '../src/errors.js';
import { snapshot, pr } from './helpers.js';
import { localView, markdown } from '../src/views.js';
import type { SyncProgress } from '../src/progress.js';

it.each([
  { openOnly: undefined, limit: undefined, scope: 'OPEN_PRS', analysis: 'NOT_REQUESTED' },
  { openOnly: false, limit: undefined, scope: 'ALL_PRS', analysis: 'REQUESTED' },
  { openOnly: false, limit: 1, scope: 'OPEN_PRS', analysis: 'NOT_REQUESTED' },
])('preserves the requested scope after network failure: $scope/$analysis', async ({ openOnly, limit, scope, analysis }) => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-ops-failed-scope-'));
  const c = config(); c.storage.directory = dir;
  const db = new Store(':memory:', c.scope);
  const saved = snapshot({ pr: pr(1), authAccount: c.auth.account });
  db.saveSnapshot(saved);
  const client = { refreshQuota: async () => { throw new OpsError('Synthetic network failure', 'FAILED', 'NETWORK_UNAVAILABLE'); }, viewer: async () => ({ login: c.auth.account, id: 1 }), counts: () => ({ core: 3 }), query: async <T>() => ({} as T) };
  try {
    await expect(synchronize(c, db, { resume: true, openOnly, limit }, client)).rejects.toMatchObject({ code: 'NETWORK_UNAVAILABLE' });
    expect(db.get('sync', 'last')).toMatchObject({ status: 'FAILED', scope, contributionAnalysis: analysis, limited: !!limit, requests: { core: 3 } });
    expect(db.snapshot(1)).toEqual(saved);
    if (scope === 'OPEN_PRS') {
      const report = markdown(localView(c, db));
      expect(report).toContain('# 开放 PR 维护报告');
      expect(report).not.toContain('已关闭');
    }
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

it('collects only ordinary open PRs including drafts when resuming an all-history checkpoint', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-ops-open-sync-'));
  const c = config(); c.storage.directory = dir; c.maintenance.excluded_prs = [5];
  const db = new Store(':memory:', c.scope);
  const items = [rawPr(1), { ...rawPr(2), isDraft: true }, { ...rawPr(3), state: 'CLOSED' }, { ...rawPr(4), state: 'MERGED' }, rawPr(5)];
  const visited: number[] = [];
  db.set('sync', 'checkpoint', { remaining: [1, 2, 3, 4, 5], auth: c.auth.account, complete: false });
  // Previously completed evidence outside the checkpoint must still be
  // collected when stale, bound to another account, or followed by a failure.
  for (const number of [6, 7, 8]) {
    items.push(rawPr(number));
    db.saveSnapshot(snapshot({ pr: pr(number), observedAt: new Date(number === 6 ? Date.now() - 25 * 3600000 : Date.now()).toISOString(), authAccount: number === 7 ? 'another-reader' : c.auth.account }));
  }
  items.push(rawPr(9));
  db.saveSnapshot(snapshot({ pr: pr(9), observedAt: new Date(Date.now() - 23 * 3600000).toISOString(), authAccount: c.auth.account }));
  db.set('attempt-status', '8', { status: 'FAILED', code: 'HTTP_403' });
  const client = { refreshQuota: async () => {}, viewer: async () => ({ login: c.auth.account, id: 1 }), counts: () => ({ synthetic: visited.length }), query: async <T>(name: QueryName, vars: Record<string, string | number | null>) => {
    if ((name === 'index' || name === 'indexOpen')) return { user: { pullRequests: { ...connection(items), totalCount: items.length } } } as T;
    if (name === 'meta') { visited.push(Number(vars.number)); return { repository: { pullRequest: items.find(pr => pr.number === vars.number) } } as T; }
    if (name === 'checks') return { repository: { object: { oid: 'a'.repeat(40), statusCheckRollup: null } } } as T;
    const property = name === 'threads' ? 'reviewThreads' : name === 'timeline' ? 'timelineItems' : name;
    return { repository: { pullRequest: { [property]: connection([]) } } } as T;
  } };
  try {
    const events: SyncProgress[] = [];
    const result = await synchronize(c, db, { resume: true, onProgress: e => events.push(e) }, client);
    expect([...new Set(visited)]).toEqual([1, 2, 6, 7, 8]);
    expect(result).toMatchObject({ status: 'SUCCESS', scope: 'OPEN_PRS', contributionAnalysis: 'NOT_REQUESTED', remaining: [] });
    expect(db.all('snapshot')).toHaveLength(6);
    expect(db.get('git', 'history')).toBeUndefined();
    expect(events.map(e => e.stage)).toContain('authentication');
    expect(events.map(e => e.stage)).toContain('index');
    expect(events.some(e => e.currentPr === 1)).toBe(true);
    expect(events.at(-1)).toMatchObject({ stage: 'complete', processed: 5, total: 5, successful: 5, remaining: 0, outcome: 'SUCCESS' });
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

it('resumes completed pilots by collecting newly indexed and previously unselected PRs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-ops-sync-')); const c = config(); c.storage.directory = dir;
  const db = new Store(':memory:', c.scope); let count = 1; let denyCommits = false; const visited: number[] = [];
  const client = { refreshQuota: async () => {}, viewer: async () => ({ login: c.auth.account, id: 1 }), counts: () => ({ synthetic: visited.length }), query: async <T>(name: QueryName, vars: Record<string, string | number | null>) => {
    if ((name === 'index' || name === 'indexOpen')) return { user: { pullRequests: { ...connection(Array.from({ length: count }, (_, i) => rawPr(i + 1))), totalCount: count } } } as T;
    if (name === 'meta') { visited.push(Number(vars.number)); return { repository: { pullRequest: rawPr(Number(vars.number)) } } as T; }
    if (name === 'checks') return { repository: { object: { oid: 'a'.repeat(40), statusCheckRollup: null } } } as T;
    if (name === 'commits' && denyCommits) throw new OpsError('Synthetic unavailable source commits', 'PARTIAL', 'DATA_MISSING');
    const property = name === 'threads' ? 'reviewThreads' : name === 'timeline' ? 'timelineItems' : name;
    return { repository: { pullRequest: { [property]: connection([]) } } } as T;
  } };
  try {
    await synchronize(c, db, { resume: false, limit: 1 }, client); expect(db.get('sync', 'checkpoint')).toMatchObject({ complete: true }); count = 2;
    await synchronize(c, db, { resume: true, limit: 2 }, client); expect(visited).toContain(2);
    count = 3; denyCommits = true; visited.length = 0;
    const result = await synchronize(c, db, { resume: true, openOnly: false }, client); expect(visited).toContain(3); expect(result.status).toBe('PARTIAL');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

it('shares a successful related object through the actual synchronization loop', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pr-ops-relation-round-')); const c = config(); c.storage.directory = root;
  const db = new Store(':memory:', c.scope); let relatedReads = 0, discussionReads = 0;
  const source = { id: 'shared', number: 99, __typename: 'Issue', url: 'https://github.com/example-org/example-repo/issues/99', title: 'Shared', body: '', state: 'OPEN', updatedAt: '2026-01-01T00:00:00Z', repository: { nameWithOwner: 'example-org/example-repo' } };
  const client = { refreshQuota: async () => {}, viewer: async () => ({ login: c.auth.account, id: 1 }), counts: () => ({ relation: relatedReads, relationComments: discussionReads }), query: async <T>(name: QueryName, vars: Record<string, string | number | null>) => {
    if ((name === 'index' || name === 'indexOpen')) return { user: { pullRequests: { ...connection([rawPr(1), rawPr(2)]), totalCount: 2 } } } as T;
    if (name === 'meta') return { repository: { pullRequest: rawPr(Number(vars.number)) } } as T;
    if (name === 'checks') return { repository: { object: { oid: 'a'.repeat(40), statusCheckRollup: null } } } as T;
    if (name === 'timeline') return { repository: { pullRequest: { timelineItems: connection([{ id: 'event-' + vars.number, __typename: 'CrossReferencedEvent', actor: { login: 'actor-' + vars.number }, createdAt: source.updatedAt, source }]) } } } as T;
    if (name === 'relation') { relatedReads++; return { repository: { issueOrPullRequest: source } } as T; }
    if (name === 'relationComments') { discussionReads++; return { node: { comments: connection([]) } } as T; }
    return { repository: { pullRequest: { [name === 'threads' ? 'reviewThreads' : name]: connection([]) } } } as T;
  } };
  try {
    const result = await synchronize(c, db, { resume: false }, client);
    expect(result.status).toBe('SUCCESS'); expect(result.requests).toEqual({ relation: 1, relationComments: 1 });
    expect(db.snapshot(2)!.relations[0].actor).toBe('actor-2');
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

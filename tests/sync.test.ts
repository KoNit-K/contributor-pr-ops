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
    db.saveSnapshot(snapshot({ pr: pr(number), observedAt: new Date(number === 6 ? Date.now() - 7 * 3600000 : Date.now()).toISOString(), authAccount: number === 7 ? 'another-reader' : c.auth.account }));
  }
  db.set('attempt-status', '8', { status: 'FAILED', code: 'HTTP_403' });
  const client = { refreshQuota: async () => {}, viewer: async () => ({ login: c.auth.account, id: 1 }), counts: () => ({ synthetic: visited.length }), query: async <T>(name: QueryName, vars: Record<string, string | number | null>) => {
    if (name === 'index') return { user: { pullRequests: { ...connection(items), totalCount: items.length } } } as T;
    if (name === 'meta') { visited.push(Number(vars.number)); return { repository: { pullRequest: items.find(pr => pr.number === vars.number) } } as T; }
    if (name === 'checks') return { repository: { object: { oid: 'a'.repeat(40), statusCheckRollup: null } } } as T;
    const property = name === 'threads' ? 'reviewThreads' : name === 'timeline' ? 'timelineItems' : name;
    return { repository: { pullRequest: { [property]: connection([]) } } } as T;
  } };
  try {
    const result = await synchronize(c, db, { resume: true }, client);
    expect([...new Set(visited)]).toEqual([1, 2, 6, 7, 8]);
    expect(result).toMatchObject({ status: 'SUCCESS', scope: 'OPEN_PRS', contributionAnalysis: 'NOT_REQUESTED', remaining: [] });
    expect(db.all('snapshot')).toHaveLength(5);
    expect(db.get('git', 'history')).toBeUndefined();
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

it('resumes completed pilots by collecting newly indexed and previously unselected PRs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-ops-sync-')); const c = config(); c.storage.directory = dir;
  const db = new Store(':memory:', c.scope); let count = 1; let denyCommits = false; const visited: number[] = [];
  const client = { refreshQuota: async () => {}, viewer: async () => ({ login: c.auth.account, id: 1 }), counts: () => ({ synthetic: visited.length }), query: async <T>(name: QueryName, vars: Record<string, string | number | null>) => {
    if (name === 'index') return { user: { pullRequests: { ...connection(Array.from({ length: count }, (_, i) => rawPr(i + 1))), totalCount: count } } } as T;
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

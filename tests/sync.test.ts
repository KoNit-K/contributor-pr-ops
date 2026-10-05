import { it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { config, rawPr, connection } from './helpers.js';
import { synchronize } from '../src/sync.js';
import { Store } from '../src/store.js';
import type { QueryName } from '../src/queries.js';
import { OpsError } from '../src/errors.js';

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
    const result = await synchronize(c, db, { resume: true }, client); expect(visited).toContain(3); expect(result.status).toBe('PARTIAL');
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

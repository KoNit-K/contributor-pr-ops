import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config.js';
import { Store, acquireLock } from './store.js';
import { RateGate, systemClock, type WindowStorage } from './rate.js';
import { GithubClient, authentication, octokitTransport } from './github.js';
import { OpsError, safeError } from './errors.js';
import { indexAuthor, collectSnapshot } from './collect.js';
import { analyzeHistory, fetchBare, gitRead, recordLedger } from './git.js';
import type { PrIndex, Snapshot } from './model.js';

export function clientFor(config: Config, db: Store): GithubClient {
  const windows: WindowStorage = { get: key => db.getWindow(key), set: (key, state) => db.setWindow(key, state) };
  return new GithubClient(octokitTransport(authentication(config)), new RateGate(config.rate_limit, systemClock, windows, config.auth.account), systemClock, config.rate_limit, windows, config.auth.account);
}
export async function checkOnline(client: Pick<GithubClient, 'refreshQuota' | 'viewer'>, config: Config) {
  await client.refreshQuota(); const viewer = await client.viewer();
  if (viewer.login.toLowerCase() !== config.auth.account.toLowerCase()) throw new OpsError('Authenticated account differs from configuration.', 'FAILED', 'ACCOUNT_MISMATCH');
  return { account: viewer.login, id: viewer.id };
}
export async function synchronize(config: Config, db: Store, options: { resume: boolean; limit?: number }, injectedClient?: Pick<GithubClient, 'query' | 'refreshQuota' | 'viewer' | 'counts'>) {
  const unlock = acquireLock(config.storage.directory);
  let client: Pick<GithubClient, 'query' | 'refreshQuota' | 'viewer' | 'counts'> | undefined;
  try {
    client = injectedClient ?? clientFor(config, db); const viewer = await checkOnline(client, config);
    db.set('auth', 'viewer', { ...viewer, observedAt: new Date().toISOString() });
    const index = await indexAuthor(client, config, db, options.resume);
    const ordinary = (pr: PrIndex) => pr.state === 'OPEN' && !config.maintenance.excluded_prs.includes(pr.number) && !pr.labels.some(label => config.maintenance.excluded_labels.includes(label));
    const candidates = options.limit ? index.items.filter(ordinary).slice(0, options.limit) : index.items;
    const checkpoint = db.get<{ remaining: number[]; auth: string; complete?: boolean }>('sync', 'checkpoint');
    const remaining = options.resume && checkpoint?.auth === config.auth.account && !checkpoint.complete
      ? [...new Set([...checkpoint.remaining.filter(number => candidates.some(pr => pr.number === number)), ...candidates.filter(pr => !db.snapshot(pr.number)?.complete || db.snapshot(pr.number)?.pr.head !== pr.head || db.snapshot(pr.number)?.pr.updatedAt !== pr.updatedAt).map(pr => pr.number)])]
      : candidates.map(pr => pr.number);
    db.set('sync', 'checkpoint', { remaining, auth: config.auth.account, complete: remaining.length === 0 });
    const gaps: string[] = [];
    for (const number of [...remaining]) {
      const snapshot = await collectSnapshot(client, config, db, number);
      if (!snapshot.complete) gaps.push(`PR ${number}: ${snapshot.gaps.join('; ')}`);
      else remaining.splice(remaining.indexOf(number), 1);
      db.set('sync', 'checkpoint', { remaining, auth: config.auth.account, complete: remaining.length === 0 });
    }
    if (!options.limit && !gaps.length) {
      const missing = index.items.filter(pr => { const s = db.snapshot(pr.number); return !s?.complete || s.authAccount !== config.auth.account || s.pr.head !== pr.head || s.pr.updatedAt !== pr.updatedAt; });
      if (missing.length) throw new OpsError('Indexed PR evidence is incomplete or stale; contribution analysis is deferred.', 'PARTIAL', 'CONTRIBUTION_SOURCE_INCOMPLETE');
      const sourceMap = Object.fromEntries(index.items.map(pr => [String(pr.number), db.snapshot(pr.number)?.commits.map(commit => commit.sha) ?? []]));
      const controlled = join(config.storage.directory, config.scope, 'git.git');
      let path = config.git.checkout_path;
      let head: string;
      if (path) head = gitRead(path, ['rev-parse', '--verify', `refs/heads/${config.target.branch}^{commit}`]);
      else { mkdirSync(controlled, { recursive: true, mode: 0o700 }); path = controlled; head = fetchBare(path, config.target.repository, config.target.branch, index.items.map(pr => pr.number)); }
      const attributed = db.all<Snapshot>('snapshot').flatMap(s => s.commits.filter(commit => commit.authorLogin?.toLowerCase() === config.target.author.toLowerCase()).map(commit => commit.authorEmail));
      const emails = [...new Set([...config.attribution.verified_author_emails, ...attributed])];
      const history = analyzeHistory(path, head, emails, index.items, sourceMap, config.target.branch, db);
      recordLedger(db, history, new Date().toISOString(), config.reporting.timezone);
      if (!history.complete) gaps.push(...history.gaps);
      else db.remove('git', 'attempt');
    }
    const result = { status: options.limit || gaps.length ? 'PARTIAL' as const : 'SUCCESS' as const, observedAt: new Date().toISOString(), limited: !!options.limit, gaps, requests: client.counts(), remaining };
    db.set('sync', 'last', result); return result;
  } catch (error) { db.set('sync', 'last', { ...safeError(error), observedAt: new Date().toISOString(), requests: client?.counts() ?? {} }); throw error; }
  finally { unlock(); }
}

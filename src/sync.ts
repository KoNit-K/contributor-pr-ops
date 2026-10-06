import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config.js';
import { Store, acquireLock } from './store.js';
import { RateGate, systemClock, type WindowStorage } from './rate.js';
import { GithubClient, authentication, octokitTransport, type ClientActivity } from './github.js';
import { OpsError, safeError } from './errors.js';
import { indexAuthor, collectSnapshot, createCollectionRound } from './collect.js';
import { analyzeHistory, fetchBare, gitRead, recordLedger } from './git.js';
import { EVIDENCE_CACHE_TTL_MS, fingerprint, type PrIndex, type Snapshot } from './model.js';

import type { SyncProgress } from './progress.js';
type SyncClient = Pick<GithubClient, 'query' | 'refreshQuota' | 'viewer' | 'counts'> & Partial<Pick<GithubClient, 'timings' | 'budgets' | 'confirmIdentity'>>;

export function clientFor(config: Config, db: Store, onActivity?: (activity: ClientActivity) => void): GithubClient {
  let verified = false;
  const pending = new Map<string, import('./rate.js').BucketState>();
  // Before /user confirms the identity, keep shared waits and unverified reservations.
  // Primary budgets stay in persistent, explicitly unverified staging until matched.
  // Unknown bootstrap charges are retained conservatively across credential changes.
  const bootstrapWaitKey = '@unverified-reader:pacing';
  const windows: WindowStorage = {
    get: key => {
      const state = pending.get(key) ?? (!verified ? db.getWindow<import('./rate.js').BucketState>(`@unverified-reader:${key}`) : undefined) ?? db.getWindow<import('./rate.js').BucketState>(key);
      if (!key.endsWith(':pacing')) return state;
      const wait = db.getWindow<import('./rate.js').BucketState>(bootstrapWaitKey);
      if (!wait || wait.nextAt <= (state?.nextAt ?? 0)) return state;
      return { ...(state ?? wait), nextAt: wait.nextAt };
    },
    set: (key, state) => {
      if (verified) db.setWindow(key, state);
      else {
        pending.set(key, state);
        db.setWindow(`@unverified-reader:${key}`, state);
        if (key.endsWith(':pacing')) db.setWindow(bootstrapWaitKey, state);
      }
    },
  };
  const confirm = () => { db.atomic(() => { for (const [key, state] of pending) { db.setWindow(key, state); db.removeWindow(`@unverified-reader:${key}`); } }); pending.clear(); verified = true; };
  return new GithubClient(octokitTransport(authentication(config)), new RateGate(config.rate_limit, systemClock, windows, config.auth.account), systemClock, config.rate_limit, windows, config.auth.account, onActivity, confirm);
}
export async function checkOnline(client: Pick<GithubClient, 'refreshQuota' | 'viewer'> & Partial<Pick<GithubClient, 'confirmIdentity'>>, config: Config) {
  await client.refreshQuota(); const viewer = await client.viewer();
  if (viewer.login.toLowerCase() !== config.auth.account.toLowerCase()) throw new OpsError('Authenticated account differs from configuration.', 'FAILED', 'ACCOUNT_MISMATCH');
  client.confirmIdentity?.(viewer.login);
  return { account: viewer.login, id: viewer.id };
}
export async function synchronize(config: Config, db: Store, options: { resume: boolean; limit?: number; openOnly?: boolean; onProgress?: (progress: SyncProgress) => void }, injectedClient?: SyncClient) {
  const unlock = acquireLock(config.storage.directory);
  const openOnly = options.openOnly !== false;
  const requestedScope = { scope: openOnly || options.limit ? 'OPEN_PRS' : 'ALL_PRS', contributionAnalysis: openOnly || options.limit ? 'NOT_REQUESTED' : 'REQUESTED', limited: !!options.limit };
  let client: SyncClient | undefined;
  const started = Date.now();
  let state: SyncProgress = { stage: 'authentication', processed: 0, total: 0, successful: 0, cached: 0, remaining: 0, scopeTotal: 0, elapsedMs: 0 };
  const finalActivity = () => state.activity ? { ...state.activity, phase: 'idle' as const, waitMs: undefined, timings: client?.timings?.() ?? state.activity.timings } : undefined;
  const progress = (update: Partial<SyncProgress> = {}) => { state = { ...state, ...update, elapsedMs: Date.now() - started }; options.onProgress?.({ ...state }); };
  try {
    progress();
    client = injectedClient ?? clientFor(config, db, activity => progress({ activity })); const viewer = await checkOnline(client, config);
    db.set('auth', 'viewer', { ...viewer, observedAt: new Date().toISOString() });
    progress({ stage: 'index' });
    const index = await indexAuthor(client, config, db, options.resume);
    const ordinary = (pr: PrIndex) => pr.state === 'OPEN' && !config.maintenance.excluded_prs.includes(pr.number) && !pr.labels.some(label => config.maintenance.excluded_labels.includes(label));
    const candidates = options.limit ? index.items.filter(ordinary).slice(0, options.limit) : openOnly ? index.items.filter(ordinary) : index.items;
    const checkpoint = db.get<{ remaining: number[]; auth: string; complete?: boolean }>('sync', 'checkpoint');
    const needsCollection = (pr: PrIndex) => {
      const snapshot = db.snapshot(pr.number);
      const attempt = db.get<{ status: string }>('attempt-status', String(pr.number));
      const age = Date.now() - Date.parse(snapshot?.contentCheckedAt ?? snapshot?.observedAt ?? '');
      return !snapshot?.complete || snapshot.authAccount !== config.auth.account || fingerprint(snapshot.pr) !== fingerprint(pr)
        || !Number.isFinite(age) || age >= EVIDENCE_CACHE_TTL_MS || !!attempt && attempt.status !== 'SUCCESS';
    };
    const remaining = options.resume && checkpoint?.auth === config.auth.account && !checkpoint.complete
      ? [...new Set([...checkpoint.remaining.filter(number => candidates.some(pr => pr.number === number)), ...candidates.filter(needsCollection).map(pr => pr.number)])]
      : candidates.map(pr => pr.number);
    db.set('sync', 'checkpoint', { remaining, auth: config.auth.account, complete: remaining.length === 0 });
    progress({ stage: 'collect', total: remaining.length, scopeTotal: candidates.length, remaining: remaining.length });
    const gaps: string[] = [];
    const round = createCollectionRound();
    for (const number of [...remaining]) {
      progress({ currentPr: number });
      const snapshot = await collectSnapshot(client, config, db, number, { round });
      if (!snapshot.complete) gaps.push(`PR ${number}: ${snapshot.gaps.join('; ')}`);
      else remaining.splice(remaining.indexOf(number), 1);
      db.set('sync', 'checkpoint', { remaining, auth: config.auth.account, complete: remaining.length === 0 });
      progress({ processed: state.processed + 1, successful: state.successful + Number(snapshot.complete), cached: state.cached + Number(!!snapshot.cached), remaining: remaining.length, currentPr: undefined });
    }
    if (!options.limit && !openOnly && !gaps.length) {
      progress({ stage: 'history' });
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
    const result = { status: options.limit || gaps.length ? 'PARTIAL' as const : 'SUCCESS' as const, observedAt: new Date().toISOString(), ...requestedScope, reader: viewer, targetAuthor: config.target.author, budgets: client.budgets?.(), gaps, requests: client.counts(), timings: client.timings?.(), remaining };
    db.set('sync', 'last', result); progress({ stage: 'complete', outcome: result.status, activity: finalActivity() }); return result;
  } catch (error) { db.set('sync', 'last', { ...safeError(error), observedAt: new Date().toISOString(), ...requestedScope, reader: { account: config.auth.account }, targetAuthor: config.target.author, budgets: client?.budgets?.(), requests: client?.counts() ?? {}, timings: client?.timings?.() }); progress({ stage: 'complete', outcome: safeError(error).status, activity: finalActivity() }); throw error; }
  finally { unlock(); }
}

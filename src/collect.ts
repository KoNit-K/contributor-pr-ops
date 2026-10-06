import type { Config } from './config.js';
import { OpsError, safeError } from './errors.js';
import type { QueryName } from './queries.js';
import { Store } from './store.js';
import { EVIDENCE_CACHE_TTL_MS, fingerprint, snapshotVersion, type PrIndex, type Feedback, type Relation, type Snapshot, type SourceCommit, type CheckFact } from './model.js';

export interface CollectionRound {
  now: () => number;
  relations: Map<string, { value: Relation; checkedAt: number; discussionRefreshed: boolean }>;
}
export function createCollectionRound(now = Date.now): CollectionRound { return { now, relations: new Map() }; }
const RELATION_REUSE_MS = 60000;
export interface ReadApi { query<T>(name: QueryName, variables: Record<string, string | number | null>): Promise<T> }
type ObjectData = Record<string, unknown>;
function object(value: unknown): ObjectData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OpsError('Required GitHub object is unavailable.', 'PARTIAL', 'DATA_MISSING');
  return value as ObjectData;
}
const optional = (value: unknown): ObjectData => value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectData : {};
function text(value: unknown): string { if (typeof value !== 'string') throw new OpsError('Required GitHub field is unavailable.', 'PARTIAL', 'DATA_MISSING'); return value; }
const nullable = (value: unknown): string | null => typeof value === 'string' ? value : null;
function nodes(value: unknown): ObjectData[] { if (!Array.isArray(value) || value.some(v => !v || typeof v !== 'object')) throw new OpsError('GitHub connection returned missing nodes.', 'PARTIAL', 'DATA_MISSING'); return value as ObjectData[]; }
const rootPr = (data: unknown) => object(object(object(data).repository).pullRequest);
const targetVars = (config: Config, number: number): Record<string, string | number | null> => { const [owner, repo] = config.target.repository.split('/'); return { owner, repo, number }; };

export function normalizePr(data: ObjectData): PrIndex {
  const labels = object(data.labels);
  const state = text(data.state);
  if (!['OPEN', 'CLOSED', 'MERGED'].includes(state) || !Number.isInteger(data.number) || Number(data.number) <= 0) throw new OpsError('Invalid PR identity or lifecycle.', 'PARTIAL', 'DATA_INVALID');
  return {
    id: text(data.id), number: Number(data.number), repository: text(object(data.repository).nameWithOwner), author: text(object(data.author).login),
    title: text(data.title), body: text(data.body), url: text(data.url), state: state as PrIndex['state'], draft: data.isDraft === true,
    head: text(data.headRefOid), base: text(data.baseRefName), createdAt: text(data.createdAt), updatedAt: text(data.updatedAt),
    mergedAt: nullable(data.mergedAt), mergeCommit: nullable(optional(data.mergeCommit).oid),
    mergeable: data.mergeable === 'CONFLICTING' ? 'CONFLICTING' : data.mergeable === 'MERGEABLE' ? 'MERGEABLE' : 'UNKNOWN',
    labels: nodes(labels.nodes).map(label => text(label.name)),
  };
}

interface IndexProgress { cursor: string | null; cursors: string[]; sourceIds: string[]; sourceTotals: number[]; numbers: number[]; startedAt: string; auth: string; complete: boolean; lastAttemptedAt: string; error?: string }
export async function indexAuthor(api: ReadApi, config: Config, db: Store, resume: boolean): Promise<{ items: PrIndex[]; complete: boolean; observedAt: string; sourceTotals: number[] }> {
  let progress = resume ? db.get<IndexProgress>('scan', 'index-progress') : undefined;
  if (!progress || progress.complete || progress.error === 'INDEX_CHANGED_DURING_SCAN' || progress.auth !== config.auth.account) {
    for (const value of db.all<PrIndex>('index-work')) db.remove('index-work', String(value.number));
    progress = { cursor: null, cursors: [], sourceIds: [], sourceTotals: [], numbers: [], startedAt: new Date().toISOString(), auth: config.auth.account, complete: false, lastAttemptedAt: new Date().toISOString() };
  }
  const ids = new Set(progress.sourceIds);
  const numbers = new Set(progress.numbers);
  try {
    for (;;) {
      const data = await api.query<unknown>('index', { author: config.target.author, cursor: progress.cursor });
      const connection = object(object(object(data).user).pullRequests);
      const info = object(connection.pageInfo);
      const items = nodes(connection.nodes);
      const total = Number(connection.totalCount);
      if (!Number.isSafeInteger(total) || total < 0 || typeof info.hasNextPage !== 'boolean') throw new OpsError('Index coverage metadata is unavailable.', 'PARTIAL', 'DATA_MISSING');
      progress.sourceTotals.push(total);
      for (const item of items) {
        ids.add(text(item.id));
        if (optional(item.repository).nameWithOwner?.toString().toLowerCase() !== config.target.repository.toLowerCase() || optional(item.author).login?.toString().toLowerCase() !== config.target.author.toLowerCase()) continue;
        const pr = normalizePr(item); numbers.add(pr.number); db.set('index-work', String(pr.number), pr);
      }
      const cursor = nullable(info.endCursor);
      if (info.hasNextPage && (!cursor || progress.cursors.includes(cursor) || items.length === 0)) throw new OpsError('Pagination cursor stalled; index remains incomplete.', 'PARTIAL', 'PAGINATION_STALLED');
      if (cursor) progress.cursors.push(cursor);
      progress.cursor = cursor; progress.sourceIds = [...ids]; progress.numbers = [...numbers]; progress.lastAttemptedAt = new Date().toISOString();
      db.set('scan', 'index-progress', progress);
      if (!info.hasNextPage) {
        const changing = new Set(progress.sourceTotals).size > 1;
        if (changing) throw new OpsError('Author index changed during pagination; restart enumeration to establish complete coverage.', 'PARTIAL', 'INDEX_CHANGED_DURING_SCAN');
        if (!changing && ids.size !== total) throw new OpsError('Static source count does not match enumerated unique objects.', 'PARTIAL', 'INDEX_COUNT_MISMATCH');
        progress.complete = true;
        delete progress.error;
        db.atomic(() => {
          for (const previous of db.all<PrIndex>('index')) {
            if (!numbers.has(previous.number)) {
              db.set('index-archive', String(previous.number), previous);
              db.remove('index', String(previous.number));
            }
          }
          for (const number of numbers) db.set('index', String(number), db.get('index-work', String(number)));
          db.set('scan', 'index-progress', progress);
          db.set('scan', 'successful-index', { numbers: [...numbers], startedAt: progress!.startedAt, observedAt: progress!.lastAttemptedAt, sourceTotals: progress!.sourceTotals, changing });
        });
        return { items: [...numbers].map(number => db.get<PrIndex>('index', String(number))!), complete: true, observedAt: progress.lastAttemptedAt, sourceTotals: progress.sourceTotals };
      }
    }
  } catch (error) {
    progress.error = safeError(error).code; progress.lastAttemptedAt = new Date().toISOString(); db.set('scan', 'index-progress', progress); throw error;
  }
}

interface PageCheckpoint { signature: string; cursor: string | null; cursors: string[]; items: ObjectData[] }
async function readPages(api: ReadApi, db: Store, key: string, signature: string, operation: QueryName, vars: Record<string, string | number | null>, select: (data: unknown) => unknown, initial?: unknown): Promise<ObjectData[]> {
  let checkpoint = db.get<PageCheckpoint>('pages', key);
  if (!checkpoint || checkpoint.signature !== signature) checkpoint = { signature, cursor: null, cursors: [], items: [] };
  const unique = new Map(checkpoint.items.map(item => [text(item.id ?? optional(item.commit).oid ?? item.name), item]));
  let seed = checkpoint.cursor ? undefined : initial;
  for (;;) {
    const page = object(seed ?? select(await api.query(operation, { ...vars, cursor: checkpoint.cursor })));
    seed = undefined;
    const info = object(page.pageInfo);
    const values = nodes(page.nodes);
    if (typeof info.hasNextPage !== 'boolean') throw new OpsError('Connection coverage is unavailable.', 'PARTIAL', 'DATA_MISSING');
    for (const item of values) unique.set(text(item.id ?? optional(item.commit).oid ?? item.name), item);
    const cursor = nullable(info.endCursor);
    if (info.hasNextPage && (!cursor || checkpoint.cursors.includes(cursor) || values.length === 0)) throw new OpsError('Nested pagination cursor stalled.', 'PARTIAL', 'PAGINATION_STALLED');
    if (!info.hasNextPage) { db.remove('pages', key); return [...unique.values()]; }
    checkpoint = { signature, cursor, cursors: [...checkpoint.cursors, cursor!], items: [...unique.values()] };
    db.set('pages', key, checkpoint);
  }
}

function normalizeFeedback(item: ObjectData, kind: Feedback['kind'], thread?: ObjectData): Feedback {
  const author = optional(item.author);
  return {
    id: text(item.id), kind, author: nullable(author.login), bot: author.__typename === 'Bot', association: nullable(item.authorAssociation) ?? 'UNKNOWN',
    body: text(item.body), url: text(item.url), createdAt: text(item.createdAt), updatedAt: text(item.updatedAt),
    threadId: thread ? text(thread.id) : null, resolved: thread?.isResolved === true, outdated: thread?.isOutdated === true || item.outdated === true,
    reviewState: nullable(item.state), commit: nullable(optional(item.commit ?? item.originalCommit).oid), replyTo: nullable(optional(item.replyTo).id),
  };
}

async function refreshRelations(api: ReadApi, db: Store, relations: Relation[], signature: string, force: boolean, config: Config, round?: CollectionRound): Promise<Relation[]> {
  const result: Relation[] = [];
  for (const relation of relations) {
    const key = JSON.stringify([config.scope, config.auth.account.toLowerCase(), relation.repository.toLowerCase(), relation.kind, relation.number, relation.id]);
    const shared = round?.relations.get(key);
    const age = shared && round ? round.now() - shared.checkedAt : Infinity;
    if (shared && age >= 0 && age < RELATION_REUSE_MS && (!force || shared.discussionRefreshed) && Date.parse(relation.updatedAt) <= Date.parse(shared.value.updatedAt)) {
      result.push({ ...structuredClone(shared.value), actor: relation.actor, referencedAt: relation.referencedAt });
      continue;
    }
    const [owner, repo] = relation.repository.split('/');
    const data = object(await api.query('relation', { owner, repo, number: relation.number }));
    const source = object(object(data.repository).issueOrPullRequest);
    if (source.id !== relation.id) throw new OpsError('Related object identity changed.', 'PARTIAL', 'RELATION_IDENTITY');
    const changed = force || source.updatedAt !== relation.updatedAt || !relation.complete;
    const discussion = changed ? (await readPages(api, db, `relation:${relation.id}`, signature + String(source.updatedAt), 'relationComments', { id: relation.id }, value => object(object(value).node).comments)).map(item => normalizeFeedback(item, 'COMMENT')) : relation.discussion;
    const refreshed = { ...relation, updatedAt: text(source.updatedAt), state: text(source.state), mergedAt: nullable(source.mergedAt), title: text(source.title), body: text(source.body), discussion, complete: true };
    result.push(refreshed);
    // Publish only after all discussion pages succeeded; never share partial data.
    round?.relations.set(key, { value: structuredClone(refreshed), checkedAt: round.now(), discussionRefreshed: changed });
  }
  return result;
}

export async function collectSnapshot(api: ReadApi, config: Config, db: Store, number: number, options: { force?: boolean; now?: Date; round?: CollectionRound } = {}): Promise<Snapshot> {
  const key = String(number);
  const attemptedAt = (options.now ?? new Date()).toISOString();
  db.set('attempt-status', key, { status: 'RUNNING', attemptedAt });
  try {
    const result = await collectSnapshotData(api, config, db, number, options);
    db.set('attempt-status', key, { status: result.complete ? 'SUCCESS' : 'PARTIAL', attemptedAt, gaps: result.gaps });
    return result;
  } catch (error) {
    const failure = safeError(error);
    db.set('attempt-status', key, { status: failure.status, code: failure.code, attemptedAt });
    throw error;
  }
}

async function collectSnapshotData(api: ReadApi, config: Config, db: Store, number: number, options: { force?: boolean; now?: Date; round?: CollectionRound }): Promise<Snapshot> {
  const observedAt = (options.now ?? new Date()).toISOString();
  const old = db.get<Snapshot>('snapshot', String(number));
  const raw = rootPr(await api.query('meta', targetVars(config, number)));
  const pr = normalizePr(raw);
  if (pr.repository.toLowerCase() !== config.target.repository.toLowerCase() || pr.author.toLowerCase() !== config.target.author.toLowerCase()) throw new OpsError('PR does not match the configured target and author.', 'FAILED', 'TARGET_MISMATCH');
  const signature = fingerprint([config.auth.account, pr.id, pr.head, pr.updatedAt]);
  const reuse = !options.force && old?.complete && old.authAccount === config.auth.account && fingerprint(old.pr) === fingerprint(pr) && Date.parse(observedAt) - Date.parse(old.contentCheckedAt ?? old.observedAt) < EVIDENCE_CACHE_TTL_MS;
  const gaps: string[] = [];
  let pause: OpsError | undefined;
  async function category<T>(name: string, work: () => Promise<T>, fallback: T): Promise<T> {
    if (pause) { gaps.push(`${name}: ROUND_PAUSED`); return fallback; }
    try { return await work(); }
    catch (error) { const failure = safeError(error); gaps.push(`${name}: ${failure.code}`); if (error instanceof OpsError && error.outcome === 'PAUSED') pause = error; return fallback; }
  }
  const page = (name: QueryName, property: string) => readPages(api, db, `${number}:${name}`, signature, name, targetVars(config, number), value => rootPr(value)[property]);
  if (optional(object(raw.labels).pageInfo).hasNextPage) pr.labels = await category('labels', async () => (await page('labels', 'labels')).map(label => text(label.name)), pr.labels);
  let feedback = old?.feedback ?? [];
  let commits = old?.commits ?? [];
  let events = old?.events ?? [];
  let relations = old?.relations ?? [];
  if (!reuse) {
    const comments = await category('comments', () => page('comments', 'comments'), []);
    const reviews = await category('reviews', () => page('reviews', 'reviews'), []);
    const threads = await category('threads', () => page('threads', 'reviewThreads'), []);
    feedback = [...comments.map(item => normalizeFeedback(item, 'COMMENT')), ...reviews.map(item => normalizeFeedback(item, 'REVIEW'))];
    for (const thread of threads) {
      const extra = await category(`thread:${text(thread.id)}`, () => readPages(api, db, `${number}:thread:${text(thread.id)}`, signature, 'threadComments', { id: text(thread.id) }, value => object(object(value).node).comments, thread.comments), []);
      feedback.push(...extra.map(item => normalizeFeedback(item, 'REVIEW_COMMENT', thread)));
    }
    const sourceCommits = await category('commits', () => page('commits', 'commits'), []);
    commits = sourceCommits.map(value => { const item = object(value.commit); const author = object(item.author); return { sha: text(item.oid), authorEmail: text(author.email), authorLogin: nullable(optional(author.user).login), authoredAt: text(item.authoredDate), message: text(item.message) } satisfies SourceCommit; });
    const timeline = await category('timeline', () => page('timeline', 'timelineItems'), []);
    events = timeline.map(item => ({ id: text(item.id), kind: text(item.__typename), actor: nullable(optional(item.actor).login), at: text(item.createdAt), url: pr.url }));
    const unique = new Map<string, Relation>();
    for (const event of timeline) {
      if (event.__typename !== 'CrossReferencedEvent') continue;
      const source = object(event.source);
      const relation: Relation = { id: text(source.id), repository: text(object(source.repository).nameWithOwner), number: Number(source.number), kind: source.__typename === 'PullRequest' ? 'PR' : 'ISSUE', url: text(source.url), actor: nullable(optional(event.actor).login), referencedAt: text(event.createdAt), updatedAt: text(source.updatedAt), state: text(source.state), mergedAt: nullable(source.mergedAt), title: text(source.title), body: text(source.body), discussion: [], complete: false };
      const previous = old?.relations.find(item => item.id === relation.id);
      unique.set(relation.id, previous ? { ...previous, actor: relation.actor, referencedAt: relation.referencedAt, updatedAt: relation.updatedAt } : relation);
    }
    relations = [...unique.values()];
  }
  relations = await category('relations', () => refreshRelations(api, db, relations, signature, !reuse, config, options.force ? undefined : options.round), relations);
  const checks = await category('checks', async (): Promise<CheckFact[]> => {
    const items = await readPages(api, db, `${number}:checks`, signature, 'checks', { ...targetVars(config, number), head: pr.head }, value => {
      const commit = object(object(object(value).repository).object);
      if (commit.oid !== pr.head) throw new OpsError('Checks do not belong to the current head.', 'PARTIAL', 'CHECK_HEAD_MISMATCH');
      return commit.statusCheckRollup === null ? { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } : object(commit.statusCheckRollup).contexts;
    });
    return items.map(item => ({ id: text(item.id), name: text(item.name ?? item.context), head: pr.head, state: nullable(item.conclusion) ?? text(item.status ?? item.state), required: typeof item.isRequired === 'boolean' ? item.isRequired : null, url: nullable(item.detailsUrl ?? item.targetUrl) }));
  }, old?.checks ?? []);
  await category('consistency', async () => {
    const final = normalizePr(rootPr(await api.query('meta', targetVars(config, number))));
    if (final.head !== pr.head || final.updatedAt !== pr.updatedAt || final.state !== pr.state) throw new OpsError('PR changed while collection was in progress.', 'PARTIAL', 'PR_CHANGED_DURING_SCAN');
    // GitHub can calculate mergeability between the two reads without changing
    // PR updatedAt. Retain the final observation, including a final UNKNOWN.
    pr.mergeable = final.mergeable;
  }, undefined);
  const result: Snapshot = {
    pr, feedback: [...new Map(feedback.map(item => [item.id, item])).values()], relations, checks, commits, events,
    complete: gaps.length === 0, gaps, observedAt, contentCheckedAt: reuse ? old!.contentCheckedAt ?? old!.observedAt : observedAt,
    cached: !!reuse, version: '', authAccount: config.auth.account,
  };
  result.version = snapshotVersion(result); db.saveSnapshot(result);
  if (pause) throw pause;
  return result;
}

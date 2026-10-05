import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { OpsError } from './errors.js';
import type { PrIndex } from './model.js';
import { fingerprint } from './model.js';
import type { Store } from './store.js';

const oid = /^[a-f0-9]{40,64}$/;
// Analysis disables user/system configuration, hooks, replacement objects and executable diff filters.
export function gitRead(path: string, args: string[], input?: string): string {
  const allowed = new Set(['rev-parse', 'rev-list', 'show', 'diff', 'patch-id', 'cat-file', 'merge-base', 'check-ref-format']);
  if (!allowed.has(args[0]!)) throw new OpsError('Git operation is outside the analysis allowlist.', 'FAILED', 'GIT_READ_ONLY');
  try { return execFileSync('git', ['--no-replace-objects', '-c', 'core.hooksPath=/dev/null', '-c', 'diff.external=', '-c', 'core.fsmonitor=false', '-C', path, ...args], {
    encoding: 'utf8', input, maxBuffer: 128 * 1024 * 1024, timeout: 120000, stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1' },
  }).trim(); } catch { throw new OpsError('Git history/object read failed; verified totals are unavailable.', 'PARTIAL', 'GIT_OBJECT_UNAVAILABLE'); }
}
export interface Mapping { pr: number; source: string; upstream: string | null; evidence: ('EXACT_COMMIT_LANDED' | 'PATCH_EQUIVALENT' | 'EXPLICIT_CHERRY_PICK' | 'UNKNOWN')[] }
export interface HistoryResult { head: string; complete: boolean; gaps: string[]; reachable: string[]; primary: string[]; coauthored: string[]; union: string[]; formalPrs: number[]; mergedAt: Record<string, string | null>; mappings: Mapping[]; adoptions: { pr: number; sourceCount: number; matchedCount: number; upstreamObjects: string[]; evidence: string[]; currentCoverage: 'NOT_ESTABLISHED' }[]; dates: Record<string, string>; currentCoverage: 'NOT_ESTABLISHED' }
function patch(path: string, sha: string): string | null {
  const diff = gitRead(path, ['show', '--format=', '--no-ext-diff', '--no-textconv', '--binary', sha, '--']);
  if (!diff) return null;
  return gitRead(path, ['patch-id', '--stable'], diff + '\n').split(/\s/)[0] || null;
}
export function analyzeHistory(path: string, head: string, verifiedEmails: string[], prs: PrIndex[], sources: Record<string, string[]>, branch: string, cache?: Store): HistoryResult {
  if (!oid.test(head)) throw new OpsError('Analysis requires a fixed full commit object.', 'CONFIG_ERROR', 'GIT_SHA_INVALID');
  const gaps: string[] = [];
  if (gitRead(path, ['rev-parse', '--is-shallow-repository']) !== 'false') gaps.push('SHALLOW_HISTORY');
  const reachable = gitRead(path, ['rev-list', '--reverse', head, '--']).split('\n').filter(Boolean);
  const emails = new Set(verifiedEmails.map(email => email.toLowerCase()));
  if (!emails.size) gaps.push('AUTHOR_IDENTITY_UNVERIFIED');
  const primary: string[] = [], coauthored: string[] = [], dates: Record<string, string> = {};
  const messages = new Map<string, string>(), patchObjects = new Map<string, string[]>(), cherrySources = new Map<string, string[]>();
  for (const sha of reachable) {
    let metadata = cache?.get<{ email: string; date: string; body: string; patch: string | null }>('git-object', sha);
    if (!metadata) {
      const [email, date, ...message] = gitRead(path, ['show', '-s', '--format=%ae%n%aI%n%B', sha]).split('\n');
      metadata = { email: email!, date: date!, body: message.join('\n'), patch: patch(path, sha) };
      cache?.set('git-object', sha, metadata);
    }
    const { email, date, body } = metadata; dates[sha] = date; messages.set(sha, body);
    for (const match of body.matchAll(/^\(cherry picked from commit ([a-f0-9]{40,64})\)$/gm)) cherrySources.set(match[1]!, [...cherrySources.get(match[1]!) ?? [], sha]);
    if (emails.has(email!.toLowerCase())) primary.push(sha);
    const coauthors = [...body.matchAll(/^Co-authored-by:\s*[^\n<>]+<([^<>\n]+)>\s*$/gmi)];
    if (coauthors.some(match => emails.has(match[1]!.toLowerCase()))) coauthored.push(sha);
    const id = metadata.patch; if (id) patchObjects.set(id, [...patchObjects.get(id) ?? [], sha]);
  }
  const reached = new Set(reachable); const mappings: Mapping[] = [];
  for (const [number, sourceObjects] of Object.entries(sources)) for (const source of new Set(sourceObjects)) {
    if (!oid.test(source)) { gaps.push(`SOURCE_OBJECT_INVALID:${number}`); continue; }
    let id: string | null;
    try { gitRead(path, ['cat-file', '-e', source + '^{commit}']); id = patch(path, source); }
    catch { gaps.push(`SOURCE_OBJECT_MISSING:${source}`); mappings.push({ pr: Number(number), source, upstream: null, evidence: ['UNKNOWN'] }); continue; }
    const candidates = new Set([...(reached.has(source) ? [source] : []), ...(id ? patchObjects.get(id) ?? [] : [])]);
    // Provenance is a separate, exact object trailer; equivalence alone is not cherry-pick proof.
    for (const sha of cherrySources.get(source) ?? []) candidates.add(sha);
    for (const upstream of candidates) {
      const evidence: Mapping['evidence'] = [];
      if (source === upstream) evidence.push('EXACT_COMMIT_LANDED');
      if (id && patchObjects.get(id)?.includes(upstream)) evidence.push('PATCH_EQUIVALENT');
      if (messages.get(upstream)?.includes(`(cherry picked from commit ${source})`)) evidence.push('EXPLICIT_CHERRY_PICK');
      mappings.push({ pr: Number(number), source, upstream, evidence });
    }
    if (!candidates.size) mappings.push({ pr: Number(number), source, upstream: null, evidence: ['UNKNOWN'] });
  }
  const formalPrs = prs.filter(pr => pr.state === 'MERGED' && pr.base === branch).map(pr => pr.number);
  const adoptions = [...new Set([...prs.map(pr => pr.number), ...Object.keys(sources).map(Number)])].map(number => {
    const sourceCount = new Set(sources[number] ?? []).size;
    const matches = mappings.filter(mapping => mapping.pr === number && mapping.upstream);
    const matchedCount = new Set(matches.map(mapping => mapping.source)).size;
    const evidence = [...new Set([...matches.flatMap(mapping => mapping.evidence), ...(formalPrs.includes(number) ? ['DIRECT_PR_MERGE'] : []), ...(matchedCount > 0 && matchedCount < sourceCount ? ['PARTIAL_LANDED'] : []), ...(!matches.length && !formalPrs.includes(number) ? ['UNKNOWN'] : [])])];
    return { pr: number, sourceCount, matchedCount, upstreamObjects: [...new Set(matches.map(mapping => mapping.upstream!))], evidence, currentCoverage: 'NOT_ESTABLISHED' as const };
  });
  return { head, complete: !gaps.length, gaps: [...new Set(gaps)], reachable, primary, coauthored, union: [...new Set([...primary, ...coauthored])], formalPrs, mergedAt: Object.fromEntries(prs.filter(pr => formalPrs.includes(pr.number)).map(pr => [pr.number, pr.mergedAt])), mappings, adoptions, dates, currentCoverage: 'NOT_ESTABLISHED' };
}
interface Ledger { head: string; reachable: string[]; primary: string[]; coauthored: string[]; formalPrs: number[]; mappings: string[]; at: string; firstObserved: Record<string, string> }
export function recordLedger(db: Store, result: HistoryResult, at: string, timezone: string) {
  const old = db.get<Ledger>('git', 'ledger');
  const oldPrimary = new Set(old?.primary), oldCoauthored = new Set(old?.coauthored), oldPrs = new Set(old?.formalPrs), oldMappings = new Set(old?.mappings), oldReachable = new Set(old?.reachable);
  const baseline = !old; const reconcile = !!old && !result.reachable.includes(old.head);
  const newPrimary = baseline || reconcile ? [] : result.primary.filter(sha => !oldPrimary.has(sha));
  const newCoauthored = baseline || reconcile ? [] : result.coauthored.filter(sha => !oldCoauthored.has(sha));
  const newlyObservedFormalPrs = baseline ? [] : result.formalPrs.filter(number => !oldPrs.has(number));
  const newFormalPrs = newlyObservedFormalPrs.filter(number => { const merged = result.mergedAt[number]; return !!merged && Date.parse(merged) > Date.parse(old!.at) && Date.parse(merged) <= Date.parse(at); });
  const newlyObservedHistoricalMerges = newlyObservedFormalPrs.filter(number => !newFormalPrs.includes(number));
  const mappingIds = result.mappings.filter(m => m.upstream).map(m => fingerprint(m));
  const newHistoricalEvidence = baseline ? [] : result.mappings.filter(m => m.upstream && !oldMappings.has(fingerprint(m)) && oldReachable.has(m.upstream));
  const firstObserved = { ...old?.firstObserved };
  for (const sha of result.reachable) firstObserved[sha] ??= at;
  const delta = { baseline, reconcile, from: old?.at ?? null, at, timezone, localDate: new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at)), newPrimary, newCoauthored, newFormalPrs, newlyObservedHistoricalMerges, mergedAt: result.mergedAt, newHistoricalEvidence, basis: baseline ? 'historical baseline' : 'since previous synchronization', complete: result.complete };
  if (result.complete) db.atomic(() => { db.set('git', 'ledger', { head: result.head, reachable: result.reachable, primary: result.primary, coauthored: result.coauthored, formalPrs: result.formalPrs, mappings: mappingIds, at, firstObserved }); db.set('git', 'history', result); db.set('git', 'delta', delta); });
  else db.set('git', 'attempt', { result, delta });
  return delta;
}

// Explicit sync only. Public HTTPS, anonymous Git reads; no credential helper or checkout execution.
export function fetchBare(directory: string, repository: string, branch: string, numbers: number[]): string {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || numbers.some(n => !Number.isSafeInteger(n) || n < 1)) throw new OpsError('Invalid controlled fetch scope.', 'CONFIG_ERROR', 'FETCH_SCOPE');
  for (let parent = directory; parent !== dirname(parent); parent = dirname(parent)) if (existsSync(parent) && lstatSync(parent).isSymbolicLink()) throw new OpsError('Controlled Git directory cannot traverse symlinks.', 'CONFIG_ERROR', 'GIT_DIRECTORY_UNSAFE');
  const marker = join(directory, 'pr-ops-owner.json');
  const expected = JSON.stringify({ repository, branch, purpose: 'application-owned-bare-history' });
  if (existsSync(marker) ? readFileSync(marker, 'utf8') !== expected : readdirSync(directory).length !== 0) throw new OpsError('Existing Git directory is not owned by this scope.', 'CONFIG_ERROR', 'GIT_DIRECTORY_UNOWNED');
  if (!existsSync(marker)) writeFileSync(marker, expected, { mode: 0o600, flag: 'wx' });
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
    HTTP_PROXY: process.env.HTTP_PROXY, HTTPS_PROXY: process.env.HTTPS_PROXY, ALL_PROXY: process.env.ALL_PROXY, NO_PROXY: process.env.NO_PROXY,
    http_proxy: process.env.http_proxy, https_proxy: process.env.https_proxy, all_proxy: process.env.all_proxy, no_proxy: process.env.no_proxy };
  const run = (args: string[]) => {
    try { return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=', '-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never', ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000, maxBuffer: 16 * 1024 * 1024 }).trim(); }
    catch { throw new OpsError('Controlled public Git fetch failed; no complete contribution baseline was saved.', 'FAILED', 'GIT_FETCH_FAILED'); }
  };
  // Caller creates an application-owned directory, never passes an external working tree here.
  run(['check-ref-format', '--branch', branch]);
  run(['init', '--bare', directory]);
  run(['-C', directory, 'fetch', '--no-tags', '--no-recurse-submodules', 'https://github.com/' + repository + '.git', '+refs/heads/' + branch + ':refs/heads/analysis']);
  for (const number of numbers) run(['-C', directory, 'fetch', '--no-tags', '--no-recurse-submodules', 'https://github.com/' + repository + '.git', `refs/pull/${number}/head:refs/pr-ops/${number}`]);
  return gitRead(directory, ['rev-parse', 'refs/heads/analysis^{commit}']);
}

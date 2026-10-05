import type { Config } from './config.js';
import type { Confirmation, PrIndex } from './model.js';
import { decideMaintenance } from './maintenance.js';
import { snapshotVersion, fingerprint } from './model.js';
import type { Store } from './store.js';
import type { HistoryResult } from './git.js';

export function safeText(value: string): string {
  return value.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '');
}
export function localView(config: Config, db: Store) {
  const history = db.get<HistoryResult>('git', 'history');
  const latestHistory = db.get('git', 'attempt');
  const lastSync = db.get<{ status: string; observedAt: string }>('sync', 'last');
  const upstreamApplicable = history?.complete && !latestHistory && lastSync?.status === 'SUCCESS' && Date.now() - Date.parse(lastSync.observedAt) < 6 * 3600000;
  const prs = db.all<PrIndex>('index').map(pr => {
    let snapshot = db.snapshot(pr.number);
    if (snapshot) { snapshot = { ...snapshot, upstreamHead: upstreamApplicable ? history.head : undefined }; snapshot.version = snapshotVersion(snapshot); }
    const latestAttempt = db.get<{ status: string; code?: string }>('attempt-status', String(pr.number));
    const confirmations = db.all<Confirmation>('confirmation').filter(item => item.pr === pr.number && item.head === pr.head);
    const staleReasons = snapshot ? [
      ...(fingerprint(snapshot.pr) !== fingerprint(pr) ? ['Indexed PR evidence changed; the preceding snapshot is historical.'] : []),
      ...(snapshot.authAccount !== config.auth.account ? ['Authentication identity changed; permission-sensitive evidence requires collection.'] : []),
      ...(latestAttempt && latestAttempt.status !== 'SUCCESS' ? [`Latest collection did not succeed: ${latestAttempt.code ?? latestAttempt.status}.`] : []),
      ...(Date.now() - Date.parse(snapshot.contentCheckedAt ?? snapshot.observedAt) >= 6 * 3600000 ? ['Content recheck interval elapsed; synchronize to establish freshness.'] : []),
    ] : [];
    const decision = snapshot ? decideMaintenance(staleReasons.length ? { ...snapshot, complete: false, gaps: [...snapshot.gaps, ...staleReasons] } : snapshot, config, confirmations) : null;
    return { pr, snapshot, decision, latestAttempt: latestAttempt ?? null };
  });
  const index = db.get<{ observedAt: string }>('scan', 'successful-index');
  const indexAttempt = db.get<{ complete: boolean; error?: string }>('scan', 'index-progress');
  const ordinary = prs.filter(item => item.pr.state === 'OPEN' && !config.maintenance.excluded_prs.includes(item.pr.number) && !item.pr.labels.some(label => config.maintenance.excluded_labels.includes(label)));
    const incomplete = ordinary.some(item => !item.snapshot?.complete || item.decision?.coverage === 'UNCHECKED');
  const syncProblem = lastSync && lastSync.status !== 'SUCCESS';
  return { status: !index || indexAttempt?.error || incomplete || !history?.complete || latestHistory || syncProblem ? 'PARTIAL' as const : 'SUCCESS' as const,
    scope: { repository: config.target.repository, author: config.target.author, branch: config.target.branch }, timezone: config.reporting.timezone,
    coverage: { indexed: prs.length, ordinaryOpen: ordinary.length, checked: ordinary.filter(item => item.decision?.coverage === 'CHECKED').length, cached: ordinary.filter(item => item.decision?.coverage === 'CACHED').length, unchecked: ordinary.filter(item => !item.decision || item.decision.coverage === 'UNCHECKED').length, index, indexAttempt },
    lifecycle: { open: prs.filter(item => item.pr.state === 'OPEN').length, draft: prs.filter(item => item.pr.state === 'OPEN' && item.pr.draft).length, merged: prs.filter(item => item.pr.state === 'MERGED' && item.pr.base === config.target.branch).length, closed: prs.filter(item => item.pr.state === 'CLOSED').length },
    prs, contributions: history ?? null, contributionAttempt: latestHistory ?? null, lastSync: lastSync ?? null, changes: db.get('git', 'delta') ?? null,
    gaps: [...(!index ? ['No complete author index has been collected.'] : []), ...(!history?.complete ? ['No verified complete contribution history is available.'] : []), ...(latestHistory ? ['Latest contribution analysis is incomplete; preceding successful totals are retained.'] : []), ...(syncProblem ? [`Latest synchronization is ${lastSync.status}; retained successful evidence is historical.`] : [])] };
}
const md = (value: string) => safeText(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/([\\`*_[\]{}()!#|])/g, '\\$1');
export function markdown(view: ReturnType<typeof localView>): string {
  const lines = ['# Contributor PR Ops', '', `Status: ${view.status}`, '', `Repository: ${md(view.scope.repository)}; author: ${md(view.scope.author)}; branch: ${md(view.scope.branch)}`, '', '## Coverage', '', '```json', JSON.stringify({ coverage: view.coverage, lifecycle: view.lifecycle }, null, 2), '```', '', '## Maintenance', ''];
  for (const item of view.prs.filter(item => item.pr.state === 'OPEN' && !item.decision?.excluded)) {
    lines.push(`### PR ${item.pr.number}: ${md(item.pr.title)}`, '', `State: ${item.decision?.state ?? 'INSUFFICIENT_EVIDENCE'}; observed: ${item.snapshot?.observedAt ?? 'not collected'}`, '');
    for (const finding of item.decision?.findings ?? []) lines.push(`- ${md(finding.message)} (${md(finding.subject)})`);
    if (item.latestAttempt) lines.push(`Latest attempt: ${md(JSON.stringify(item.latestAttempt))}`);
    lines.push('');
  }
  lines.push('## Contributions', '', '```json', JSON.stringify({ history: view.contributions, changes: view.changes, gaps: view.gaps }, null, 2), '```');
  // Escape potential fences and HTML in serialized external values too.
  return lines.join('\n').replace(/<script/gi, '&lt;script') + '\n';
}

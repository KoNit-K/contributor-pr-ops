import type { Config } from './config.js';
import { OpsError } from './errors.js';
import { fingerprint, type Snapshot, type Feedback, type Role, type Confirmation, type Disposition, type Decision, type Finding, type MainState } from './model.js';

export function roleOf(feedback: Pick<Feedback, 'author' | 'bot' | 'association'>, config: Config): Role {
  const author = feedback.author?.toLowerCase();
  if (!author) return 'UNKNOWN';
  if (author === config.target.author.toLowerCase()) return 'SELF';
  if (feedback.bot) return 'BOT';
  if (config.maintenance.maintainer_overrides.some(login => login.toLowerCase() === author)) return 'MAINTAINER';
  if (feedback.association === 'OWNER' && config.target.repository.split('/')[0].toLowerCase() === author) return 'MAINTAINER';
  if (['MEMBER', 'COLLABORATOR', 'OWNER', 'UNKNOWN'].includes(feedback.association)) return 'UNKNOWN';
  return 'THIRD_PARTY';
}

export function subjectVersion(snapshot: Snapshot, subject: string): string {
  if (subject === 'pr') return snapshot.version;
  const [kind, ...ids] = subject.split(':'); const id = ids.join(':');
  const value = kind === 'feedback' ? snapshot.feedback.find(item => item.id === id) : kind === 'relation' ? snapshot.relations.find(item => item.id === id) : kind === 'check' ? snapshot.checks.find(item => item.id === id) : undefined;
  if (!value) throw new OpsError('Confirmation subject not found in the current evidence.', 'CONFIG_ERROR', 'SUBJECT_MISSING');
  return fingerprint(value);
}

export function createConfirmation(snapshot: Snapshot, subject: string, disposition: Disposition, rationale: string, evidenceUrls: string[], source: Confirmation['source']): Confirmation {
  if (!rationale.trim() || !evidenceUrls.length || !evidenceUrls.every(value => { try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'github.com' && !url.username && !url.password && !url.search; } catch { return false; } })) throw new OpsError('Confirmation requires a rationale and safe GitHub evidence links.', 'CONFIG_ERROR', 'CONFIRMATION_EVIDENCE');
  if (disposition === 'FULL_COVERAGE' && !snapshot.upstreamHead) throw new OpsError('Full coverage requires a checked upstream SHA.', 'CONFIG_ERROR', 'UPSTREAM_UNVERIFIED');
  return { pr: snapshot.pr.number, subject, version: subjectVersion(snapshot, subject), head: snapshot.pr.head, disposition, rationale, evidenceUrls, source, recordedAt: new Date().toISOString(), ...(disposition === 'FULL_COVERAGE' ? { upstreamHead: snapshot.upstreamHead } : {}) };
}

const priority: MainState[] = ['CONFLICT', 'MAINTAINER_ACTION', 'THIRD_PARTY_FEEDBACK', 'UPSTREAM_CHANGED', 'INSUFFICIENT_EVIDENCE', 'CLOSE_CANDIDATE', 'MAINTAINER_EDITED', 'WAIT_REVIEWER', 'NO_ACTION'];
export function decideMaintenance(snapshot: Snapshot, config: Config, confirmations: Confirmation[]): Decision {
  const findings: Finding[] = [];
  const add = (state: MainState, subject: string, message: string, url: string | null, actionable = true) => findings.push({ state, subject, message, url, actionable, version: subject === 'pr' ? snapshot.version : subjectVersion(snapshot, subject) });
  const valid = new Map<string, Confirmation>();
  for (const confirmation of confirmations) {
    if (confirmation.pr !== snapshot.pr.number || confirmation.head !== snapshot.pr.head) continue;
    if (confirmation.disposition === 'FULL_COVERAGE' && (!snapshot.upstreamHead || confirmation.upstreamHead !== snapshot.upstreamHead)) continue;
    try { if (confirmation.version === subjectVersion(snapshot, confirmation.subject)) valid.set(confirmation.subject, confirmation); } catch { /* A removed subject invalidates its old confirmation. */ }
  }
  const disposition = (subject: string) => valid.get(subject)?.disposition;
  if (!snapshot.complete) add('INSUFFICIENT_EVIDENCE', 'pr', `Collection incomplete: ${snapshot.gaps.join('; ') || 'required pages were not verified'}`, snapshot.pr.url);
  if (snapshot.pr.mergeable === 'CONFLICTING') add('CONFLICT', 'pr', 'GitHub currently reports a conflict.', snapshot.pr.url);
  if (snapshot.pr.mergeable === 'UNKNOWN' && snapshot.pr.state === 'OPEN') add('INSUFFICIENT_EVIDENCE', 'pr', 'Current mergeability is unknown; absence of conflict is not established.', snapshot.pr.url);
  for (const item of snapshot.feedback) {
    const subject = `feedback:${item.id}`;
    const role = roleOf(item, config);
    if (role === 'SELF' || item.resolved || (item.kind === 'REVIEW' && item.reviewState === 'APPROVED' && !item.body.trim())) continue;
    const action = disposition(subject);
    if (action === 'NO_ACTION' || action === 'NON_BLOCKING') { add('NO_ACTION', subject, `${action}: locally reviewed feedback remains available.`, item.url, false); continue; }
    if (action === 'WAIT_REVIEWER') { add('WAIT_REVIEWER', subject, 'Specific response/fix locally verified for this head; awaiting review.', item.url, false); continue; }
    if (action === 'TODO' && role === 'MAINTAINER') { add('MAINTAINER_ACTION', subject, 'Verified maintainer request remains pending.', item.url); continue; }
    if (role === 'THIRD_PARTY') { add('THIRD_PARTY_FEEDBACK', subject, 'Third-party feedback awaits local review; it is not a maintainer instruction.', item.url); continue; }
    add('INSUFFICIENT_EVIDENCE', subject, role === 'MAINTAINER' ? 'Verify the meaning and current applicability of this maintainer feedback.' : `Verify feedback meaning and role (${role}); association alone does not establish decision authority.`, item.url);
  }
  for (const event of snapshot.events) {
    if (event.kind === 'HeadRefForcePushedEvent' && event.actor && roleOf({ author: event.actor, association: 'NONE', bot: false }, config) === 'MAINTAINER') add('MAINTAINER_EDITED', 'pr', 'A verified maintainer force-pushed this PR; inspect current changes and preserve their work.', event.url, false);
  }
  if (disposition('pr') === 'MAINTAINER_EDITED') add('MAINTAINER_EDITED', 'pr', 'Maintainer modification locally verified for this evidence version.', snapshot.pr.url, false);
  for (const relation of snapshot.relations) {
    const subject = `relation:${relation.id}`;
    const action = disposition(subject);
    if (action === 'NO_ACTION' || action === 'NON_BLOCKING') continue;
    if (action === 'FULL_COVERAGE') { add('CLOSE_CANDIDATE', subject, 'Current full coverage was locally verified; this is a suggestion only.', relation.url); continue; }
    const decision = relation.discussion.find(item => valid.get(subject)?.evidenceUrls.includes(item.url) && roleOf(item, config) === 'MAINTAINER');
    if (action === 'CLOSE_CONFIRMED' && decision) { add('CLOSE_CANDIDATE', subject, 'Explicit upstream decision locally verified against its actual maintainer author and current discussion version.', decision.url); continue; }
    add('UPSTREAM_CHANGED', subject, `Inspect related ${relation.kind} ${relation.number} (${relation.state}); linkage, labels, matching files and future plans do not prove replacement.`, relation.url);
    if (!relation.complete) add('INSUFFICIENT_EVIDENCE', subject, 'Related source discussion was not completely read.', relation.url);
  }
  for (const item of snapshot.checks) {
    if (item.head !== snapshot.pr.head || !['FAILURE', 'FAILED', 'ERROR', 'TIMED_OUT', 'ACTION_REQUIRED', 'CANCELLED', 'STARTUP_FAILURE'].includes(item.state)) continue;
    const subject = `check:${item.id}`;
    if (disposition(subject) === 'NO_ACTION' || disposition(subject) === 'NON_BLOCKING') { add('NO_ACTION', subject, `Locally reviewed check fact: ${item.name} (${item.state}).`, item.url, false); continue; }
    add('INSUFFICIENT_EVIDENCE', subject, `Current check ${item.name} is ${item.state}; verify author responsibility and infrastructure/non-blocking scope (required=${item.required ?? 'unknown'}).`, item.url);
  }
  if (disposition('pr') === 'FULL_COVERAGE') add('CLOSE_CANDIDATE', 'pr', 'Current complete functional coverage locally verified; no close operation is performed.', snapshot.pr.url);
  if (!findings.length) add('NO_ACTION', 'pr', 'Complete current evidence contains no known author action.', snapshot.pr.url, false);
  const state = priority.find(candidate => findings.some(item => item.state === candidate))!;
  return { number: snapshot.pr.number, state, findings, excluded: config.maintenance.excluded_prs.includes(snapshot.pr.number) || snapshot.pr.labels.some(label => config.maintenance.excluded_labels.includes(label)), coverage: !snapshot.complete ? 'UNCHECKED' : snapshot.cached ? 'CACHED' : 'CHECKED', observedAt: snapshot.observedAt, version: snapshot.version };
}

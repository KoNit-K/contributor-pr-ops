import { createHash } from 'node:crypto';

export type Role = 'SELF' | 'MAINTAINER' | 'THIRD_PARTY' | 'BOT' | 'UNKNOWN';
export type Lifecycle = 'OPEN' | 'CLOSED' | 'MERGED';
export type MainState = 'NO_ACTION' | 'CONFLICT' | 'MAINTAINER_ACTION' | 'THIRD_PARTY_FEEDBACK' | 'WAIT_REVIEWER' | 'MAINTAINER_EDITED' | 'UPSTREAM_CHANGED' | 'CLOSE_CANDIDATE' | 'INSUFFICIENT_EVIDENCE';

export interface PrIndex {
  id: string; number: number; repository: string; author: string; url: string; title: string; body: string;
  state: Lifecycle; draft: boolean; head: string; base: string; updatedAt: string; createdAt: string;
  mergedAt: string | null; mergeCommit: string | null; mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'; labels: string[];
}
export interface Feedback {
  id: string; kind: 'COMMENT' | 'REVIEW' | 'REVIEW_COMMENT'; author: string | null; bot: boolean;
  association: string; body: string; url: string; createdAt: string; updatedAt: string;
  threadId: string | null; resolved: boolean; outdated: boolean; reviewState: string | null; commit: string | null;
  replyTo: string | null;
}
export interface CheckFact {
  id: string; name: string; head: string; state: string; required: boolean | null; url: string | null;
}
export interface Relation {
  id: string; repository: string; number: number; kind: 'ISSUE' | 'PR'; url: string; actor: string | null;
  referencedAt: string; updatedAt: string; state: string; mergedAt: string | null; title: string; body: string;
  discussion: Feedback[]; complete: boolean;
}
export interface SourceCommit { sha: string; authorLogin: string | null; authorEmail: string; authoredAt: string; message: string }
export interface Snapshot {
  pr: PrIndex; feedback: Feedback[]; relations: Relation[]; checks: CheckFact[]; commits: SourceCommit[];
  events: { id: string; kind: string; actor: string | null; at: string; url: string }[];
  complete: boolean; gaps: string[]; observedAt: string; version: string; authAccount: string;
  contentCheckedAt?: string; cached?: boolean;
}
export type Disposition = 'READ' | 'TODO' | 'WAIT_REVIEWER' | 'NO_ACTION' | 'NON_BLOCKING' | 'CLOSE_CONFIRMED' | 'FULL_COVERAGE' | 'MAINTAINER_EDITED';
export interface Confirmation {
  pr: number; subject: string; version: string; head: string; disposition: Disposition;
  rationale: string; evidenceUrls: string[]; source: 'user-confirmed' | 'agent-reviewed'; recordedAt: string;
}
export interface Finding {
  state: MainState; subject: string; message: string; url: string | null; actionable: boolean; version: string;
}
export interface Decision {
  number: number; state: MainState; findings: Finding[]; excluded: boolean;
  coverage: 'CHECKED' | 'CACHED' | 'UNCHECKED'; observedAt: string; version: string;
}

export function fingerprint(value: unknown): string {
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, item]) => [k, canonical(item)])) : v;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
export function snapshotVersion(snapshot: Omit<Snapshot, 'version'> | Snapshot): string {
  const { pr, feedback, relations, checks, commits, events, complete, gaps, authAccount } = snapshot;
  return fingerprint({ pr, feedback, relations, checks, commits, events, complete, gaps, authAccount });
}

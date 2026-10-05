import { loadConfig } from '../src/config.js';
import type { Snapshot, PrIndex, Feedback } from '../src/model.js';
import { snapshotVersion } from '../src/model.js';

export const config = () => loadConfig('config/example.yaml');
export function pr(number = 1, overrides: Partial<PrIndex> = {}): PrIndex {
  return { id: `pr-${number}`, number, repository: 'example-org/example-repo', author: 'example-contributor', url: `https://github.com/example-org/example-repo/pull/${number}`, title: 'Synthetic change', body: '', state: 'OPEN', draft: false, head: 'a'.repeat(40), base: 'main', updatedAt: '2026-01-01T00:00:00Z', createdAt: '2025-01-01T00:00:00Z', mergedAt: null, mergeCommit: null, mergeable: 'MERGEABLE', labels: [], ...overrides };
}
export function feedback(id = 'feedback-1', overrides: Partial<Feedback> = {}): Feedback {
  return { id, kind: 'COMMENT', author: 'another-contributor', bot: false, association: 'NONE', body: 'Synthetic feedback requiring interpretation', url: 'https://github.com/example-org/example-repo/pull/1#issuecomment-1', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', threadId: null, resolved: false, outdated: false, reviewState: null, commit: null, replyTo: null, ...overrides };
}
export function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  const result: Snapshot = { pr: pr(), feedback: [], relations: [], checks: [], commits: [], events: [], complete: true, gaps: [], observedAt: '2026-01-01T01:00:00Z', version: '', authAccount: 'your-github-user', ...overrides };
  result.version = snapshotVersion(result);
  return result;
}
export function rawPr(number: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const item = pr(number);
  return { id: item.id, number, title: item.title, body: item.body, url: item.url, state: item.state, isDraft: false, headRefOid: item.head, baseRefName: item.base, updatedAt: item.updatedAt, createdAt: item.createdAt, mergedAt: null, mergeCommit: null, mergeable: 'MERGEABLE', author: { login: item.author }, repository: { nameWithOwner: item.repository }, labels: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } }, ...overrides };
}
export function connection(nodes: unknown[], hasNextPage = false, endCursor: string | null = null) { return { nodes, pageInfo: { hasNextPage, endCursor } }; }

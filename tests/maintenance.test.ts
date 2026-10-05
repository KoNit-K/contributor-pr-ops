import { describe, expect, it } from 'vitest';
import { decideMaintenance, createConfirmation, roleOf } from '../src/maintenance.js';
import { config, feedback, pr, snapshot } from './helpers.js';
import type { Confirmation, Snapshot, Relation } from '../src/model.js';

const settings = () => { const c = config(); c.maintenance.maintainer_overrides = ['verified-maintainer']; return c; };
const ack = (s: Snapshot, subject: string, disposition: Confirmation['disposition'] = 'WAIT_REVIEWER') => createConfirmation(s, subject, disposition, 'Verified against this specific evidence', [s.pr.url], 'user-confirmed');
const relation = (overrides: Partial<Relation> = {}): Relation => ({ id: 'relation-1', repository: 'example-org/example-repo', number: 2, kind: 'PR', url: 'https://github.com/example-org/example-repo/pull/2', actor: 'verified-maintainer', referencedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', state: 'OPEN', mergedAt: null, title: 'Similar file and title', body: 'Will cherry-pick later', discussion: [], complete: true, ...overrides });

describe('A06 deterministic author maintenance', () => {
  it('does not generate work from age, behind-main, or pure structured approval', () => {
    const s = snapshot({ feedback: [feedback('approval', { kind: 'REVIEW', author: 'verified-maintainer', reviewState: 'APPROVED', body: '' })] });
    expect(decideMaintenance(s, settings(), []).state).toBe('NO_ACTION');
  });
  it('preserves specific pending requests after the author says they will fix later', () => {
    const f = feedback('request', { author: 'verified-maintainer' });
    const s = snapshot({ feedback: [f, feedback('reply', { author: pr().author, body: 'I will fix later' })] });
    expect(decideMaintenance(s, settings(), [ack(s, 'feedback:request', 'TODO')]).state).toBe('MAINTAINER_ACTION');
  });
  it('completes two specific requests while the third remains visible', () => {
    const s = snapshot({ feedback: ['a', 'b', 'c'].map(id => feedback(id, { author: 'verified-maintainer' })) });
    const result = decideMaintenance(s, settings(), [ack(s, 'feedback:a'), ack(s, 'feedback:b'), ack(s, 'feedback:c', 'TODO')]);
    expect(result.state).toBe('MAINTAINER_ACTION');
    expect(result.findings.filter(f => f.state === 'WAIT_REVIEWER')).toHaveLength(2);
    expect(result.findings.find(f => f.subject === 'feedback:c')?.state).toBe('MAINTAINER_ACTION');
  });
  it('does not clear feedback merely because there is a newer unrelated commit', () => {
    const s = snapshot({ feedback: [feedback('request', { author: 'verified-maintainer' })] });
    expect(decideMaintenance(s, settings(), []).findings.some(f => f.subject === 'feedback:request')).toBe(true);
  });
  it('keeps third-party and unverified organization roles distinct', () => {
    expect(roleOf(feedback(), settings())).toBe('THIRD_PARTY');
    expect(roleOf(feedback('member', { association: 'MEMBER' }), settings())).toBe('UNKNOWN');
    const s = snapshot({ feedback: [feedback()] });
    expect(decideMaintenance(s, settings(), []).state).toBe('THIRD_PARTY_FEEDBACK');
  });
  it('waits for review only after evidence-bound disposition and invalidates it on changes', () => {
    const s = snapshot({ feedback: [feedback('request', { author: 'verified-maintainer' })] });
    const confirmation = ack(s, 'feedback:request');
    expect(decideMaintenance(s, settings(), [confirmation]).state).toBe('WAIT_REVIEWER');
    const changed = snapshot({ ...s, pr: { ...s.pr, head: 'b'.repeat(40) } });
    expect(decideMaintenance(changed, settings(), [confirmation]).state).not.toBe('WAIT_REVIEWER');
    const edited = snapshot({ ...s, feedback: [{ ...s.feedback[0], body: 'Edited request' }] });
    expect(decideMaintenance(edited, settings(), [confirmation]).state).not.toBe('WAIT_REVIEWER');
  });
  it('retains maintainer edit alongside conflicts or new requirements', () => {
    const s = snapshot({ pr: pr(1, { mergeable: 'CONFLICTING' }), events: [{ id: 'push', kind: 'HeadRefForcePushedEvent', actor: 'verified-maintainer', at: '2026-01-01T00:00:00Z', url: pr().url }] });
    const result = decideMaintenance(s, settings(), []);
    expect(result.state).toBe('CONFLICT');
    expect(result.findings.some(f => f.state === 'MAINTAINER_EDITED')).toBe(true);
  });
  it('keeps thanks and suggestions reviewable without keyword-based blocking', () => {
    const s = snapshot({ feedback: [feedback('thanks', { author: 'verified-maintainer', body: 'thanks' })] });
    expect(decideMaintenance(s, settings(), []).state).toBe('INSUFFICIENT_EVIDENCE');
    expect(decideMaintenance(s, settings(), [ack(s, 'feedback:thanks', 'NO_ACTION')]).state).toBe('NO_ACTION');
    expect(decideMaintenance(s, settings(), [ack(s, 'feedback:thanks', 'NON_BLOCKING')]).state).toBe('NO_ACTION');
  });
  it('does not turn incomplete collection, unknown mergeability, or current required failures into NO_ACTION', () => {
    for (const s of [snapshot({ complete: false, gaps: ['comments: HTTP_403'] }), snapshot({ pr: pr(1, { mergeable: 'UNKNOWN' }) }), snapshot({ checks: [{ id: 'test', name: 'unit tests', head: pr().head, state: 'FAILURE', required: true, url: null }] })]) {
      expect(decideMaintenance(s, settings(), []).state).toBe('INSUFFICIENT_EVIDENCE');
    }
    expect(decideMaintenance(snapshot({ checks: [{ id: 'old', name: 'deployment', head: 'b'.repeat(40), state: 'FAILURE', required: false, url: null }] }), settings(), []).state).toBe('NO_ACTION');
  });
});
describe('A07 upstream relationships and close candidates', () => {
  it('keeps weak matches, closed issues and future plans as investigation only', () => {
    for (const r of [relation(), relation({ kind: 'ISSUE', state: 'CLOSED' }), relation({ state: 'MERGED', mergedAt: '2026-01-01T00:00:00Z' })]) {
      const result = decideMaintenance(snapshot({ relations: [r] }), settings(), []);
      expect(result.findings.some(f => f.state === 'CLOSE_CANDIDATE')).toBe(false);
      expect(result.state).toBe('UPSTREAM_CHANGED');
    }
  });
  it('requires specific valid full-coverage or explicit decision evidence and expires it', () => {
    const s = snapshot({ upstreamHead: 'c'.repeat(40), relations: [relation()] });
    const confirmation = ack(s, 'relation:relation-1', 'FULL_COVERAGE');
    expect(decideMaintenance(s, settings(), [confirmation]).state).toBe('CLOSE_CANDIDATE');
    const changed = snapshot({ ...s, relations: [relation({ state: 'MERGED', updatedAt: '2026-02-01T00:00:00Z' })] });
    expect(decideMaintenance(changed, settings(), [confirmation]).state).toBe('UPSTREAM_CHANGED');
  });
  it('does not invent an associated issue or accept an unidentifiable confirmation', () => {
    const s = snapshot();
    expect(decideMaintenance(s, settings(), []).state).toBe('NO_ACTION');
    expect(() => ack(s, 'relation:not-found', 'CLOSE_CONFIRMED')).toThrow('not found');
  });
});

it('binds full coverage to checked upstream SHA, including upstream-only reverts', () => {
  const s = snapshot({ upstreamHead: 'c'.repeat(40), relations: [relation({ state: 'MERGED' })] });
  const confirmation = ack(s, 'relation:relation-1', 'FULL_COVERAGE');
  expect(decideMaintenance(s, settings(), [confirmation]).state).toBe('CLOSE_CANDIDATE');
  expect(decideMaintenance(snapshot({ ...s, upstreamHead: 'd'.repeat(40) }), settings(), [confirmation]).state).toBe('UPSTREAM_CHANGED');
  expect(() => ack(snapshot(), 'pr', 'FULL_COVERAGE')).toThrow('upstream');
});
it('uses the decision author, never the cross-reference actor, for explicit closure', () => {
  for (const [referenceActor, decisionActor, expected] of [['verified-maintainer', 'third-party', 'UPSTREAM_CHANGED'], ['third-party', 'verified-maintainer', 'CLOSE_CANDIDATE']] as const) {
    const decision = feedback('decision', { author: decisionActor });
    const s = snapshot({ relations: [relation({ actor: referenceActor, discussion: [decision] })] });
    const confirmation = createConfirmation(s, 'relation:relation-1', 'CLOSE_CONFIRMED', 'Explicit decision verified in this discussion', [decision.url], 'agent-reviewed');
    expect(decideMaintenance(s, settings(), [confirmation]).state).toBe(expected);
  }
});

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeHistory, recordLedger } from '../src/git.js';
import { Store } from '../src/store.js';
import { pr } from './helpers.js';

function history(work: (path: string, git: (...args: string[]) => string, commit: (content: string, email?: string, message?: string) => string) => void) {
  const path = mkdtempSync(join(tmpdir(), 'pr-ops-git-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', path, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Same Name'); git('config', 'user.email', 'verified@example.test');
  const commit = (content: string, email = 'verified@example.test', message = 'Change') => { writeFileSync(join(path, 'file'), content); git('add', 'file'); git('-c', `user.email=${email}`, 'commit', '-m', message); return git('rev-parse', 'HEAD'); };
  try { work(path, git, commit); } finally { rmSync(path, { recursive: true, force: true }); }
}

describe('native Git attribution', () => {
  it('counts three primary commits, one formal PR and excludes a different email with the same name', () => history((path, git, commit) => {
    const base = commit('base', 'other@example.test'); git('checkout', '-b', 'topic');
    const source = [commit('one'), commit('two'), commit('three')]; git('checkout', 'main'); git('-c', 'user.email=other@example.test', 'merge', '--no-ff', 'topic', '-m', 'Merge');
    const result = analyzeHistory(path, git('rev-parse', 'HEAD'), ['verified@example.test'], [pr(1, { state: 'MERGED', mergedAt: '2026-01-01T00:00:00Z', mergeCommit: git('rev-parse', 'HEAD') })], { '1': source }, 'main');
    expect(result.primary).toEqual(source); expect(result.formalPrs).toEqual([1]); expect(result.union).toHaveLength(3); expect(result.complete).toBe(true); expect(result.reachable).toContain(base);
    expect(result.mappings.filter(m => m.evidence.includes('EXACT_COMMIT_LANDED'))).toHaveLength(3);
  }));
  it('counts one squash upstream commit instead of three source commits', () => history((path, git, commit) => {
    commit('base', 'other@example.test'); git('checkout', '-b', 'topic'); const source = [commit('one'), commit('two'), commit('three')];
    git('checkout', 'main'); git('merge', '--squash', 'topic'); git('commit', '-m', 'Squash'); const head = git('rev-parse', 'HEAD');
    const result = analyzeHistory(path, head, ['verified@example.test'], [pr(1, { state: 'MERGED', mergeCommit: head })], { '1': source }, 'main');
    expect(result.primary).toEqual([head]); expect(result.formalPrs).toEqual([1]); expect(result.mappings.every(m => !m.evidence.includes('EXACT_COMMIT_LANDED'))).toBe(true);
  }));
  it('separates patch equivalence from explicit cherry-pick and deduplicates coauthors', () => history((path, git, commit) => {
    const base = commit('base', 'other@example.test'); git('checkout', '-b', 'topic'); const source = commit('source', 'other@example.test');
    git('checkout', 'main'); commit('unrelated', 'other@example.test'); git('reset', '--hard', base);
    git('-c', 'user.email=other@example.test', 'cherry-pick', '-x', source); const landed = git('rev-parse', 'HEAD');
    commit('later', 'verified@example.test', 'Change\n\nCo-authored-by: Same Name <verified@example.test>');
    const result = analyzeHistory(path, git('rev-parse', 'HEAD'), ['verified@example.test'], [], { '1': [source], '2': [source] }, 'main');
    expect(result.mappings.filter(m => m.upstream === landed)).toHaveLength(2);
    expect(result.mappings[0].evidence).toContain('PATCH_EQUIVALENT'); expect(result.mappings[0].evidence).toContain('EXPLICIT_CHERRY_PICK');
    expect(result.union).toHaveLength(1); expect(result.coauthored).toHaveLength(1);
  }));
  it('marks missing objects as incomplete and never infers current full coverage', () => history((path, git, commit) => {
    commit('one'); const result = analyzeHistory(path, git('rev-parse', 'HEAD'), ['verified@example.test'], [], { '1': ['f'.repeat(40)] }, 'main');
    expect(result.complete).toBe(false); expect(result.gaps).toContain('SOURCE_OBJECT_MISSING:' + 'f'.repeat(40)); expect(result.mappings[0].evidence).toEqual(['UNKNOWN']);
  }));
});

it('records baseline, zero repeat, interval additions and non-fast-forward reconciliation without negative changes', () => history((path, git, commit) => {
  const db = new Store(':memory:', 'test'); const one = commit('one');
  const first = analyzeHistory(path, one, ['verified@example.test'], [], {}, 'main');
  const baseline = recordLedger(db, first, '2026-01-01T15:59:00Z', 'Asia/Singapore');
  expect(baseline.baseline).toBe(true); expect(baseline.newPrimary).toEqual([]);
  expect(recordLedger(db, first, '2026-01-01T16:01:00Z', 'Asia/Singapore').newPrimary).toEqual([]);
  const two = commit('two'); const next = analyzeHistory(path, two, ['verified@example.test'], [], {}, 'main');
  expect(recordLedger(db, next, '2026-01-03T16:01:00Z', 'Asia/Singapore').newPrimary).toEqual([two]);
  git('reset', '--hard', one); const rewritten = recordLedger(db, first, '2026-01-04T16:01:00Z', 'Asia/Singapore');
  expect(rewritten.reconcile).toBe(true); expect(rewritten.newPrimary).toEqual([]); db.close();
}));

it('keeps historical authorship after revert and distinguishes rebased patch matches', () => history((path, git, commit) => {
  commit('base', 'other@example.test'); git('checkout', '-b', 'topic'); const source = commit('source');
  git('checkout', 'main'); writeFileSync(join(path, 'other'), 'unrelated'); git('add', 'other'); git('-c', 'user.email=other@example.test', 'commit', '-m', 'Unrelated');
  git('checkout', 'topic'); git('rebase', 'main'); const rewritten = git('rev-parse', 'HEAD');
  git('checkout', 'main'); git('merge', '--ff-only', 'topic'); git('-c', 'user.email=other@example.test', 'revert', '--no-edit', rewritten);
  const result = analyzeHistory(path, git('rev-parse', 'HEAD'), ['verified@example.test'], [pr(1, { state: 'MERGED', mergeCommit: rewritten })], { '1': [source] }, 'main');
  expect(result.primary).toEqual([rewritten]); expect(result.formalPrs).toEqual([1]); expect(result.currentCoverage).toBe('NOT_ESTABLISHED');
  expect(result.mappings.find(m => m.upstream === rewritten)?.evidence).toContain('PATCH_EQUIVALENT');
  expect(result.mappings.find(m => m.upstream === rewritten)?.evidence).not.toContain('EXPLICIT_CHERRY_PICK');
}));
it('separates newly observed historical merges from actual interval merges', () => history((path, _git, commit) => {
  const db = new Store(':memory:', 'test'); const head = commit('one');
  recordLedger(db, analyzeHistory(path, head, ['verified@example.test'], [], {}, 'main'), '2026-01-01T15:59:00Z', 'Asia/Singapore');
  const result = analyzeHistory(path, head, ['verified@example.test'], [pr(1, { state: 'MERGED', mergedAt: '2025-06-01T00:00:00Z' }), pr(2, { state: 'MERGED', mergedAt: '2026-01-01T16:01:00Z' })], {}, 'main');
  const delta = recordLedger(db, result, '2026-01-03T16:02:00Z', 'Asia/Singapore');
  expect(delta.newFormalPrs).toEqual([2]); expect(delta.newlyObservedHistoricalMerges).toEqual([1]); expect(delta.localDate).toBe('2026-01-04'); db.close();
}));
it('never lazily fetches missing promisor objects or runs local credential helpers', () => history((path, git, commit) => {
  const head = commit('one'); const marker = join(path, 'helper-ran'); const helper = join(path, 'helper');
  writeFileSync(helper, '#!/bin/sh\ntouch "' + marker + '"\n');
  git('config', 'extensions.partialClone', 'origin'); git('config', 'remote.origin.promisor', 'true'); git('config', 'remote.origin.url', 'https://unreachable.example.test/repo'); git('config', 'credential.helper', '!' + helper);
  const result = analyzeHistory(path, head, ['verified@example.test'], [], { '1': ['f'.repeat(40)] }, 'main');
  expect(result.complete).toBe(false); expect(git('status', '--porcelain')).not.toContain('helper-ran');
}));
it('labels shallow history incomplete without modifying the source worktree', () => history((path, git, commit) => {
  commit('one'); const head = commit('two'); const before = git('status', '--porcelain');
  const root = mkdtempSync(join(tmpdir(), 'pr-ops-shallow-')); const clone = join(root, 'clone');
  try {
    execFileSync('git', ['clone', '--depth=1', 'file://' + path, clone], { stdio: ['ignore', 'pipe', 'pipe'] });
    const result = analyzeHistory(clone, head, ['verified@example.test'], [], {}, 'main');
    expect(result.complete).toBe(false); expect(result.gaps).toContain('SHALLOW_HISTORY'); expect(git('status', '--porcelain')).toBe(before);
  } finally { rmSync(root, { recursive: true, force: true }); }
}));
it('records partial landed evidence separately from complete functional coverage', () => history((path, git, commit) => {
  commit('base', 'other@example.test'); const one = commit('one'); git('checkout', '-b', 'source'); const two = commit('two'); git('checkout', 'main');
  const result = analyzeHistory(path, one, ['verified@example.test'], [pr(1)], { '1': [one, two] }, 'main');
  expect(result.adoptions[0]).toMatchObject({ sourceCount: 2, matchedCount: 1, currentCoverage: 'NOT_ESTABLISHED' });
  expect(result.adoptions[0]!.evidence).toContain('PARTIAL_LANDED'); expect(result.adoptions[0]!.upstreamObjects).toEqual([one]);
}));
it('classifies newly discovered old adoption without pretending it entered main today', () => history((path, _git, commit) => {
  const db = new Store(':memory:', 'test'); const head = commit('one');
  recordLedger(db, analyzeHistory(path, head, ['verified@example.test'], [], {}, 'main'), '2026-01-01T00:00:00Z', 'UTC');
  const delta = recordLedger(db, analyzeHistory(path, head, ['verified@example.test'], [pr(1)], { '1': [head] }, 'main'), '2026-01-02T00:00:00Z', 'UTC');
  expect(delta.newPrimary).toEqual([]); expect(delta.newHistoricalEvidence).toHaveLength(1); expect(delta.newHistoricalEvidence[0]!.upstream).toBe(head); db.close();
}));

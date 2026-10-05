import { it, expect } from 'vitest';
import { Store } from '../src/store.js';
import { localView, markdown, safeText } from '../src/views.js';
import { config, snapshot, feedback, pr } from './helpers.js';

it('renders maintenance as readable findings with local time and safe links instead of internal JSON', () => {
  const db = new Store(':memory:', 'test'); const c = config(); c.reporting.timezone = 'Asia/Singapore';
  const s = snapshot({ observedAt: '2026-10-05T05:08:35Z', pr: { ...snapshot().pr, title: 'feat(cron): honor future start_at', mergeable: 'CONFLICTING' }, feedback: [feedback('internal-id', { body: 'Please consider adding a regression test.' })] });
  db.set('index', '1', s.pr); db.saveSnapshot(s); db.set('attempt-status', '1', { status: 'SUCCESS', attemptedAt: s.observedAt, gaps: [] });
  const rendered = markdown(localView(c, db));
  expect(rendered).toContain('feat(cron): honor future start_at'); expect(rendered).toContain('存在合并冲突');
  expect(rendered).toContain('第三方反馈'); expect(rendered).toContain('Please consider adding a regression test.');
  expect(rendered).toContain('13:08:35'); expect(rendered).toContain('Asia/Singapore'); expect(rendered).toContain('最近采集：成功');
  expect(rendered).not.toContain('feedback:internal-id'); expect(rendered).not.toContain('```json'); expect(rendered).not.toContain('"attemptedAt"');
  expect(rendered).toContain('[查看 PR](https://github.com/example-org/example-repo/pull/1)'); db.close();
});
it('shows unavailable contribution totals as unverified rather than zero or a JSON dump', () => {
  const db = new Store(':memory:', 'test'); const rendered = markdown(localView(config(), db));
  expect(rendered).toContain('部分完成'); expect(rendered).toContain('贡献基线尚未完成');
  expect(rendered).not.toContain('```json'); expect(rendered).not.toContain('"history"'); db.close();
});
it('summarizes distinct contribution counts without turning a historical baseline into daily additions', () => {
  const db = new Store(':memory:', 'test');
  db.set('git', 'history', { complete: true, head: 'c'.repeat(40), gaps: [], reachable: ['a', 'b'], primary: ['a'], coauthored: ['a', 'b'], union: ['a', 'b'], formalPrs: [1], adoptions: [], mappings: [], dates: {}, mergedAt: {}, currentCoverage: 'NOT_ESTABLISHED' });
  db.set('git', 'delta', { baseline: true, reconcile: false, from: null, at: '2026-01-01T00:00:00Z', newPrimary: [], newCoauthored: [], newFormalPrs: [], newHistoricalEvidence: [] });
  const rendered = markdown(localView(config(), db));
  expect(rendered).toContain('| 正式合并 PR | 1 |'); expect(rendered).toContain('| 共同署名提交 | 2 |'); expect(rendered).toContain('| 两类提交去重并集 | 2 |');
  expect(rendered).toContain('历史总量不计为当天新增贡献'); expect(rendered).toContain('以下为保留的历史结果'); db.close();
});
it('omits excluded uncollected PRs from the maintenance scope and explains late historical merges', () => {
  const db = new Store(':memory:', 'test'); const c = config(); c.maintenance.excluded_prs = [2]; c.maintenance.excluded_labels = ['deferred'];
  for (const item of [pr(1), pr(2, { title: 'Excluded by number' }), pr(3, { title: 'Excluded by label', labels: ['deferred'] })]) db.set('index', String(item.number), item);
  db.set('git', 'delta', { baseline: false, reconcile: false, from: '2026-01-01T00:00:00Z', at: '2026-01-02T00:00:00Z', newPrimary: [], newCoauthored: [], newFormalPrs: [], newlyObservedHistoricalMerges: [7], newHistoricalEvidence: [] });
  const view = localView(c, db); const rendered = markdown(view);
  expect(view.coverage.ordinaryOpen).toBe(1); expect(rendered).not.toContain('Excluded by number'); expect(rendered).not.toContain('Excluded by label');
  expect(rendered).toContain('区间内正式合并 PR：0'); expect(rendered).toContain('本轮首次发现的历史正式合并 PR：1');
  expect(rendered).toContain('历史合并不计为区间内新发生的合并'); db.close();
});

it('exposes latest failure alongside a preserved complete snapshot', () => {
  const db = new Store(':memory:', 'test'); const s = snapshot(); db.set('index', '1', s.pr); db.saveSnapshot(s);
  db.set('attempt-status', '1', { status: 'FAILED', code: 'HTTP_403' });
  const view = localView(config(), db); expect(view.status).toBe('PARTIAL'); expect(view.prs[0]!.snapshot?.complete).toBe(true);
  expect(view.prs[0]!.latestAttempt).toEqual({ status: 'FAILED', code: 'HTTP_403' }); db.close();
});
it('keeps empty stores partial and strips tracking HTML and terminal escapes from reports', () => {
  const db = new Store(':memory:', 'test'); expect(localView(config(), db).status).toBe('PARTIAL');
  const s = snapshot({ pr: { ...snapshot().pr, title: '\u001b[31m<img src="https://tracker.test/a">[click](javascript:evil)' } });
  db.set('index', '1', s.pr); db.saveSnapshot(s); const rendered = markdown(localView(config(), db));
  expect(rendered).not.toContain('<img'); expect(rendered).not.toContain('\u001b'); expect(rendered).not.toContain('[click](javascript:evil)');
  expect(safeText('\u001b]8;;https://tracker.test\u0007x\u001b]8;;\u0007')).toBe('x'); db.close();
});
it('marks changed head and changed authentication as unchecked while preserving historical data', () => {
  const db = new Store(':memory:', 'test'); const s = snapshot({ observedAt: new Date().toISOString() }); db.saveSnapshot(s);
  db.set('index', '1', { ...s.pr, head: 'b'.repeat(40) });
  let view = localView(config(), db); expect(view.coverage.unchecked).toBe(1); expect(view.prs[0]!.decision!.state).toBe('INSUFFICIENT_EVIDENCE');
  db.set('index', '1', s.pr); const c = config(); c.auth.account = 'different-reader';
  view = localView(c, db); expect(view.coverage.unchecked).toBe(1); expect(view.prs[0]!.snapshot!.pr.head).toBe(s.pr.head); db.close();
});
it('does not hide a failed whole-round synchronization behind prior successful totals', () => {
  const db = new Store(':memory:', 'test'); const s = snapshot({ observedAt: new Date().toISOString() }); db.set('index', '1', s.pr); db.saveSnapshot(s); db.set('attempt-status', '1', { status: 'SUCCESS' });
  db.set('scan', 'successful-index', { observedAt: new Date().toISOString() }); db.set('git', 'history', { complete: true, head: 'c'.repeat(40), primary: [] });
  db.set('sync', 'last', { status: 'SUCCESS', observedAt: new Date().toISOString() }); expect(localView(config(), db).status).toBe('SUCCESS');
  for (const code of ['AUTH_UNAVAILABLE', 'NETWORK_UNAVAILABLE', 'GIT_FETCH_FAILED']) {
    db.set('sync', 'last', { status: 'FAILED', code, observedAt: new Date().toISOString() }); const view = localView(config(), db);
    expect(view.status).toBe('PARTIAL'); expect(view.gaps.join(' ')).toContain('Latest synchronization is FAILED'); expect(view.contributions).not.toBeNull(); expect(view.prs[0]!.snapshot!.upstreamHead).toBeUndefined();
  } db.close();
});
it('includes safe clickable evidence but withholds authenticated or tracking URLs', () => {
  const db = new Store(':memory:', 'test'); const s = snapshot({ observedAt: new Date().toISOString() }); db.set('index', '1', s.pr); db.saveSnapshot(s);
  expect(markdown(localView(config(), db))).toContain('[查看 PR](https://github.com/example-org/example-repo/pull/1)');
  db.set('index', '1', { ...s.pr, url: 'https://user:password@github.com/example-org/example-repo/pull/1?token=secret' });
  const report = markdown(localView(config(), db)); expect(report).not.toContain('password'); expect(report).not.toContain('?token='); db.close();
});

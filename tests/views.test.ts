import { it, expect } from 'vitest';
import { Store } from '../src/store.js';
import { localView, markdown, safeText } from '../src/views.js';
import { config, snapshot } from './helpers.js';

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
  expect(markdown(localView(config(), db))).toContain('[source](https://github.com/example-org/example-repo/pull/1)');
  db.set('index', '1', { ...s.pr, url: 'https://user:password@github.com/example-org/example-repo/pull/1?token=secret' });
  const report = markdown(localView(config(), db)); expect(report).not.toContain('password'); expect(report).not.toContain('?token='); db.close();
});

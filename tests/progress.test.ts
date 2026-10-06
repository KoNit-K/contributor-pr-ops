import { it, expect, vi } from 'vitest';
import { renderProgress } from '../src/progress.js';
it('renders progress and actual wait reason without declaring incomplete evidence successful', () => {
  const text = renderProgress({ stage: 'collect', processed: 2, total: 5, successful: 1, cached: 1, remaining: 4, scopeTotal: 10, currentPr: 3, elapsedMs: 65000, activity: { phase: 'quota-wait', operation: 'threads', bucket: 'graphql', waitMs: 4500, requests: 12, timings: { networkMs: 10000, pacingWaitMs: 3000, quotaWaitMs: 7000, retryWaitMs: 0 } } });
  expect(text).toContain('2/5'); expect(text).toContain('#3'); expect(text).toContain('剩余 4');
  expect(text).toContain('配额等待'); expect(text).toContain('4.5秒'); expect(text).toContain('请求 12');
  expect(text).toContain('网络 10.0秒'); expect(text).toContain('配额等待 7.0秒');
  expect(text).not.toContain('100%');
});

it('observes a live checkpoint without changing files or taking the sync lock', async () => {
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path'); const { tmpdir } = await import('node:os');
  const { initialize, loadConfig } = await import('../src/config.js'); const { Store } = await import('../src/store.js');
  const { readProgress } = await import('../src/progress.js');
  const root = mkdtempSync(join(tmpdir(), 'pr-ops-progress-'));
  try {
    const path = join(root, 'config/local.yaml'); initialize(path); const config = loadConfig(path);
    const db = new Store(join(config.storage.directory, 'ops.sqlite'), config.scope);
    db.set('sync', 'checkpoint', { remaining: [2, 3], complete: false });
    db.set('attempt-status', '2', { status: 'RUNNING', attemptedAt: '2026-01-01T00:01:00Z' });
    db.set('attempt-status', '1', { status: 'RUNNING', attemptedAt: '2025-12-31T23:00:00Z' }); db.close();
    const lock = join(config.storage.directory, 'sync.lock'); writeFileSync(lock, JSON.stringify({ pid: process.pid, createdAt: '2026-01-01T00:00:00Z' }));
    const before = readFileSync(lock); const database = readFileSync(join(config.storage.directory, 'ops.sqlite'));
    expect(readProgress(config, Date.parse('2026-01-01T00:02:00Z'))).toMatchObject({ active: true, remaining: 2, currentPr: 2, elapsedMs: 120000 });
    expect(readFileSync(lock)).toEqual(before); expect(readFileSync(join(config.storage.directory, 'ops.sqlite'))).toEqual(database);
    writeFileSync(lock, JSON.stringify({ pid: process.pid, createdAt: '2026-01-01T00:03:00Z' }));
    expect(readProgress(config)).toMatchObject({ active: true, stage: 'unknown', currentPr: undefined });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('prints heartbeat updates while a request waits and stops after close', async () => {
  const { progressReporter } = await import('../src/progress.js'); vi.useFakeTimers();
  try {
    const lines: string[] = []; const reporter = progressReporter(line => lines.push(line));
    reporter.update({ stage: 'authentication', processed: 0, total: 0, successful: 0, cached: 0, remaining: 0, scopeTotal: 0, elapsedMs: 0 });
    expect(lines).toHaveLength(1); vi.advanceTimersByTime(10000); expect(lines).toHaveLength(2); expect(lines[1]).toContain('10.0秒');
    reporter.close(); vi.advanceTimersByTime(10000); expect(lines).toHaveLength(2);
  } finally { vi.useRealTimers(); }
});

it('includes the ongoing wait in display time without mutating measured totals', () => {
  const activity = { phase: 'quota-wait' as const, operation: 'meta', bucket: 'graphql', startedAt: 1000, requests: 1, timings: { networkMs: 100, pacingWaitMs: 0, quotaWaitMs: 200, retryWaitMs: 0 } };
  expect(renderProgress({ stage: 'collect', processed: 0, total: 1, successful: 0, cached: 0, remaining: 1, scopeTotal: 1, elapsedMs: 0, activity }, 6000)).toContain('配额等待 5.2秒');
  expect(activity.timings.quotaWaitMs).toBe(200);
});

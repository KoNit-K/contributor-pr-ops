import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config.js';
import type { ClientActivity } from './github.js';
export interface SyncProgress {
  currentBatch?: number[];
  stage: 'authentication' | 'index' | 'collect' | 'history' | 'complete';
  processed: number; total: number; successful: number; cached: number; remaining: number; scopeTotal: number;
  elapsedMs: number; currentPr?: number; outcome?: string; activity?: ClientActivity;
}
export function renderProgress(p: SyncProgress, now = Date.now()): string {
  const seconds = (ms: number) => (ms / 1000).toFixed(1) + '秒';
  const stages = { authentication: '核验认证与额度', index: '获取分页清单', collect: '检查 PR', history: '分析贡献历史', complete: '本轮结束' };
  const phases = { network: '读取网络', 'pacing-wait': '最小间隔等待', 'quota-wait': '项目预算间隔', 'retry-wait': '服务端或重试等待', idle: '处理响应' };
  const a = p.activity ? { ...p.activity, timings: { ...p.activity.timings } } : undefined;
  if (a && a.phase !== 'idle' && a.startedAt !== undefined) {
    const key = { network: 'networkMs', 'pacing-wait': 'pacingWaitMs', 'quota-wait': 'quotaWaitMs', 'retry-wait': 'retryWaitMs' }[a.phase] as keyof ClientActivity['timings'];
    a.timings[key] += Math.max(0, now - a.startedAt);
  }
  const outcome = p.outcome ? ({ SUCCESS: '成功', PARTIAL: '部分完成', PAUSED: '暂停', FAILED: '失败' }[p.outcome] ?? p.outcome) : stages[p.stage];
  const text = [`[同步] ${outcome}`, ...(p.total ? [`已检查 ${p.processed}/${p.total} (${Math.floor(p.processed / p.total * 100)}%)`, `成功 ${p.successful}`, `复用 ${p.cached}`, `剩余 ${p.remaining}`, `维护范围 ${p.scopeTotal}`] : []), ...(p.currentBatch?.length ? [`当前批次 ${p.currentBatch.map(number => '#' + number).join(', ')}`] : p.currentPr ? [`当前 #${p.currentPr}`] : []), `已用 ${seconds(p.elapsedMs)}`];
  if (a) text.push(`${phases[a.phase]} ${a.operation}${a.waitMs ? '，等待 ' + seconds(a.waitMs) : ''}`, `请求 ${a.requests}`, `网络 ${seconds(a.timings.networkMs)}`, `间隔等待 ${seconds(a.timings.pacingWaitMs)}`, `项目预算间隔 ${seconds(a.timings.quotaWaitMs)}`, `重试等待 ${seconds(a.timings.retryWaitMs)}`);
  return text.join(' | ');
}
export function progressReporter(write: (line: string) => void, intervalMs = 10000) {
  let latest: SyncProgress | undefined; let last = 0; let stage: SyncProgress['stage'] | undefined;
  const started = Date.now();
  const flush = () => { if (latest) { write(renderProgress({ ...latest, elapsedMs: Math.max(latest.elapsedMs, Date.now() - started) }) + '\n'); last = Date.now(); } };
  const timer = setInterval(flush, intervalMs); timer.unref();
  return { update(p: SyncProgress) { latest = p; if (stage !== p.stage || Date.now() - last >= intervalMs) { stage = p.stage; flush(); } }, close() { clearInterval(timer); } };
}

// A separate observer never acquires a lock, migrates storage or contacts GitHub.
export function readProgress(config: Config, now = Date.now()) {
  const lockPath = join(config.storage.directory, 'sync.lock');
  let lock: { pid: number; createdAt: string } | undefined;
  try { lock = JSON.parse(readFileSync(lockPath, 'utf8')); } catch { /* No readable lock. */ }
  let active = false;
  if (lock && Number.isSafeInteger(lock.pid) && lock.pid > 0) {
    try { process.kill(lock.pid, 0); active = true; }
    catch (error) { active = (error as NodeJS.ErrnoException).code === 'EPERM'; }
  }
  const path = join(config.storage.directory, 'ops.sqlite');
  const base = { status: 'SUCCESS', active, lockPresent: existsSync(lockPath), elapsedMs: active && lock ? Math.max(0, now - Date.parse(lock.createdAt)) : 0 };
  if (!existsSync(path)) return { ...base, stage: 'no-data', indexPages: undefined, remaining: 0, currentPr: undefined, lastSync: undefined };
  const db = new DatabaseSync(path, { readOnly: true, allowExtension: false, timeout: 5000 });
  try {
    const get = <T>(kind: string, key: string): T | undefined => {
      const row = db.prepare('SELECT json FROM records WHERE scope=? AND kind=? AND key=?').get(config.scope, kind, key) as { json: string } | undefined;
      return row ? JSON.parse(row.json) as T : undefined;
    };
    // One read transaction prevents combining checkpoints from different PR completions.
    db.exec('BEGIN');
    const checkpoint = get<{ remaining: number[]; complete: boolean }>('sync', 'checkpoint');
    const index = ['index-progress', 'open-index-progress'].map(key => get<{ complete: boolean; startedAt: string; cursors: string[] }>('scan', key)).filter(value => !!value).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
    const rows = db.prepare('SELECT key,json FROM records WHERE scope=? AND kind=?').all(config.scope, 'attempt-status') as { key: string; json: string }[];
    const current = active && lock ? rows.map(row => ({ number: Number(row.key), ...JSON.parse(row.json) as { status: string; attemptedAt: string } }))
      .filter(row => row.status === 'RUNNING' && Date.parse(row.attemptedAt) >= Date.parse(lock!.createdAt)).sort((a, b) => b.attemptedAt.localeCompare(a.attemptedAt))[0] : undefined;
    const last = get<{ status: string; observedAt: string }>('sync', 'last');
    db.exec('COMMIT');
    const indexing = active && index && !index.complete && lock && Date.parse(index.startedAt) >= Date.parse(lock.createdAt);
    return { ...base, stage: active ? indexing ? 'index' : current ? 'collect' : 'unknown' : 'idle', remaining: checkpoint?.remaining.length ?? 0, currentPr: current?.number, indexPages: indexing ? index.cursors.length : undefined, lastSync: last ? { status: last.status, observedAt: last.observedAt } : undefined };
  } finally { db.close(); }
}
export function renderObserver(p: ReturnType<typeof readProgress>): string {
  if (!p.active) return `[进度] 当前没有运行中的同步 | 保存队列剩余 ${p.remaining} | 上次结果 ${p.lastSync?.status ?? '尚无'}${p.lockPresent ? ' | 存在未持有的锁，请核实进程后处理' : ''}`;
  return `[进度] ${p.stage === 'index' ? '获取清单（已保存 ' + p.indexPages + ' 页）' : p.stage === 'collect' ? '检查 PR' : '持锁进程活动，具体阶段未核实'} | ${p.currentPr ? '当前 #' + p.currentPr + ' | ' : ''}保存队列剩余 ${p.remaining} | 已用 ${(p.elapsedMs / 60000).toFixed(1)}分钟 | 本地观察，不联网；剩余为业务断点，不代表动作数量`;
}

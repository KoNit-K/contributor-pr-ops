import { DatabaseSync } from 'node:sqlite';
import { chmodSync, closeSync, fstatSync, statSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { OpsError } from './errors.js';
import { fingerprint, type Snapshot, type PrIndex } from './model.js';

export class Store {
  private readonly db: DatabaseSync;
  constructor(path: string, public readonly scope: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path, { timeout: 5000, allowExtension: false });
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    const version = Number(this.db.prepare('PRAGMA user_version').get()!.user_version);
    if (version > 1) { this.db.close(); throw new OpsError('Database schema is newer than this application.', 'FAILED', 'SCHEMA_TOO_NEW'); }
    if (version === 0) this.atomic(() => {
      this.db.exec('CREATE TABLE records (scope TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(scope, kind, key)) STRICT;');
      this.db.exec('PRAGMA user_version = 1;');
    });
  }
  get<T>(kind: string, key: string): T | undefined {
    const row = this.db.prepare('SELECT json FROM records WHERE scope=? AND kind=? AND key=?').get(this.scope, kind, key) as { json: string } | undefined;
    return row ? JSON.parse(row.json) as T : undefined;
  }
  set(kind: string, key: string, value: unknown): void {
    this.db.prepare('INSERT INTO records VALUES(?,?,?,?) ON CONFLICT(scope,kind,key) DO UPDATE SET json=excluded.json').run(this.scope, kind, key, JSON.stringify(value));
  }
  remove(kind: string, key: string): void { this.db.prepare('DELETE FROM records WHERE scope=? AND kind=? AND key=?').run(this.scope, kind, key); }
  all<T>(kind: string): T[] { return (this.db.prepare('SELECT json FROM records WHERE scope=? AND kind=? ORDER BY key').all(this.scope, kind) as { json: string }[]).map(row => JSON.parse(row.json) as T); }
  atomic<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  getWindow<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT json FROM records WHERE scope=? AND kind=? AND key=?').get('@authentication', 'window', key) as { json: string } | undefined;
    return row ? JSON.parse(row.json) as T : undefined;
  }
  removeWindow(key: string): void { this.db.prepare('DELETE FROM records WHERE scope=? AND kind=? AND key=?').run('@authentication', 'window', key); }
  setWindow(key: string, value: unknown): void { this.db.prepare('INSERT INTO records VALUES(?,?,?,?) ON CONFLICT(scope,kind,key) DO UPDATE SET json=excluded.json').run('@authentication', 'window', key, JSON.stringify(value)); }
  saveSnapshot(snapshot: Snapshot): void {
    this.atomic(() => {
      this.set('attempt', String(snapshot.pr.number), snapshot);
      if (snapshot.complete) {
        this.set('snapshot', String(snapshot.pr.number), snapshot);
        // Detail collection is newer than enumeration, including GitHub's lazy mergeability result.
        // Advance an existing matching object atomically; never infer index completeness here.
        for (const kind of ['index', 'open-index']) {
        const indexed = this.get<PrIndex>(kind, String(snapshot.pr.number));
        if (indexed?.id === snapshot.pr.id) {
          const detailTime = Date.parse(snapshot.pr.updatedAt), indexTime = Date.parse(indexed.updatedAt);
          const sameRevision = detailTime === indexTime && fingerprint({ ...snapshot.pr, mergeable: indexed.mergeable }) === fingerprint(indexed);
          // An old replica or ambiguous same-second head must not erase a newer index.
          if (detailTime > indexTime || sameRevision) this.set(kind, String(snapshot.pr.number), snapshot.pr);
        }
      }
      }
    });
  }
  snapshot(number: number): Snapshot | undefined { return this.get<Snapshot>('snapshot', String(number)) ?? this.get<Snapshot>('attempt', String(number)); }
  close(): void { this.db.close(); }
}

export function acquireLock(directory: string): () => void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'sync.lock');
  let descriptor: number;
  try { descriptor = openSync(path, 'wx', 0o600); }
  catch { throw new OpsError('Another local operation holds the storage lock. If a process crashed, verify it has exited before removing sync.lock.', 'PAUSED', 'LOCAL_LOCKED'); }
  const contents = JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() });
  const identity = fstatSync(descriptor);
  try { writeFileSync(descriptor, contents); }
  finally { closeSync(descriptor); }
  let released = false;
  const unlock = () => {
    if (released) return;
    released = true;
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', terminate);
    process.removeListener('exit', unlock);
    try {
      const current = statSync(path);
      if (current.dev === identity.dev && current.ino === identity.ino && readFileSync(path, 'utf8') === contents) unlinkSync(path);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  };
  // Signals otherwise terminate Node before an async operation's finally runs.
  // SQLite writes are synchronous; already-saved business checkpoints remain intact.
  const interrupt = () => { try { unlock(); } finally { process.exit(130); } };
  const terminate = () => { try { unlock(); } finally { process.exit(143); } };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);
  process.once('exit', unlock);
  return unlock;
}

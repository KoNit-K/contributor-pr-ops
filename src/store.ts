import Database from 'better-sqlite3';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { OpsError } from './errors.js';
import type { Snapshot } from './model.js';

export class Store {
  private readonly db: Database.Database;
  constructor(path: string, public readonly scope: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    const version = this.db.pragma('user_version', { simple: true }) as number;
    if (version > 1) { this.db.close(); throw new OpsError('Database schema is newer than this application.', 'FAILED', 'SCHEMA_TOO_NEW'); }
    if (version === 0) this.db.transaction(() => {
      this.db.exec('CREATE TABLE records (scope TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(scope, kind, key)) STRICT;');
      this.db.pragma('user_version = 1');
    })();
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
  atomic<T>(fn: () => T): T { return this.db.transaction(fn)(); }
  getWindow<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT json FROM records WHERE scope=? AND kind=? AND key=?').get('@authentication', 'window', key) as { json: string } | undefined;
    return row ? JSON.parse(row.json) as T : undefined;
  }
  setWindow(key: string, value: unknown): void { this.db.prepare('INSERT INTO records VALUES(?,?,?,?) ON CONFLICT(scope,kind,key) DO UPDATE SET json=excluded.json').run('@authentication', 'window', key, JSON.stringify(value)); }
  saveSnapshot(snapshot: Snapshot): void {
    this.atomic(() => {
      this.set('attempt', String(snapshot.pr.number), snapshot);
      if (snapshot.complete) this.set('snapshot', String(snapshot.pr.number), snapshot);
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
  try { writeFileSync(descriptor, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })); }
  finally { closeSync(descriptor); }
  return () => {
    if (existsSync(path) && JSON.parse(readFileSync(path, 'utf8')).pid === process.pid) unlinkSync(path);
  };
}

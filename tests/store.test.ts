import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store, acquireLock } from '../src/store.js';

describe('A02/A05 persistent local storage', () => {
  it('isolates scopes, supports transactions and survives restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pr-ops-store-'));
    try {
      const path = join(dir, 'data.db');
      const db = new Store(path, 'first-target');
      db.set('index', '1', { title: 'synthetic' });
      expect(() => db.atomic(() => { db.set('index', '2', {}); throw new Error('interruption'); })).toThrow('interruption');
      expect(db.get('index', '2')).toBeUndefined();
      db.close();
      const next = new Store(path, 'first-target');
      const other = new Store(path, 'second-target');
      expect(next.get('index', '1')).toEqual({ title: 'synthetic' });
      expect(other.all('index')).toEqual([]);
      next.setWindow('reader:core', { used: 7 });
      expect(other.getWindow('reader:core')).toEqual({ used: 7 });
      expect(other.getWindow('another-reader:core')).toBeUndefined();
      next.close(); other.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('rejects concurrent sync and allows normal release/reacquisition', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pr-ops-lock-'));
    try {
      const unlock = acquireLock(dir);
      expect(() => acquireLock(dir)).toThrow('Another local operation');
      unlock();
      const second = acquireLock(dir); second();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

it.each([['SIGINT', 130], ['SIGTERM', 143]] as const)('releases the real child process lock on %s and retains the saved checkpoint', async (signal, code) => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-ops-signal-'));
  const module = pathToFileURL(resolve('dist/store.js')).href;
  const script = `import { Store, acquireLock } from ${JSON.stringify(module)}; const dir=process.argv[1]; const db=new Store(dir+'/ops.sqlite','synthetic'); db.set('sync','checkpoint',{remaining:[2,3],complete:false}); acquireLock(dir); process.stdout.write('ready'); setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, dir], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await once(child.stdout!, 'data'); expect(existsSync(join(dir, 'sync.lock'))).toBe(true);
    const exited = once(child, 'exit'); child.kill(signal); const [exitCode, exitSignal] = await exited;
    expect(exitCode).toBe(code); expect(exitSignal).toBeNull(); expect(existsSync(join(dir, 'sync.lock'))).toBe(false);
    const db = new Store(join(dir, 'ops.sqlite'), 'synthetic');
    try { expect(db.get('sync', 'checkpoint')).toEqual({ remaining: [2, 3], complete: false }); } finally { db.close(); }
    const unlock = acquireLock(dir); unlock();
  } finally { child.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); }
});
it('does not remove a replaced lock or retain cleanup listeners after release', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-ops-lock-replaced-')); const before = process.listenerCount('SIGINT');
  try {
    const unlock = acquireLock(dir); const other = JSON.stringify({ pid: process.pid, createdAt: 'replacement' });
    writeFileSync(join(dir, 'sync.lock'), other); unlock(); unlock();
    expect(readFileSync(join(dir, 'sync.lock'), 'utf8')).toBe(other); expect(process.listenerCount('SIGINT')).toBe(before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('permits independent project data directory locks at the same time', () => {
  const first = mkdtempSync(join(tmpdir(), 'pr-ops-lock-one-')), second = mkdtempSync(join(tmpdir(), 'pr-ops-lock-two-'));
  const unlockFirst = acquireLock(first);
  try { const unlockSecond = acquireLock(second); try { expect(existsSync(join(first, 'sync.lock'))).toBe(true); expect(existsSync(join(second, 'sync.lock'))).toBe(true); } finally { unlockSecond(); } }
  finally { unlockFirst(); rmSync(first, { recursive: true, force: true }); rmSync(second, { recursive: true, force: true }); }
});

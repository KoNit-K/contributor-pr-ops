import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
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

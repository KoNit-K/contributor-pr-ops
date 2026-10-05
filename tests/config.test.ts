import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialize, loadConfig } from '../src/config.js';

describe('A01 configuration and offline initialization', () => {
  it('creates one generic sample without replacing existing data', () => {
    const root = mkdtempSync(join(tmpdir(), 'pr-ops-config-'));
    try {
      const path = join(root, 'config', 'local.yaml');
      initialize(path);
      const first = readFileSync(path, 'utf8');
      expect(first).toContain('example-org/example-repo');
      expect(() => initialize(path)).toThrow('already exists');
      expect(readFileSync(path, 'utf8')).toBe(first);
      const config = loadConfig(path);
      expect(config.storage.directory).toBe(join(root, '.local'));
      expect(config.auth.account).not.toBe(config.target.author);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('rejects missing files, unknown fields, credentials and invalid timezone', () => {
    const root = mkdtempSync(join(tmpdir(), 'pr-ops-config-'));
    try {
      const path = join(root, 'local.yaml');
      expect(() => loadConfig(path)).toThrow('Configuration file not found');
      initialize(path);
      const sample = readFileSync(path, 'utf8');
      for (const content of [sample + '\ntoken: secret\n', sample.replace('timezone: UTC', 'timezone: Invalid/Place'), sample.replace('0.40', '0'), sample.replace('max_retries: 2', 'max_retries: 3')]) {
        writeFileSync(path, content);
        expect(() => loadConfig(path)).toThrow('Invalid configuration');
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

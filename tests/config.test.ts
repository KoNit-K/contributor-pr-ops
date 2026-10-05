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
it('supports a second independent configuration without conflating authentication and authorship', () => {
  const root = mkdtempSync(join(tmpdir(), 'pr-ops-config-two-'));
  try {
    const first = join(root, 'one.yaml'), second = join(root, 'two.yaml'); initialize(first); initialize(second);
    writeFileSync(second, readFileSync(second, 'utf8').replace('example-org/example-repo', 'another-org/another-repo').replace('example-contributor', 'another-author'));
    const a = loadConfig(first), b = loadConfig(second); expect(a.scope).not.toBe(b.scope); expect(a.auth.account).toBe(b.auth.account); expect(b.target.author).toBe('another-author'); expect(b.auth.account).not.toBe(b.target.author);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

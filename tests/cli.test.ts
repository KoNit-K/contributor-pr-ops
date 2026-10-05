import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('CLI without credentials', () => {
  it('provides help without GitHub authentication', () => {
    const output = execFileSync(process.execPath, ['dist/cli.js', '--help'], { encoding: 'utf8' });
    expect(output).toContain('pr-ops');
    expect(output).toContain('init');
  });
  it('initializes offline and returns configuration exit code on duplicate init', () => {
    const root = mkdtempSync(join(tmpdir(), 'pr-ops-cli-'));
    try {
      const args = ['dist/cli.js', '--config', join(root, 'config/local.yaml'), '--json', 'init'];
      const first = spawnSync(process.execPath, args, { encoding: 'utf8' });
      expect(first.status).toBe(0);
      expect(JSON.parse(first.stdout).status).toBe('SUCCESS');
      const second = spawnSync(process.execPath, args, { encoding: 'utf8' });
      expect(second.status).toBe(2);
      expect(JSON.parse(second.stdout).code).toBe('CONFIG_EXISTS');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

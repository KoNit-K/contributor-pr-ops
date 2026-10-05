import { it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { registerPrivatePaths } from '../src/privacy.js';
it('rejects ordinary named reports and custom storage paths even without secrets', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-ops-paths-')); const file = resolve('synthetic-report.md'); const registry = join(dir, 'paths.json');
  try {
    writeFileSync(file, 'Synthetic personal report without tokens.'); registerPrivatePaths([file, resolve('custom-store')], registry);
    const result = spawnSync(process.execPath, ['scripts/public-check.mjs', '--paths-file', registry], { encoding: 'utf8' });
    expect(result.status).toBe(1); expect(result.stderr).toContain('Local-only data entered public manifest: synthetic-report.md');
  } finally { rmSync(file, { force: true }); rmSync(dir, { recursive: true, force: true }); }
});

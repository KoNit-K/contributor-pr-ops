import { it, expect } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { registerPrivatePaths } from '../src/privacy.js';
it('requires explicit local confirmation for a public email in commit history', () => {
  const root = mkdtempSync(join(tmpdir(), 'pr-ops-identity-'));
  try {
    expect(spawnSync('git', ['init', root]).status).toBe(0);
    mkdirSync(join(root, 'scripts')); mkdirSync(join(root, '.local'));
    cpSync('scripts/history-check.mjs', join(root, 'scripts', 'history-check.mjs'));
    writeFileSync(join(root, '.gitignore'), '.local/\n');
    expect(spawnSync('git', ['add', '.'], { cwd: root }).status).toBe(0);
    expect(spawnSync('git', ['commit', '-m', 'Synthetic history'], { cwd: root, env: { ...process.env, GIT_AUTHOR_NAME: 'Example', GIT_AUTHOR_EMAIL: 'public@example.invalid', GIT_COMMITTER_NAME: 'GitHub', GIT_COMMITTER_EMAIL: 'noreply@github.com' } }).status).toBe(0);
    const scan = () => spawnSync(process.execPath, ['scripts/history-check.mjs'], { cwd: root, encoding: 'utf8' });
    expect(scan().status).toBe(1);
    const policy = join(root, '.local', 'confirmed-public-identities.json');
    writeFileSync(policy, JSON.stringify([{ email: 'public@example.invalid', source: 'agent-reviewed', confirmedAt: '2026-01-01T00:00:00Z' }]));
    expect(scan().status).toBe(1);
    writeFileSync(policy, JSON.stringify([{ email: 'other@example.invalid', source: 'user-confirmed', confirmedAt: '2026-01-01T00:00:00Z' }]));
    expect(scan().status).toBe(1);
    writeFileSync(policy, JSON.stringify([{ email: 'public@example.invalid', source: 'user-confirmed', confirmedAt: '2026-01-01T00:00:00Z' }]));
    expect(scan().status).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
it('rejects ordinary named reports and custom storage paths even without secrets', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-ops-paths-')); const file = resolve('synthetic-report.md'); const registry = join(dir, 'paths.json');
  try {
    writeFileSync(file, 'Synthetic personal report without tokens.'); registerPrivatePaths([file, resolve('custom-store')], registry);
    const result = spawnSync(process.execPath, ['scripts/public-check.mjs', '--paths-file', registry], { encoding: 'utf8' });
    expect(result.status).toBe(1); expect(result.stderr).toContain('Local-only data entered public manifest: synthetic-report.md');
  } finally { rmSync(file, { force: true }); rmSync(dir, { recursive: true, force: true }); }
});

it('scans an archive inside an ignored directory of an ancestor Git checkout', () => {
  const root = mkdtempSync(join(tmpdir(), 'pr-ops-ancestor-')); const archive = join(root, 'ignored', 'archive');
  try {
    expect(spawnSync('git', ['init', root]).status).toBe(0);
    writeFileSync(join(root, '.gitignore'), 'ignored/\n'); mkdirSync(join(archive, 'scripts'), { recursive: true });
    cpSync('scripts/public-check.mjs', join(archive, 'scripts', 'public-check.mjs'));
    const report = join(archive, 'ordinary-report.md'); writeFileSync(report, 'Synthetic local-only evidence.');
    const registry = join(root, 'paths.json'); registerPrivatePaths([report], registry);
    const result = spawnSync(process.execPath, ['scripts/public-check.mjs', '--paths-file', registry], { cwd: archive, encoding: 'utf8' });
    expect(result.status).toBe(1); expect(result.stderr).toContain('Local-only data entered public manifest: ordinary-report.md');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

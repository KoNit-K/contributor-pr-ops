import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
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

it('runs every local read command in a network-denied child process with empty scope coverage', () => {
  const root = mkdtempSync(join(tmpdir(), 'pr-ops-offline-'));
  const config = join(root, 'config/local.yaml');
  const invoke = (args: string[]) => spawnSync(process.execPath, ['--require', './tests/network-deny.cjs', 'dist/cli.js', '--json', '--config', config, ...args], { encoding: 'utf8', env: { ...process.env, GH_TOKEN: '', GITHUB_TOKEN: '', CONTRIBUTOR_PR_OPS_TOKEN: '' } });
  try {
    expect(invoke(['init']).status).toBe(0);
    expect(invoke(['doctor']).status).toBe(0);
    for (const command of ['status', 'maintenance', 'contributions', 'report']) {
      const result = invoke([command]); expect(result.status).toBe(4); expect(JSON.parse(result.stdout).status).toBe('PARTIAL');
      if (command === 'report') {
        const report = readFileSync(JSON.parse(result.stdout).report, 'utf8');
        expect(report).toContain('贡献基线尚未完成'); expect(report).not.toContain('```json');
      }
    }
    expect(invoke(['progress']).status).toBe(0); expect(JSON.parse(invoke(['progress', '--watch']).stdout).active).toBe(false);
    expect(invoke(['rate']).status).toBe(0); expect(invoke(['pr', '1']).status).toBe(4);
    const textReport = invoke(['report', '--format', 'text']);
    expect(textReport.status).toBe(4);
    expect(readFileSync(JSON.parse(textReport.stdout).report, 'utf8')).toContain('类型数量（各类型按 PR 去重');
    const terminal = spawnSync(process.execPath, ['--require', './tests/network-deny.cjs', 'dist/cli.js', '--config', config, 'maintenance'], { encoding: 'utf8' });
    expect(terminal.status).toBe(4); expect(terminal.stdout).toContain('Open PR 核查'); expect(terminal.stdout).not.toContain('"status"');
    expect(invoke(['report', '--format', 'unsupported']).status).toBe(2);
    const detailed = invoke(['report', '--details', '--output', join(root, 'details.md')]);
    expect(detailed.status).toBe(4); expect(readFileSync(JSON.parse(detailed.stdout).report, 'utf8')).toContain('## 逐项证据详情');
    expect(invoke(['sync', '--limit', '0']).status).toBe(2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('persists a specific agent-reviewed acknowledgment and invalidates it after evidence edits', async () => {
  const { Store } = await import('../src/store.js'); const { loadConfig } = await import('../src/config.js'); const { snapshot, feedback } = await import('./helpers.js');
  const root = mkdtempSync(join(tmpdir(), 'pr-ops-ack-')); const path = join(root, 'config/local.yaml');
  const invoke = (args: string[]) => spawnSync(process.execPath, ['--require', './tests/network-deny.cjs', 'dist/cli.js', '--config', path, '--json', ...args], { encoding: 'utf8' });
  try {
    expect(invoke(['init']).status).toBe(0); const c = loadConfig(path); const db = new Store(join(c.storage.directory, 'ops.sqlite'), c.scope);
    const s = snapshot({ feedback: [feedback()], observedAt: new Date().toISOString() }); db.set('index', '1', s.pr); db.saveSnapshot(s); db.set('attempt-status', '1', { status: 'SUCCESS' }); db.close();
    const ack = invoke(['acknowledge', '1', '--subject', 'feedback:feedback-1', '--disposition', 'NON_BLOCKING', '--rationale', 'Specific suggestion is optional', '--evidence', s.feedback[0]!.url, '--source', 'agent-reviewed']);
    expect(ack.status).toBe(0); expect(JSON.parse(ack.stdout).confirmation.source).toBe('agent-reviewed');
    expect(JSON.parse(invoke(['pr', '1']).stdout).decision.state).toBe('NO_ACTION');
    const maintenance = JSON.parse(invoke(['maintenance']).stdout);
    expect(maintenance.summary.noAction.map((item: { number: number }) => item.number)).toEqual([1]);
    expect(maintenance.summary.actionRequired).toEqual([]);
    const next = new Store(join(c.storage.directory, 'ops.sqlite'), c.scope); next.saveSnapshot(snapshot({ ...s, feedback: [feedback('feedback-1', { body: 'Changed request' })] })); next.close();
    expect(JSON.parse(invoke(['pr', '1']).stdout).decision.state).toBe('THIRD_PARTY_FEEDBACK');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('keeps final JSON clean and allows disabling stderr progress on an authentication failure', async () => {
  const { parse, stringify } = await import('yaml');
  const root = mkdtempSync(join(tmpdir(), 'pr-ops-progress-cli-')); const config = join(root, 'config/local.yaml');
  const invoke = (args: string[]) => spawnSync(process.execPath, ['--require', './tests/network-deny.cjs', 'dist/cli.js', '--config', config, ...args], { encoding: 'utf8', env: { ...process.env, CONTRIBUTOR_PR_OPS_TEST_MISSING: '' } });
  try {
    expect(invoke(['init']).status).toBe(0);
    const value = parse(readFileSync(config, 'utf8')); value.auth.method = 'env'; value.auth.token_env = 'CONTRIBUTOR_PR_OPS_TEST_MISSING'; writeFileSync(config, stringify(value));
    const json = invoke(['--json', 'sync']); expect(json.status).toBe(2); expect(JSON.parse(json.stdout).code).toBe('AUTH_MISSING'); expect(json.stderr).not.toContain('[同步]');
    const silent = invoke(['sync', '--no-progress']); expect(silent.status).toBe(2); expect(silent.stderr).not.toContain('[同步]');
    const visible = invoke(['sync']); expect(visible.status).toBe(2); expect(visible.stderr).toContain('[同步]'); expect(visible.stdout).not.toContain('[同步]');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

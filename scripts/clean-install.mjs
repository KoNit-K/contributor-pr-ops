import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, cpSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

const root = mkdtempSync(join(tmpdir(), 'pr-ops-install-'));
const hash = data => createHash('sha256').update(data).digest('hex');
const execute = (file, args, cwd = root) => execFileSync(file, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
try {
  execute(process.execPath, ['scripts/public-check.mjs'], process.cwd());
  const files = execute('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], process.cwd()).split('\0').filter(Boolean);
  if (process.argv.includes('--commit')) {
    const dirty = execute('git', ['status', '--porcelain'], process.cwd());
    if (dirty.trim()) throw new Error('Exact-commit installation requires a clean working tree.');
    const archive = join(root, 'source.tar');
    execute('git', ['archive', '--format=tar', '-o', archive, 'HEAD'], process.cwd());
    execute('tar', ['-xf', archive]);
    rmSync(archive);
  } else {
    for (const file of files) { mkdirSync(dirname(join(root, file)), { recursive: true }); cpSync(file, join(root, file)); }
  }
  const before = hash(readFileSync(join(root, 'package-lock.json')));
  const npm = process.env.npm_execpath;
  if (!npm) throw new Error('Run through npm run acceptance so npm resolves consistently.');
  execute(process.execPath, [npm, 'ci', '--no-audit', '--no-fund']);
  execute(process.execPath, [npm, 'run', 'build']);
  execute(process.execPath, ['dist/cli.js', '--help']);
  execute(process.execPath, ['dist/cli.js', 'init']);
  execute(process.execPath, ['dist/cli.js', '--json', 'doctor']);
  execute(process.execPath, ['--input-type=module', '-e', "import { DatabaseSync as D } from 'node:sqlite'; const d=new D(':memory:'); if(d.prepare('select 42 as n').get().n!==42) throw new Error('SQLite smoke failed'); d.close();"]);
  execute('git', ['--version']);
  if (hash(readFileSync(join(root, 'package-lock.json'))) !== before) throw new Error('npm ci modified the lockfile.');
  console.log(`Clean source installation and CLI/SQLite/Git smoke passed; lock SHA-256 ${before}. Source: ${process.argv.includes('--commit') ? 'HEAD' : 'current public manifest'}.`);
} catch (error) {
  console.error('Clean-install acceptance failed; no installation PASS is recorded.');
  // npm command output may contain user-specific registry configuration. Print only the safe error class/code.
  console.error(error.code ?? error.name ?? 'INSTALL_FAILED');
  process.exitCode = 1;
} finally { rmSync(root, { recursive: true, force: true }); }

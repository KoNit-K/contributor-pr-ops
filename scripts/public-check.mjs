import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, lstatSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

const excluded = new Set(['.git', '.local', '.superpowers', 'node_modules', 'dist', 'coverage', 'reports']);
const walk = (dir = '.') => readdirSync(dir, { withFileTypes: true }).flatMap(e => excluded.has(e.name) ? [] : e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name).replace(/^\.\//, '')]);
let files;
try {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  if (resolve(root) !== resolve('.')) throw new Error('Archive is not a Git checkout root.');
  files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().split('\0').filter(Boolean);
}
catch { files = walk(); }
const forbidden = /(?:^|\/)(?:\.local|\.superpowers|node_modules|dist|coverage|reports)(?:\/|$)|(?:^|\/)(?:LOCAL_ONLY_[^/]*|local[^/]*\.ya?ml|id_rsa[^/]*|id_ed25519[^/]*|\.env(?:\..*)?)$|\.(?:db|sqlite)(?:-.*)?$|\.(?:pem|key|log)$/;
const secrets = [/gh[pousr]_[A-Za-z0-9]{20,}/, /github_pat_[A-Za-z0-9_]{30,}/, /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/];
const denylist = existsSync('.local/private-values.json') ? JSON.parse(readFileSync('.local/private-values.json', 'utf8')) : [];
const registryPath = process.argv.includes('--paths-file') ? process.argv[process.argv.indexOf('--paths-file') + 1] : '.local/private-paths.json';
const canonicalPath = path => existsSync(path) ? realpathSync(path) : resolve(path);
const privatePaths = (existsSync(registryPath) ? JSON.parse(readFileSync(registryPath, 'utf8')) : []).map(canonicalPath);
let failures = 0;
for (const file of files) {
  if (privatePaths.some(path => canonicalPath(file) === path || canonicalPath(file).startsWith(path + sep))) { console.error(`Local-only data entered public manifest: ${file}`); failures++; continue; }
  if ((forbidden.test(file) && file !== '.env.example') || lstatSync(file).isSymbolicLink()) { console.error(`Forbidden public path: ${file}`); failures++; continue; }
  const content = readFileSync(file, 'utf8');
  if (secrets.some(p => p.test(content)) || denylist.some(value => value && content.includes(value))) { console.error(`Potential confidential content: ${file}`); failures++; }
}
if (failures) process.exitCode = 1;
else console.log(`Public path/content checks passed for ${files.length} files. Full-history Gitleaks remains a separate release gate.`);

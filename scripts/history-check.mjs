import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
const git = args => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 });
const forbidden = /(?:^|\/)(?:\.local|node_modules|dist|coverage|reports)(?:\/|$)|(?:^|\/)(?:local[^/]*\.ya?ml|id_rsa[^/]*|id_ed25519[^/]*|\.env(?:\..*)?)$|\.(?:db|sqlite)(?:-.*)?$|\.(?:pem|key|log)$/;
const patterns = [/gh[pousr]_[A-Za-z0-9]{20,}/, /github_pat_[A-Za-z0-9_]{30,}/, /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/];
const deny = existsSync('.local/private-values.json') ? JSON.parse(readFileSync('.local/private-values.json', 'utf8')) : [];
const privatePaths = existsSync('.local/private-paths.json') ? JSON.parse(readFileSync('.local/private-paths.json', 'utf8')) : [];
let errors = 0; let blobs = 0;
for (const line of git(['rev-list', '--objects', '--all']).trim().split('\n')) {
  const space = line.indexOf(' '); if (space < 0) continue;
  const id = line.slice(0, space), path = line.slice(space + 1);
  if (git(['cat-file', '-t', id]).trim() !== 'blob') continue;
  blobs++;
  const value = git(['cat-file', 'blob', id]);
  if ((forbidden.test(path) && path !== '.env.example') || privatePaths.some(item => resolve(path) === resolve(item) || resolve(path).startsWith(resolve(item) + sep)) || patterns.some(pattern => pattern.test(value)) || deny.some(item => item && value.includes(item))) { console.error(`History privacy finding in blob ${id} at ${path}`); errors++; }
}
const emails = git(['log', '--all', '--format=%ae%n%ce']).trim().split('\n').filter(Boolean);
if (emails.some(email => !email.endsWith('@users.noreply.github.com'))) { console.error('History includes an unverified non-noreply identity; inspect locally.'); errors++; }
if (errors) process.exitCode = 1;
else console.log(`Supplemental full-history path/content/identity scan passed for ${blobs} blobs. This does not substitute for Gitleaks.`);

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
const git = args => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 });
const forbidden = /(?:^|\/)(?:\.local|node_modules|dist|coverage|reports)(?:\/|$)|(?:^|\/)(?:local[^/]*\.ya?ml|id_rsa[^/]*|id_ed25519[^/]*|\.env(?:\..*)?)$|\.(?:db|sqlite)(?:-.*)?$|\.(?:pem|key|log)$/;
const patterns = [/gh[pousr]_[A-Za-z0-9]{20,}/, /github_pat_[A-Za-z0-9_]{30,}/, /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/];
const deny = existsSync('.local/private-values.json') ? JSON.parse(readFileSync('.local/private-values.json', 'utf8')) : [];
const privatePaths = existsSync('.local/private-paths.json') ? JSON.parse(readFileSync('.local/private-paths.json', 'utf8')) : [];
// Personal identity confirmations stay local; public source contains no personal emails.
const identityFile = '.local/confirmed-public-identities.json';
const identities = existsSync(identityFile) ? JSON.parse(readFileSync(identityFile, 'utf8')) : [];
if (!Array.isArray(identities) || identities.some(item => !item || typeof item.email !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(item.email) || item.source !== 'user-confirmed' || typeof item.confirmedAt !== 'string' || !Number.isFinite(Date.parse(item.confirmedAt)))) {
  console.error('Invalid local public-identity confirmations; explicit user confirmation is required.'); process.exit(1);
}
const confirmedEmails = new Set(identities.map(item => item.email));
let errors = 0; let blobs = 0;
const contents = new Map();
const commits = git(['rev-list', '--all']).trim().split('\n').filter(Boolean);
let paths = 0;
for (const commit of commits) {
  for (const entry of git(['ls-tree', '-r', '-z', '--full-tree', commit]).split('\0').filter(Boolean)) {
    const tab = entry.indexOf('\t'); const path = entry.slice(tab + 1); const [mode, type, id] = entry.slice(0, tab).split(' ');
    paths++;
    if ((forbidden.test(path) && path !== '.env.example') || mode === '120000' || privatePaths.some(item => resolve(path) === resolve(item) || resolve(path).startsWith(resolve(item) + sep))) { console.error(`Historical path/mode finding at ${commit}:${path}`); errors++; }
    if (type !== 'blob' || contents.has(id)) continue;
    const value = git(['cat-file', 'blob', id]); contents.set(id, true); blobs++;
    if (patterns.some(pattern => pattern.test(value)) || deny.some(item => item && value.includes(item))) { console.error(`History privacy finding in blob ${id} at ${path}`); errors++; }
  }
}
const messages = git(['log', '--all', '--format=%B']);
if (patterns.some(pattern => pattern.test(messages)) || deny.some(item => item && messages.includes(item))) { console.error('Potential confidential content in commit messages; inspect locally.'); errors++; }
const emails = git(['log', '--all', '--format=%ae%n%ce']).trim().split('\n').filter(Boolean);
if (emails.some(email => !email.endsWith('@users.noreply.github.com') && email !== 'noreply@github.com' && !confirmedEmails.has(email))) { console.error('History includes an unverified non-noreply identity; inspect locally.'); errors++; }
if (errors) process.exitCode = 1;
else console.log(`Supplemental full-history path/content/identity scan passed for ${blobs} unique blobs and ${paths} tree paths, including symlink modes and commit messages. This does not substitute for Gitleaks.`);

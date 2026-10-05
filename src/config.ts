import { copyFileSync, constants, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { OpsError } from './errors.js';

const login = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/);
const schema = z.strictObject({
  schema_version: z.literal(1),
  auth: z.strictObject({ method: z.enum(['gh', 'env']), account: login, token_env: z.string().regex(/^[A-Z_][A-Z0-9_]*$/) }),
  target: z.strictObject({ repository: z.string().regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/), author: login, branch: z.string().min(1).refine(v => !v.startsWith('-') && !/[\s~^:?*\[\\\x00-\x1f]/.test(v) && !v.includes('..') && !v.includes('@{'), 'Invalid branch') }),
  rate_limit: z.strictObject({ quota_fraction: z.number().gt(0).lte(1), min_interval_ms: z.number().int().min(0), max_retries: z.number().int().min(0).max(2) }),
  maintenance: z.strictObject({ excluded_prs: z.array(z.number().int().positive()), excluded_labels: z.array(z.string()), maintainer_overrides: z.array(login) }),
  git: z.strictObject({ checkout_path: z.string().min(1).nullable() }),
  attribution: z.strictObject({ verified_author_emails: z.array(z.string().email()) }),
  storage: z.strictObject({ directory: z.string().min(1) }),
  reporting: z.strictObject({ timezone: z.string().refine(value => { try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; } }, 'Invalid timezone') }),
});

export type Config = z.infer<typeof schema> & { configPath: string; scope: string };

export function initialize(path: string): void {
  const absolute = resolve(path);
  mkdirSync(dirname(absolute), { recursive: true });
  try {
    copyFileSync(fileURLToPath(new URL('../config/example.yaml', import.meta.url)), absolute, constants.COPYFILE_EXCL);
  } catch (error) {
    if (existsSync(absolute)) throw new OpsError('Configuration already exists; it was not replaced.', 'CONFIG_ERROR', 'CONFIG_EXISTS');
    throw error;
  }
}

export function loadConfig(path: string): Config {
  const absolute = resolve(path);
  if (!existsSync(absolute)) throw new OpsError('Configuration file not found. Run pr-ops init.', 'CONFIG_ERROR', 'CONFIG_MISSING');
  let result: z.infer<typeof schema>;
  try { result = schema.parse(parse(readFileSync(absolute, 'utf8'), { maxAliasCount: 0 })); }
  catch { throw new OpsError('Invalid configuration. Check the documented schema; credentials belong only in authentication.', 'CONFIG_ERROR', 'CONFIG_INVALID'); }
  const relative = (value: string) => isAbsolute(value) ? value : resolve(dirname(absolute), value);
  result.storage.directory = relative(result.storage.directory);
  if (result.git.checkout_path) result.git.checkout_path = relative(result.git.checkout_path);
  return { ...result, configPath: absolute, scope: createHash('sha256').update(JSON.stringify([result.target.repository.toLowerCase(), result.target.author.toLowerCase(), result.target.branch])).digest('hex').slice(0, 24) };
}

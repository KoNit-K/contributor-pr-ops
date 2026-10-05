import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Local-only paths are registered independently of their names or serialized contents.
export function registerPrivatePaths(paths: string[], registry = fileURLToPath(new URL('../.local/private-paths.json', import.meta.url))): void {
  mkdirSync(dirname(registry), { recursive: true, mode: 0o700 });
  const previous: string[] = existsSync(registry) ? JSON.parse(readFileSync(registry, 'utf8')) : [];
  writeFileSync(registry, JSON.stringify([...new Set([...previous, ...paths.map(path => resolve(path))])]), { mode: 0o600 });
}

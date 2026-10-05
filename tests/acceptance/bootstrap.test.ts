import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { loadConfig } from '../../src/config.js';

it('A01/A13 generic sample is valid and selected Node declarations agree', () => {
  const config = loadConfig('config/example.yaml');
  expect(config.target.repository).toBe('example-org/example-repo');
  expect(config.target.author).toBe('example-contributor');
  expect(config.reporting.timezone).toBe('UTC');
  expect(readFileSync('.nvmrc', 'utf8').trim()).toBe('24.20.0');
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
  expect(packageJson.private).toBe(true);
  expect(packageJson.packageManager).toBe('npm@11.19.0');
});
it('A13 real SQLite runs in the reference environment', () => {
  const db = new Database(':memory:');
  try { expect(db.prepare('select 42 as n').get()).toEqual({ n: 42 }); }
  finally { db.close(); }
});

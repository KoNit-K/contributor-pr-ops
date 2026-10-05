import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const files = dir => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]);
let failures = 0;
for (const file of files('src').filter(p => p.endsWith('.ts'))) {
  const text = readFileSync(file, 'utf8');
  for (const [rule, pattern] of [
    ['dynamic code execution', /\b(?:eval|new Function)\s*\(/],
    ['shell execution', /\bexecSync\s*\(|shell:\s*true/],
    ['type checking bypass', /@ts-(?:ignore|nocheck)/],
    ['console output outside CLI', /console\.(?:log|error|warn)\(/],
  ]) {
    if (rule === 'console output outside CLI' && file.endsWith('/cli.ts')) continue;
    if (pattern.test(text)) { console.error(`${file}: ${rule}`); failures++; }
  }
}
if (failures) process.exitCode = 1;
else console.log('Static safety checks passed; TypeScript checks unused code and types separately.');

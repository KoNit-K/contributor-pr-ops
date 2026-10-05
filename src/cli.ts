#!/usr/bin/env node
import { Command } from 'commander';
import { initialize, loadConfig } from './config.js';
import { exitCodes, safeError } from './errors.js';

const program = new Command().name('pr-ops').description('Local, read-only contributor PR operations').version('0.1.0')
  .option('--config <path>', 'Configuration file', 'config/local.yaml').option('--json', 'Structured JSON output');

function output(value: object): void { console.log(JSON.stringify(value, null, 2)); }
program.command('init').description('Create generic configuration offline without overwriting').action(() => {
  initialize(program.opts().config);
  output({ status: 'SUCCESS', message: 'Generic configuration created. Edit it before synchronizing.' });
});
program.command('doctor').description('Check local configuration without accessing GitHub').action(() => {
  const config = loadConfig(program.opts().config);
  output({ status: 'SUCCESS', node: process.version, configuration: 'valid', scope: config.scope, network: 'not requested' });
});

try { await program.parseAsync(); }
catch (error) { const result = safeError(error); output(result); process.exitCode = exitCodes[result.status]; }

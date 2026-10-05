#!/usr/bin/env node
import { Command, CommanderError, InvalidArgumentError } from 'commander';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { initialize, loadConfig, type Config } from './config.js';
import { exitCodes, OpsError, safeError } from './errors.js';
import { Store, acquireLock } from './store.js';
import { localView, markdown, safeText } from './views.js';
import { checkOnline, clientFor, synchronize } from './sync.js';
import { createConfirmation } from './maintenance.js';
import { registerPrivatePaths } from './privacy.js';
import type { Confirmation, Disposition } from './model.js';

const program = new Command().name('pr-ops').description('Local, read-only contributor PR operations').version('0.1.0')
  .option('--config <path>', 'Configuration file', 'config/local.yaml').option('--json', 'Structured JSON output');
program.exitOverride().configureOutput({ writeErr() {} });
const positive = (value: string) => { if (!/^\d+$/.test(value) || Number(value) < 1 || !Number.isSafeInteger(Number(value))) throw new InvalidArgumentError('Expected a positive integer.'); return Number(value); };
function output(value: object): void {
  const cleaned = JSON.parse(JSON.stringify(value, (_key, item: unknown) => typeof item === 'string' ? safeText(item) : item));
  console.log(program.opts().json ? JSON.stringify(cleaned, null, 2) : `${cleaned.status ?? 'Local evidence'}\n${JSON.stringify(cleaned, null, 2)}`);
  const status = (value as { status?: keyof typeof exitCodes }).status; if (status) process.exitCode = exitCodes[status];
}
async function database(work: (config: Config, db: Store) => unknown | Promise<unknown>) {
  const config = loadConfig(program.opts().config); registerPrivatePaths([config.configPath, config.storage.directory]); const db = new Store(join(config.storage.directory, 'ops.sqlite'), config.scope);
  try { await work(config, db); } finally { db.close(); }
}
program.command('init').description('Create generic configuration offline without overwriting').action(() => {
  initialize(program.opts().config); registerPrivatePaths([program.opts().config]); output({ status: 'SUCCESS', message: 'Generic configuration created. Edit it before synchronizing.' });
});
program.command('doctor').description('Check configuration locally; online checks require --online').option('--online').action(async options => {
  const config = loadConfig(program.opts().config); registerPrivatePaths([config.configPath, config.storage.directory]);
  if (!options.online) { output({ status: 'SUCCESS', node: process.version, configuration: 'valid', scope: config.scope, network: 'not requested', sqlite: 'Node built-in release candidate API' }); return; }
  await database(async (c, db) => { const unlock = acquireLock(c.storage.directory); try { const client = clientFor(c, db); const viewer = await checkOnline(client, c); output({ status: 'SUCCESS', viewer, requests: client.counts() }); } finally { unlock(); } });
});
program.command('sync').description('Explicit read-only GitHub collection and controlled Git analysis').option('--resume').option('--limit <number>', 'Limit ordinary open PR collection for a small pilot', positive).action(async options => database(async (c, db) => output(await synchronize(c, db, { resume: !!options.resume, limit: options.limit }))));
for (const name of ['status', 'maintenance', 'contributions']) program.command(name).description('Read local evidence without network requests').action(async () => database((c, db) => {
  const view = localView(c, db);
  if (name === 'maintenance') output({ status: view.status, coverage: view.coverage, items: view.prs.filter(p => p.pr.state === 'OPEN' && !p.excluded).map(p => ({ number: p.pr.number, decision: p.decision, latestAttempt: p.latestAttempt })), gaps: view.gaps });
  else if (name === 'contributions') output({ status: view.status, lifecycle: view.lifecycle, history: view.contributions, changes: view.changes, attempt: view.contributionAttempt, gaps: view.gaps });
  else output(view);
}));
program.command('pr').description('Inspect a local PR and exact feedback subjects').argument('<number>', 'PR number', positive).action(async number => database((c, db) => {
  const view = localView(c, db); const item = view.prs.find(p => p.pr.number === number);
  if (!item) throw new OpsError('PR has not been indexed in this local scope.', 'PARTIAL', 'PR_NOT_COLLECTED');
  output({ status: item.snapshot?.complete && item.decision?.coverage !== 'UNCHECKED' && item.latestAttempt?.status === 'SUCCESS' ? 'SUCCESS' : 'PARTIAL', ...item });
}));
program.command('acknowledge').description('Record an evidence-bound local disposition; never write GitHub').argument('<number>', 'PR number', positive)
  .requiredOption('--subject <id>', 'pr, feedback:<id>, relation:<id> or check:<id>').requiredOption('--disposition <value>', 'Local disposition')
  .requiredOption('--rationale <text>', 'What was verified').requiredOption('--evidence <url...>', 'Exact safe GitHub source links')
  .requiredOption('--source <value>', 'user-confirmed or agent-reviewed; accurately identify the reviewer')
  .action(async (number, options) => database((c, db) => {
    const dispositions: Disposition[] = ['READ', 'TODO', 'WAIT_REVIEWER', 'NO_ACTION', 'NON_BLOCKING', 'CLOSE_CONFIRMED', 'FULL_COVERAGE', 'MAINTAINER_EDITED'];
    if (!dispositions.includes(options.disposition) || !['user-confirmed', 'agent-reviewed'].includes(options.source)) throw new OpsError('Invalid disposition or confirmation source.', 'CONFIG_ERROR', 'CONFIRMATION_INVALID');
    const unlock = acquireLock(c.storage.directory);
    try {
      const item = localView(c, db).prs.find(p => p.pr.number === number); if (!item?.snapshot) throw new OpsError('Required PR evidence is not available locally.', 'PARTIAL', 'PR_NOT_COLLECTED');
      const confirmation = createConfirmation(item.snapshot, options.subject, options.disposition, options.rationale, options.evidence, options.source as Confirmation['source']);
      db.set('confirmation', `${number}:${options.subject}`, confirmation); output({ status: 'SUCCESS', confirmation });
    } finally { unlock(); }
  }));
program.command('rate').description('Read persisted quota windows offline').action(async () => database((c, db) => output({ status: 'SUCCESS', account: c.auth.account, core: db.getWindow(`${c.auth.account.toLowerCase()}:core`) ?? null, graphql: db.getWindow(`${c.auth.account.toLowerCase()}:graphql`) ?? null, pacing: db.getWindow(`${c.auth.account.toLowerCase()}:pacing`) ?? null })));
program.command('report').description('Write a local Markdown report without fetching').option('--output <path>', 'Local destination').action(async options => database((c, db) => {
  const path = options.output ? resolve(options.output) : join(c.storage.directory, 'reports', 'report.md'); mkdirSync(resolve(path, '..'), { recursive: true, mode: 0o700 });
  registerPrivatePaths([path]); const view = localView(c, db); writeFileSync(path, markdown(view), { mode: 0o600 }); output({ status: view.status, report: path, coverage: view.coverage, gaps: view.gaps });
}));
try { await program.parseAsync(); }
catch (error) {
  if (!(error instanceof CommanderError && error.exitCode === 0)) {
    const result = error instanceof CommanderError ? safeError(new OpsError('Invalid command arguments. See --help.', 'CONFIG_ERROR', 'ARGUMENT_INVALID')) : safeError(error);
    output(result);
  }
}

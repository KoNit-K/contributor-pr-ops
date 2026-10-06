# Contributor PR Ops

Local, read-only contributor pull request maintenance and contribution evidence.
A TypeScript CLI that runs without agents, models, or MCP.

## Development status

This is an unreleased implementation. A release requires all gates in
[DESIGN_V1](docs/DESIGN_V1.md) and [ACCEPTANCE_V1](docs/ACCEPTANCE_V1.md).
No successful real-target validation or published version is claimed by this document.

## Reference environment and installation

Reference: Node **24.20.0** (LTS), npm **11.19.0**. `.nvmrc` is the single Node
selection file. Node 24 and npm 11 compatible patches are accepted. Git is required
for contribution analysis. `gh` is required only for gh authentication or project
publishing; environment-token authentication and offline operations do not require it.

```sh
npm ci
npm run build
node dist/cli.js --help
node dist/cli.js init
```

Edit `config/local.yaml` using the one generic sample. Configuration-relative paths
are resolved from the configuration file directory. The authenticated account can
differ from the contribution author. Credentials are never configuration values.
The sample uses `auth.method: env` with
`CONTRIBUTOR_PR_OPS_READER_TOKEN`. Set `auth.account` to the fixed reader and
`target.author` to the contributor being maintained. Supply the selected token
only in the collecting shell; it is explicitly passed to this client's requests.
The environment path never invokes `gh`, falls back to its credentials, or changes
`GH_TOKEN`, `GITHUB_TOKEN`, browser sessions, Git credentials or global settings.
Missing credentials or a mismatched reader stop before PR collection. Existing
`auth.method: gh` configurations remain supported without switching the active account.
An existing environment file may be explicitly sourced by the user; the application
does not search for environment files or credentials.

Primary quota records are keyed by the verified reader account, independently of
the target author. Changing tokens for the same reader does not create a new
budget. A different reader has separate quota records and must revalidate cached
permission-dependent evidence. This is a fixed reader configuration, with no
account rotation or combined quota pool. GitHub secondary restrictions still apply. Before identity confirmation, conservative
bootstrap charges are stored separately as unverified reservations. They survive
failed starts and token changes; only a successful identity match promotes them.
A shared bootstrap wait preserves server restrictions when the actual reader is
still unknown. These records contain only quota/timing numbers, never credentials.

`rate` reads both REST and GraphQL budgets offline. `budgets.core` and
`budgets.graphql` show `used`, `projectRemaining`, `serverRemaining`,
`projectResetAt`, `serverResetAt`, and `lastResetAt` (timestamps in milliseconds).
The project deadline is fixed within a window even when server responses disagree.
After expiry the single client confirms a future window with `/rate_limit` before
another business request. Only then is old project usage cleared; a first charged
response is counted in the new window. Server-directed waits survive rollover.
An unavailable or stale confirmation pauses/fails the round and preserves its
checkpoint. Legacy records retain their conservative budget until an expired
window is confirmed. Online diagnostic and sync results include reader, target
and both budgets; `quotaWaitMs` remains the compatible project-budget spacing counter.

SQLite uses the Node 24 built-in `node:sqlite` module, with extensions disabled.
Node labels this API **release candidate (stability 1.2)**; this is a documented
runtime limitation. It avoids a separate native addon/toolchain. The initially
cached native addon failed an expanded test and was removed. macOS checks are
local; clean Linux CI remains a release gate.

## Verification

```sh
npm run verify
npm run acceptance
```

`verify` checks static safety, types, offline tests, build and intended public paths.
Full-history Gitleaks and real-target acceptance are additional release requirements.
See the acceptance specification for fixed expected results and evidence fields.

## Privacy

Real configuration and all operational data belong in ignored local storage.
The runtime does not modify scanned GitHub repositories or contribution branches.
This package is private to prevent accidental npm publication.

## Everyday commands

All commands accept `--config <path>`. Add `--json` for machine-readable output.
Reading local data never fetches or calls GitHub; only `sync` and `doctor --online`
are online. A partial database remains explicitly partial.

```sh
node dist/cli.js doctor
node dist/cli.js doctor --online
node dist/cli.js sync --limit 5
node dist/cli.js sync
node dist/cli.js sync --resume
node dist/cli.js status
node dist/cli.js maintenance
node dist/cli.js contributions
node dist/cli.js pr 123
node dist/cli.js rate
node dist/cli.js report
node dist/cli.js report --format text
```

`maintenance` prints issue groups with PR titles, reasons and source URLs. Counts
within each group deduplicate PRs; one PR may appear in several groups. The
overall pending total is a separate deduplicated union. No-action and unverified
evidence have separate summaries. `maintenance --json` preserves structured
findings and includes the same groups. `report --format text` saves this readable
terminal format locally; the default Markdown report uses the same issue groups.

`--limit` collects only the selected ordinary open PRs and returns partial status;
it does not claim a complete contribution baseline. By default, `sync` collects all
ordinary open PRs, including drafts, and skips closed/merged PR detail collection
and historical Git contribution analysis. The default author connection requests only Open PRs and saves its inventory
separately from the historical index. All connection pages are still read. Success in this mode applies
only to open PR collection; it is not a verified historical contribution baseline.
Use `sync --resume` to continue the open PR scope from a saved checkpoint.
Only explicit `sync --with-history` collects closed/merged details and analyzes
historical contributions. This optional historical synchronization indexes
all lifecycle records for the configured author, then filters the repository.
Excluded maintenance PRs stay in lifecycle and contribution counts. History
analysis fixes one main-branch object and records unknown/missing objects explicitly.
A configured `git.checkout_path` is only read, never fetched or changed. Otherwise
sync uses an application-owned bare repository, with no checkout or code execution.
Public Git fetches are anonymous and do not require credential helpers.

Use `pr` to obtain the exact subject ID and evidence URL. A local disposition is
specific to that evidence version and head; it does not resolve a GitHub thread:

```sh
node dist/cli.js acknowledge 123 \
  --subject feedback:COMMENT_ID --disposition WAIT_REVIEWER \
  --rationale 'Verified this specific fix at the current head' \
  --evidence https://github.com/example-org/example-repo/pull/123#issuecomment-123 \
  --source user-confirmed
```

Use `agent-reviewed` when a development agent did the verification. Do not register
agent verification as user approval. `FULL_COVERAGE` additionally requires a fresh,
verified upstream SHA; upstream changes invalidate it. `CLOSE_CONFIRMED` requires
an exact source-discussion link with a verified decision author, rather than the
account that merely created a cross-reference. Neither disposition closes a PR.

Exit codes: success **0**, failure **1**, configuration/arguments **2**, paused **3**,
partial **4**. Persistent server waits and quota windows survive restart. Resume
without increasing the configured quota. After a crash, a retained `sync.lock`
blocks writes: verify its recorded process has exited before manually removing it.

Reports are local Markdown. Custom storage/configuration/report paths are registered
in ignored local metadata, and public checks reject them regardless of filename.
Markdown reports use plain Chinese explanations and three separate summaries:
action or investigation required, no current action/waiting for review, and
unverified evidence. Reused evidence is classified by its findings, not by its
cache flag. Missing or stale evidence never enters the no-action group.
The default report is concise; `report --details` includes individual evidence,
configured local times and bounded source excerpts. Source titles remain
unchanged. JSON maintenance output includes the same category summary and retains
the full evidence for programmatic use.
A privacy check does not replace the required full-history Gitleaks release check.
The supplemental `npm run history-check` accepts GitHub noreply identities by
default. A different email requires an explicit user confirmation recorded only
in ignored `.local/confirmed-public-identities.json`: an array of records with
`email`, `source: "user-confirmed"`, and an ISO `confirmedAt` timestamp. Do not
commit this local identity file or infer consent from an existing public commit.

## Interpretation and limits

Natural-language feedback requires evidence-bound local review. Member/collaborator
association alone does not establish maintainer decision authority. The rule engine
preserves pending feedback, current failing checks, partial coverage and identity
gaps; age and behind-main do not create work. Cached content remains valid for
24 hours after its content check; reuse does not extend that deadline. Quiet
content is rechecked at that boundary, while current checks and known
related-object metadata are read each sync. Changed PR evidence, authentication
identity or a failed collection still invalidates evidence before 24 hours.

Formal merged PRs, primary-author commits and coauthored commits are separate
metrics. Identity uses verified emails or GitHub commit-author attribution, never
Git names. Patch equivalence is distinct from exact objects and explicit cherry-pick
trailers, and does not establish provenance or current complete functional coverage.
An observed historical adoption/revert is not an automatic closure decision.

The first synchronization is a historical baseline. Later results distinguish
actual `mergedAt`, commit authored time and first observation; intervals are
reported as “since previous synchronization”. A non-fast-forward main update
requires reconciliation and does not generate negative daily contribution counts.

Release remains blocked until real read-only validation, clean Linux CI, complete
acceptance coverage, full-history secret scanning and exact-source archive
reproduction all pass. This README makes no claim of a published repository/release.

For networks that require an existing trusted proxy, set `HTTP_PROXY`,
`HTTPS_PROXY` and optionally `NO_PROXY` for the CLI process, together with
`NODE_USE_ENV_PROXY=1`. Explicit synchronization passes these standard proxy
variables to its controlled Git fetch. No global network configuration is changed.
Offline commands do not perform a fetch.

### Sync progress and timing

`sync` prints progress to stderr at stage changes and every ten seconds, including
current PR, processed/queued PRs, successful results, cache reuse, remaining work,
request attempts and cumulative network, minimum-spacing, quota-spacing and retry
wait times. Heartbeat timings include the elapsed part of the active wait or request; final
JSON timings measure completed operations. Network time includes the transport and its proxy/plugin
handling. Local processing time is not included in these four counters. A processed
percentage describes attempted work, not successful coverage; remaining work and
final status still identify incomplete results.

Use `sync --no-progress` to disable these lines. Global `--json` also disables them
and keeps stdout as one final JSON result; its `timings` values use milliseconds.
Minimum spacing is a floor: uniform quota pacing or a server-directed wait can be
longer. Each PR may require multiple requests and pages, so PR count is not request
count. This command does not increase concurrency or bypass saved limits.

To observe a sync already running in another terminal, use:

```sh
node dist/cli.js progress
node dist/cli.js progress --watch
```

The observer reads the local database and process lock without authentication,
network requests, storage migration or lock acquisition. It displays the saved queue
and current PR every ten seconds and exits when no live lock holder remains. A live PID alone does not establish the
operation identity; unverified stages are explicitly shown as unknown. Ctrl-C
stops only the observer. A remaining queue count is not a count of actionable PRs.
It cannot recover timing breakdowns from an older running executable. JSON watch
output is NDJSON (one complete object per line). No active sync is a successful
observation, not a declaration that saved work is complete.

### Request efficiency

A matching rate-limit response in the same window corrects the next request's
spacing using its actual cost, rather than retaining an overestimated reservation.
This preserves the configured minimum spacing, charged window usage and persisted
server-directed waits. Reservations bind to the fixed project window, so small
server reset timestamp differences do not prevent actual-cost correction. Unknown
costs, unmatched legacy reservations and cross-window responses stay conservative. Reducing `min_interval_ms` therefore does not override quota
pacing or server instructions.

During one sync, fully read related issues/PRs can be shared for up to sixty seconds
across PRs. All discussion pages must succeed before publishing a shared result.
The cache is isolated by scope, authentication account and object identity; each
PR retains its own cross-reference actor and time. Newer reference metadata, expiry,
explicit force or a new sync require fresh reads. A result whose discussion was
not refreshed cannot satisfy a later request requiring a full discussion refresh.
This short in-memory cache is separate from the twenty-four-hour PR content cache.

First reads are coalesced into bounded GraphQL batches: 20 metadata targets,
5 complete-detail targets (20 nodes per initial connection), and 20 final
metadata/check targets. Every remaining connection page is collected separately.
Shared related-object metadata uses batches of 20 and discussions batches of 5.
Network concurrency remains one. Alias-scoped errors leave only affected targets
incomplete; unlocatable errors invalidate the batch. Only explicit query-resource
errors trigger smaller batches, sharing three total attempts per target with retries.

`sync --refresh` forces selected content to be rechecked without clearing saved
snapshots, confirmations or quota windows. For a bounded comparison use
`sync --limit 5 --refresh`, then `sync --limit 5`. Both are partial-scope runs.
`metrics` reports batch attempts/target participations, supplemental pages (including
index continuation pages), downgrades and confirmed GraphQL cost. Cost completeness
is false if any GraphQL attempt lacks its actual cost. `refreshed`, `cached` and
`elapsedMs` report completed snapshot counts and wall time. Failed or incomplete
reads never replace the preceding successful snapshot.

### Interrupting a sync

Ctrl-C (`SIGINT`) and `SIGTERM` release the operation's own lock before exiting
with codes 130 and 143. Successfully saved snapshots, pagination checkpoints and
quota windows remain available to `sync --resume`; an interrupted in-flight read
may need repeating. Normal completion also removes its signal listeners.

Forced termination (`SIGKILL`), power loss or an older executable can leave a lock.
Use `progress` to inspect it and verify the recorded process has exited before
removing that stale lock. Never remove a live operation's lock. The application
retains the exclusive-lock check and does not automatically steal unknown locks.

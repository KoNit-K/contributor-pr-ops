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
For `auth.method: env`, set the variable named by `auth.token_env` in your local shell.
An existing environment file may be explicitly sourced by the user; the application
does not search for environment files or credentials.

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
and historical Git contribution analysis. The author index still enumerates all
lifecycle records to identify the current open set. Success in this mode applies
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
gaps; age and behind-main do not create work. Quiet content is rechecked every six
hours, while current checks and known related-object metadata are read each sync.

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

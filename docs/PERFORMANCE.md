# Complete collection performance

The CLI retains full evidence collection and deterministic maintenance rules. It
batches first reads to reduce round trips; it does not sample away feedback or
increase network concurrency.

## Reproducible synthetic gate

Run `npm run verify` and `npm run acceptance` on Node 24. The fixed dataset in
`tests/performance.test.ts` contains 500 Open PRs and 700 historical closed PRs.
All required evidence fits the initial connection pages; there are no relations,
errors or retries. Mock transport still goes through the production GitHub client,
rate gate, Open index, batching adapter, collector and SQLite snapshot path.

| Collection | Measured requests | Required maximum | Completed snapshots |
|---|---:|---:|---:|
| Cold | 157 | 160 | 500 |
| Valid content cache | 57 | 60 | 500 |

Cold breakdown: 2 authentication/quota requests, 5 Open index pages, 25 metadata
batches, 100 detail batches and 25 final batches. Warm collection omits the 100
detail batches. Maximum observed transport concurrency is one in both cases.
These are fixed low-complexity results, not a ceiling for arbitrary repositories.

`tests/batch-collection.test.ts` separately covers shared related objects with
complete discussion pagination, nested final-page failure and recovery, alias
errors, head changes, explicit content refresh, identity changes and the 24-hour
boundary. Stable 101-label metadata remains complete and reusable, while a
complete 100-label index cannot be mistaken for a truncated connection. Final
metadata comparison includes content even when the update timestamp is unchanged.
Existing maintenance fixtures use their independent expected outcomes.

## Runtime metrics

- `requests`: actual attempts by registered operation, including retries.
- `metrics.batchRequests`: actual batch attempts.
- `metrics.batchTargets`: summed target participations, including retries/splits.
- `metrics.supplementalPages`: single-connection continuation calls, including
  Open-index continuation pages; request retries remain visible in `requests`.
- `metrics.downgrades`: resource-error groups split into smaller batches.
- `metrics.confirmedGraphqlCost`: sum of actual reported GraphQL costs.
- `metrics.graphqlCostComplete`: false when any attempted GraphQL response lacks
  actual cost. Reserved fallback costs are not presented as confirmed cost.
- `refreshed` and `cached`: successfully completed snapshot counts only.
- `elapsedMs`: total wall time. Existing `timings` separately record network/client
  processing, minimum spacing, project-budget spacing and server/retry waits.

Progress counts completed PR attempts, with success and cache counts separately.
A current batch is not a count of completed PRs. `PARTIAL` is expected with `--limit`;
check selected snapshots, gaps and remaining targets before interpreting a pilot.

## Bounded real comparison

Use the same reader, configuration, database and existing quota ledger:

```sh
node dist/cli.js --config config/local.yaml sync --limit 5 --refresh
node dist/cli.js --config config/local.yaml sync --limit 5
```

Compare the selected PR identities, heads, connection pages, gaps, request counts,
actual costs and timing breakdowns. An edited PR, extra pages or changed network
conditions can change the result. Keep real responses, account configuration and
per-PR audit reports in ignored local storage. Do not publish them as fixtures.
A simulated window rollover is not evidence of having observed a real hourly reset.

Remaining costs include complete pagination, metadata/check refreshes for cached
PRs, independent related-object changes, network latency and server-directed waits.
Quota pacing remains uniform within the configured fraction, single-concurrency
and capped at two retries; reducing round trips does not bypass those constraints.

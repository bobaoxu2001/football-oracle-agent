# Operational state backup and restore

Production truth lives in MongoDB Atlas (`football_oracle.pl_ops_bundle.current` plus `pl_match_context_snapshots`) and the frozen git tape.

The canonical tape is **not** part of this backup. Restore it from git:

```text
data/processed/premier-league/live-oos-2026-27.jsonl
MD5    34f7ca54025a3a48df9f1a169df66315
SHA256 a9271d0d3fc3ef0f88bc9ab876cf3b244d70db71d00b568458286095642360da
```

## What to export

| Object | Location | Recoverable how |
| --- | --- | --- |
| Frozen PRESEASON/EARLY tape | git | restore the blob; never rewrite |
| Jobs, ticks, settlements, operational snapshots, ratings, fixture overlay | `pl_ops_bundle` document | export / restore this document |
| Immutable match-context evidence | `pl_match_context_snapshots` collection | exported and restored with the bundle as one v2 backup |
| Tick lease | `pl_ops_locks` | ephemeral; 90s TTL; do not restore |

## Export

Requires `MONGODB_URI` and `MONGODB_DB=football_oracle` (never commit them).

```bash
npm run ops:export-bundle
# or
npx tsx scripts/export-ops-bundle.ts ops-backups/manual.json
```

The command takes the production tick lease and emits a
`football-oracle-ops-backup-v2` file containing both durable stores. It fails
closed if the bundle is missing, partial, corrupt, or if any context document
fails its content-address integrity check. The file also carries a deterministic
context count/checksum and export verifies that every context ID referenced by
an operational forecast is present. `ops-backups/` is local scratch.
Keep copies off-laptop (encrypted volume or object storage).

## Cadence

| When | Why |
| --- | --- |
| After every successful production deploy | pin the pre/post bundle |
| Daily, once the 5-minute scheduler is live | point-in-time pair of the bundle and immutable contexts |
| Immediately before Matchweek 1 | extra copy of jobs + empty settlements |
| After the first real T24H / first VERIFIED_FINAL | pin the first live evidence |

Atlas free-tier has no point-in-time recovery. These JSON exports are the recovery path.

## Restore

1. Confirm the git tape hashes still match.
2. `npx tsx scripts/export-ops-bundle.ts ops-backups/pre-restore.json` (safety copy of whatever is live).
3. `npx tsx scripts/export-ops-bundle.ts --restore ops-backups/<chosen>.json`
4. Restore accepts only the complete v2 backup format. It validates all bundle fields, compressed-job checksums, backup identity, and context hashes before mutation; upgrades legacy/plain job payloads to compressed storage; acquires the same lease as the scheduler; and replaces the bundle plus context collection in one Mongo transaction while preserving the v2 writer fence. If a tick holds the lease, wait and retry; do not bypass it.
5. Do **not** curl `/api/ops/tick` until `/api/health` hydrates the restored bundle and job counts look right.
6. Ratings rebuild from `RatingAppliedEvent` rows inside the bundle. Do not replay VERIFIED_FINAL to “fix” ratings.

## What this does not do

- Does not version every flush (each export is a full snapshot of both production durable stores).
- Does not replace Atlas cluster backups if the project later upgrades off M0.
- Does not touch World Cup `worldcup_oracle`.

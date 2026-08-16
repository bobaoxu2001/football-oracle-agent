# Operational state backup and restore

Non-blocking. Production truth lives in MongoDB Atlas (`football_oracle.pl_ops_bundle.current`) plus the frozen git tape.

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
| Tick lease | `pl_ops_locks` | ephemeral; 90s TTL; do not restore |

## Export

Requires `MONGODB_URI` and `MONGODB_DB=football_oracle` (never commit them).

```bash
npm run ops:export-bundle
# or
npx tsx scripts/export-ops-bundle.ts ops-backups/manual.json
```

`ops-backups/` is local scratch. Keep copies off-laptop (encrypted volume or object storage).

## Cadence

| When | Why |
| --- | --- |
| After every successful production deploy | pin the pre/post bundle |
| Daily, once the 5-minute scheduler is live | cheap point-in-time of the single bundle document |
| Immediately before Matchweek 1 | extra copy of jobs + empty settlements |
| After the first real T24H / first VERIFIED_FINAL | pin the first live evidence |

Atlas free-tier has no point-in-time recovery. These JSON exports are the recovery path.

## Restore

1. Confirm the git tape hashes still match.
2. `npx tsx scripts/export-ops-bundle.ts ops-backups/pre-restore.json` (safety copy of whatever is live).
3. `npx tsx scripts/export-ops-bundle.ts --restore ops-backups/<chosen>.json`
4. Do **not** curl `/api/ops/tick` until `/api/health` hydrates the restored bundle and job counts look right.
5. Ratings rebuild from `RatingAppliedEvent` rows inside the bundle. Do not replay VERIFIED_FINAL to “fix” ratings.

## What this does not do

- Does not version every flush (each export is a full snapshot of the current document).
- Does not replace Atlas cluster backups if the project later upgrades off M0.
- Does not touch World Cup `worldcup_oracle`.

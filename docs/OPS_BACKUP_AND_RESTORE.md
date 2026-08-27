# Operational state backup and restore

Production truth lives in MongoDB Atlas (`football_oracle.pl_ops_bundle.current`,
`pl_match_context_snapshots`, and the append-only `pl_provenance_records`
collection) plus the frozen git tape.

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
| Immutable match-context evidence | `pl_match_context_snapshots` collection | exported and restored with the bundle as one v3 backup |
| Immutable PIT provenance (fixture/result revisions, corrections, membership, rating states, model bundles, manifests) | `pl_provenance_records` collection | sorted, integrity-checked, and exported in the same v3 backup; restore is insert-only |
| Tick lease | `pl_ops_locks` | ephemeral; 90s TTL; do not restore |

## Export

Requires `MONGODB_URI` and `MONGODB_DB=football_oracle` (never commit them).

```bash
npm run ops:export-bundle
# or
npx tsx scripts/export-ops-bundle.ts ops-backups/manual.json
```

The command takes the production tick lease and emits a
`football-oracle-ops-backup-v3` file containing all three durable stores. It
fails closed if the bundle is missing, partial, corrupt, if a context or
provenance document fails its content-address integrity check, or if an
immutable cross-record reference cannot be resolved. The file carries:

- deterministic context count/checksum;
- provenance total count;
- an explicit count for every provenance record kind;
- a deterministic SHA-256 over canonical, `_id`-sorted provenance documents;
- every exact provenance document, including its original `insertedAt`.

Export also verifies that every context ID and input manifest referenced by an
operational forecast is present. `ops-backups/` is local scratch.
Keep copies off-laptop (encrypted volume or object storage).

## Cadence

| When | Why |
| --- | --- |
| After every successful production deploy | pin the pre/post bundle |
| Daily, once the 5-minute scheduler is live | point-in-time bundle, contexts, and provenance evidence |
| Immediately before Matchweek 1 | extra copy of jobs + empty settlements |
| After the first real T24H / first VERIFIED_FINAL | pin the first live evidence |

Atlas free-tier has no point-in-time recovery. These JSON exports are the recovery path.

## Restore

1. Confirm the git tape hashes still match.
2. `npx tsx scripts/export-ops-bundle.ts ops-backups/pre-restore.json` (safety copy of whatever is live).
3. `npx tsx scripts/export-ops-bundle.ts --restore ops-backups/<chosen>.json`
4. Restore accepts only the complete v3 backup format. It validates all bundle fields, compressed-job checksums, backup identity, context hashes, provenance counts/per-kind counts/checksum, every provenance content address, and the complete immutable reference graph before mutation. A v2 file is deliberately rejected because it cannot recover `pl_provenance_records`.
5. After validating the complete file, restore acquires the same lease as the scheduler. Provenance and match-context restore then use only `_id`-scoped `$setOnInsert` operations followed by exact canonical read-back equality. They never delete or overwrite immutable evidence. Retrying the same backup is idempotent; a same-ID conflict fails closed. Restoring an older backup may retain valid newer provenance or context rows as harmless immutable orphans.
6. After immutable-child read-back succeeds, restore upgrades legacy/plain job payloads to compressed storage and replaces the parent bundle in one Mongo transaction while preserving the v2 bundle-writer fence. If a tick holds the lease, wait and retry; do not bypass it.
7. Do **not** curl `/api/ops/tick` until `/api/health` hydrates the restored bundle and job counts look right.
8. Ratings rebuild from `RatingAppliedEvent` rows inside the bundle. Do not replay VERIFIED_FINAL to “fix” ratings.

## What this does not do

- Does not version every flush (each export is a full snapshot of all production durable stores).
- Does not replace Atlas cluster backups if the project later upgrades off M0.
- Does not touch World Cup `worldcup_oracle`.

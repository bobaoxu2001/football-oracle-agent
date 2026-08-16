# Phase 2A.1 guardrail-fix log

**Start:** 2026-08-16  
**Starting HEAD:** `6d293d0243ac68492a53b28139060620e5107ccb`  
**Working tree:** untracked `docs/PHASE2A_INDEPENDENT_AUDIT.md` + pre-existing re-audit tmpdir

## Absolute rule

Do not modify `data/processed/premier-league/live-oos-2026-27.jsonl`.

## Starting tape identity

```text
path     data/processed/premier-league/live-oos-2026-27.jsonl
bytes    569019
lines    380
md5      34f7ca54025a3a48df9f1a169df66315
sha256   a9271d0d3fc3ef0f88bc9ab876cf3b244d70db71d00b568458286095642360da
```

This matches the independent audit. The 380 committed LIVE_OOS records are the evidence record.

## Commands executed

- `git rev-parse HEAD` → `6d293d0…`
- `git status`
- `wc -c / wc -l / md5 / shasum -a 256` on the live tape

## Scope

P1-1 live-ledger double count  
P1-2 kickoff certainty  
P1-3 DATA_READY hardening  

No scheduler, results feed, odds, or parameter changes.

## Diagnosis (P1-1)

`loadFromDisk` indexed each snapshot under the modern 6-part key **and** the Phase 1 legacy 5-part key. `listSnapshots()` walked every map value → 380 × 2 = 760, plus two local smoke snapshots aliased → **764**.

The committed JSONL was never duplicated.

## Fixes applied

- Canonical store: `byUniqueKey` + read-only aliases. Enumeration is unique.
- First-write-wins uses the 6-part key only (legacy aliases no longer collapse stages).
- Archive is key-aware and idempotent; committed tape refuses replace/truncate/unsolicited append.
- `kickoffCertainty` + `scheduledDate` on fixtures; timed stages require CONFIRMED.
- `evaluateSeasonData` returns explicit checks/errors; force-promote override removed.
- Verification cites independent audit sources rather than Wikipedia-vs-self.

## Ending tape identity

```text
bytes    569019
lines    380
md5      34f7ca54025a3a48df9f1a169df66315
sha256   a9271d0d3fc3ef0f88bc9ab876cf3b244d70db71d00b568458286095642360da
byte-identical  YES
```

## Commands

- enrich-kickoff-certainty
- typecheck; npm test (55+33+56+45)
- routing/track/calibration/tournament/ratings/honesty/dc/bracket
- Chrome headless dump-dom of /live → 380, settled 0, no 764

# Phase 1.1 remediation log

**Start:** 2026-08-16  
**Starting SHA:** `9e540b34fec244efe3be1c0ee9c0ea29d0ada6e3`  
**World Cup source:** HEAD + `archive/worldcup-2026-v1` = same SHA, tree clean except pre-existing untracked audit  
**Frozen Phase 1 backtest:** `data/processed/premier-league/backtest-heldout.phase1-frozen.json`  
**Held-out (do not retune HA/ρ):** Candidate Brier 0.6188 / RPS 0.2095 / LogLoss 1.0276

## Commands executed

- Recorded SHAs; confirmed WC tag; listed docs tmpdir
- Copied frozen backtest JSON
- Removed `docs/.PHASE1_ADVERSARIAL_AUDIT.md.*.tmpdir/`
- `node -p process.arch` → x64 Node on arm64 host; `@esbuild/darwin-x64` only
- Implemented durable snapshots, season-init, Championship feeder module, date-grouped backtest, dual calibration metrics, bootstrap, honesty layer, slate rename
- `npm run typecheck` — pass
- `npm test` — 55 + 32 pass
- `npm run test:routing` 73, `test:track` 24, `test:calibration` 12, `test:tournament` 52, `test:ratings`, `test:honesty` — pass
- `npm run dc:selftest` — pass
- `npm run validate:bracket` — 495/495, top-5 37.3/30.9/15.3/7.0/2.4
- `npm run backtest:pl` — structural date&lt;D table + bootstrap seed 20260816 n=20000
- `npx tsx scripts/smoke-phase1.ts` — caveat on PL match and title; WC still plugin

## Modeling / eval notes

- HA=72 and ρ=−0.061 were **not** re-fit.
- Championship feeder is implemented and tested; **off** by default on the Phase 1 held-out backtest so the benchmark is not retuned.
- Date-grouping during training seasons moves held-out scores slightly (0.6188 → 0.6187 Brier; 1.0276 → 1.0281 LogLoss). Documented, not a parameter search.

## World Cup preservation

`worldcup-oracle-agent` was not modified in this phase.

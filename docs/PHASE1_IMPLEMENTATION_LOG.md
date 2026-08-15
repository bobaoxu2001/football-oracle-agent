# Phase 1 implementation log

**Migration start:** 2026-08-16  
**Source repo:** `worldcup-oracle-agent`  
**Source SHA:** `9e540b34fec244efe3be1c0ee9c0ea29d0ada6e3`  
**Preservation tag:** `archive/worldcup-2026-v1` → same commit  
**New repo:** `/Users/xuao/Documents/2025 找工作/AI Projects/football-oracle-agent`  
**Remote:** origin **removed** so this tree cannot push to the World Cup repository.

## Files moved (World Cup plugin)

| From | To |
| --- | --- |
| `lib/prediction-engine/bracket-2026.ts` | `lib/competitions/world-cup/bracket-2026.ts` |
| `lib/prediction-engine/bracketPath.ts` | `lib/competitions/world-cup/bracketPath.ts` |
| `lib/prediction-engine/drawPropensity.ts` | `lib/competitions/world-cup/drawPropensity.ts` |
| `lib/prediction-engine/matchStakes.ts` | `lib/competitions/world-cup/matchStakes.ts` |
| `lib/prediction-engine/bounceBack.ts` | `lib/competitions/world-cup/bounceBack.ts` |
| `lib/prediction-engine/confederationForm.ts` | `lib/competitions/world-cup/confederationForm.ts` |
| `lib/prediction-engine/discipline.ts` | `lib/competitions/world-cup/discipline.ts` |

Compatibility shims remain at the old paths.

## Files rewritten

- `lib/prediction-engine/elo.ts` — `matchProbFromGoals`, `scorelineGridFromGoals`, Monte Carlo samples the Dixon-Coles grid
- `lib/agent/planner.ts` — Premier League in-scope; other leagues still rejected
- `lib/agent/index.ts` — PL match + title paths
- `lib/agent/simulator.ts` — optional true-home bonus + DC options
- `package.json` — renamed `football-oracle-agent`

## Donor components imported (from `world-cup-ai-lab`)

- Walk-forward harness shape (`runRollingBacktest`, `baseK`, `gMult`) → `lib/evaluation/`
- `matchProbFromGoals` / `scorelineGridFromGoals`
- `MODEL_VERSION` + immutable snapshots
- Model auditor (generalized; no WC `getTeam` dependency)

Not imported: V2 ensemble, Stripe/paywall, marketing, martj42 data, Lab availability/tactical.

## Modeling changes

- World Cup 1X2 closed-form math unchanged (ρ = −0.13, awayHomeShare = 0.5)
- Monte Carlo now samples the DC grid (WC tournament % may shift; documented if so)
- Premier League: true home/away, league-scoped params, no host-nation +75
- No availability/tactical in PL backtest

## Test results

All of the following exited 0 on 2026-08-16 in `football-oracle-agent`:

- `npm run typecheck`
- `npm run test:phase1` — 55/55
- World Cup suite: routing 73, track 24, calibration 12, tournament 52, ratings, availability, tactical, draw, stakes, path, qualification, intel, matchtype, bounce, form, completed, freshness, honesty, provenance
- `npm run dc:selftest`
- `npm run validate:bracket` — 495/495 Annex C
- `npm run fit:pl` — training-only grid, shipped HA=72 ρ=−0.061
- `npm run backtest:pl` — held-out 2025-26 n=380
- `npx tsx scripts/smoke-phase1.ts` — Arsenal–Liverpool, PL title, WC title

## World Cup Monte Carlo shift (intentional)

`sampleMatch` now uses the Dixon-Coles grid. Title shares from `validate:bracket`:

- before: Argentina 34.9% · Spain 31.8% · France 15.4% · England 5.9% · Brazil 3.4%
- after: Argentina 37.3% · Spain 30.9% · France 15.3% · England 7.0% · Brazil 2.4%

Closed-form WC 1X2 was not retuned.

## Known limitations

See `docs/PHASE1_RELEASE_REPORT.md` §10.

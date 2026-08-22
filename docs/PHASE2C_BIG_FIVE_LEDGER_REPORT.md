# Phase 2C — Big Five match data ledger

**Execution date:** 2026-08-22 (UTC)
**Starting commit:** `63e9b366d3f89efc593c3ba16376f82efb999da1`
**Provider:** football-data.org v4, plan `TIER_ONE` (the key already used by PL live ops)
**Design:** [`BIG_FIVE_LEDGER.md`](BIG_FIVE_LEDGER.md)

Phase 2A (forecast operations) and Phase 2B0 (market recorder) are unchanged.
The production model `pl-live-v0.2.0` was not modified, refitted, or re-versioned.

---

## 1. Verdict

```text
SHIPPED — LEDGER LIVE, MODEL UNCHANGED
```

The system now discovers completed Big Five matches automatically, records them
as append-only observations with provenance, materializes a canonical match
record, settles frozen pre-match predictions against it, and exposes the result
as temporally-valid evidence for *later* fixtures only.

No new current-season feature is consumed by the model in this phase. That is
deliberate — see §6.

---

## 2. Current-season data (counts from the provider at runtime)

Backfill executed 2026-08-22T02:51:34Z.

```text
Premier League: 1 completed matches
La Liga:        8 completed matches
Bundesliga:     0 completed matches
Serie A:        0 completed matches
Ligue 1:        1 completed matches
```

| Competition | Fixtures tracked | Completed | Season opens |
| --- | --- | --- | --- |
| Premier League | 380 | 1 | 2026-08-21 |
| La Liga | 380 | 8 | 2026-08-16 |
| Bundesliga | 306 | 0 | 2026-08-28 |
| Serie A | 380 | 0 | 2026-08-23 |
| Ligue 1 | 306 | 1 | 2026-08-22 |

**Total: 10 completed matches, 1752 observations stored.**

Bundesliga and Serie A show 0 because neither season has kicked off yet, not
because ingestion failed: both returned HTTP 200 with a full fixture list
(306 and 380 rows) and every row was correctly classified as `SCHEDULED`.

La Liga is the case the brief warned about. Matchweek 1 is **not** complete —
6 of its fixtures have finished, plus 2 from matchweek 2. Completion is decided
per match on `status == FINISHED` **and** a present full-time score, never by
assuming a matchweek is done.

### Every completed match stored

| Competition | MW | Date | Result | HT | Outcome | Canonical id |
| --- | --- | --- | --- | --- | --- | --- |
| Premier League | 1 | 2026-08-21 | Arsenal FC 3–0 Coventry City FC | 2–0 | HOME | `pl-2026-27-arsenal-coventry` |
| La Liga | 1 | 2026-08-15 | Deportivo Alavés 3–0 Getafe CF | 0–0 | HOME | `pd-2026-27-deportivo-alaves-getafe` |
| La Liga | 1 | 2026-08-15 | Sevilla FC 2–1 Rayo Vallecano de Madrid | 0–1 | HOME | `pd-2026-27-sevilla-rayo-vallecano-madrid` |
| La Liga | 1 | 2026-08-16 | Real Racing Club de Santander 2–2 Villarreal CF | 2–2 | DRAW | `pd-2026-27-real-racing-santander-villarreal` |
| La Liga | 1 | 2026-08-16 | RCD Espanyol de Barcelona 3–0 Levante UD | 2–0 | HOME | `pd-2026-27-espanyol-barcelona-levante` |
| La Liga | 1 | 2026-08-17 | RC Deportivo La Coruña 1–1 Elche CF | 1–0 | DRAW | `pd-2026-27-deportivo-la-coruna-elche` |
| La Liga | 1 | 2026-08-19 | Club Atlético de Madrid 2–0 Málaga CF | 0–0 | HOME | `pd-2026-27-atletico-madrid-malaga` |
| La Liga | 2 | 2026-08-20 | Rayo Vallecano de Madrid 1–1 Deportivo Alavés | 0–0 | DRAW | `pd-2026-27-rayo-vallecano-madrid-deportivo-alaves` |
| La Liga | 2 | 2026-08-21 | Real Betis Balompié 1–0 Real Sociedad de Fútbol | 0–0 | HOME | `pd-2026-27-real-betis-balompie-real-sociedad-futbol` |
| Ligue 1 | 1 | 2026-08-21 | Olympique de Marseille 4–0 RC Strasbourg Alsace | 0–0 | HOME | `fl1-2026-27-olympique-marseille-strasbourg-alsace` |

---

## 3. Sanity check

**`Arsenal 3–0 Coventry City — 2026-08-21`: DISCOVERED AND STORED.**

It is not hard-coded anywhere in library code. It was found by querying
`/v4/competitions/PL/matches?season=2026` and classifying the row. Stored record:

```text
canonicalMatchId  pl-2026-27-arsenal-coventry
matchday          1
kickoffUtc        2026-08-21T19:00:00.000Z
full time         3 – 0        half time  2 – 0
outcome           HOME
status            FINISHED
provider match id 560542
source            football-data.org
resultObservedAt  2026-08-22T02:51:34.327Z
```

The canonical id is byte-identical to the fixture id already on the frozen
LIVE_OOS tape, which is what allowed settlement to link them without a mapping
table.

**Other leagues, genuinely completed at execution time:** the eight La Liga
results and `Olympique de Marseille 4–0 RC Strasbourg Alsace` (Ligue 1, MW1,
2026-08-21) in the table above.

### Provider data quality note

25 future Premier League fixtures currently return a **timestamp string in the
`status` field** (e.g. `"2026-10-10 14:00:00Z"`) instead of a status enum. Any
optimistic parse would invent completed matches from a provider bug. Unknown
status maps to `UNKNOWN`, never `FINISHED`, and a `FINISHED` row with no
full-time score is rejected outright. Both are covered by gates.

---

## 4. Match statistics — what this source does and does not provide

Verified against the live API, not documentation. `/v4/matches/560542` returns
no `statistics`, `lineup`, `bench`, `goals`, `bookings` or `substitutions` block
on this plan.

**Available**

- competition, season, matchday, stage
- provider match id, provider team ids
- kickoff (UTC), status, provider `lastUpdated`
- half-time home/away goals, full-time home/away goals
- winner / H-D-A outcome, match duration
- referees

**Not available on `TIER_ONE` — stored as `null`, never `0`**

possession · total shots · shots on target · shots off target · blocked shots ·
shots inside box · shots outside box · **xG** · corners · offsides · fouls ·
yellow cards · red cards · goalkeeper saves · starting XI · formation ·
substitutions · substitution minute · player minutes · goalscorers · assists ·
cards · injuries

The canonical schema models every one of these fields, so a richer source can
populate them without a migration. `SourceCapability` publishes the split, and
the UI renders unavailable fields as unavailable rather than as zero.

**Dependency that would be required to fill them:** a paid plan, or a second
vendor such as API-Football (`API_FOOTBALL_KEY`, already scaffolded in the
codebase but **not** configured and **not** added here). No such dependency was
introduced. No website was scraped. Because xG definitions differ by vendor, no
xG value may enter the ledger without `statisticsSource` naming its origin.

---

## 5. Leakage protection

Why a completed match cannot modify its own pre-match prediction:

1. **Snapshots are immutable.** `createSnapshot` is first-write-wins on a
   6-part unique key. The ledger has no write path into the snapshot store at
   all — `settleCompletedMatches` only reads snapshots and appends a separate
   `SettlementRecord` that references one by key.
2. **Settlement is a different artifact.** Scoring a prediction writes a new
   append-only row. The probabilities being scored are the frozen ones; there
   is no code path that recomputes and replaces them.
3. **The feature layer refuses the match by time.** `admissibleMatches()`
   requires `resultObservedAt <= asOf`. A pre-kickoff prediction has an `asOf`
   before the result existed, so its own result is unreachable.
4. **And by chronology, independently.** `kickoffUtc < asOf` is enforced
   separately, so a clock error or a backfill timestamp cannot smuggle a future
   match into history.
5. **And by identity, explicitly.** The fixture being predicted is excluded by
   id. This matters most when features are recomputed *after* full time — the
   one situation where a leak would otherwise be invisible.

For match N: features come from matches `< N`; the prediction is for N; the
evaluation uses N's result; and only *future* models may include N.

Twelve dedicated gates cover this, marked in the suite as a hard release gate.

---

## 6. Model consumption — the honest split

**Stored only** (in the ledger, not exposed, not consumed)
Raw provider payloads, half-time scores, provider ids, referees,
observation history, corrections.

**Exposed** (queryable via API/UI and the feature layer, still not consumed)
Rolling last-1 / last-3 / last-5 form; season, home and away splits;
W/D/L, points per match, goals for/against, goal difference, clean sheets;
opponent-strength context and strength of schedule; the current-season blend
weight. Statistic-derived features (xG, shots, cards) exist in the schema but
resolve to `null` because the source supplies none.

**Actually consumed by the model: nothing.**
`pl-live-v0.2.0` is unchanged. It still forecasts from walk-forward Elo +
Dixon-Coles and does not read the ledger. Building the evidence base and
changing the model are separate phases on purpose: this phase's claim is a
trustworthy pipeline, not a better forecast.

Market data likewise remains independent — recorded, scored separately, never
an input to the base sporting model.

---

## 7. Evaluation

LIVE_OOS, 2026-27, at execution time:

| | |
| --- | --- |
| Committed snapshots (frozen tape) | 380 |
| Operational snapshots | 0 |
| Settled | 1 |
| Headline Brier / RPS / LogLoss | withheld — n = 1 |

The single settlement, produced by the ledger → settlement bridge:

```text
fixture     pl-2026-27-arsenal-coventry
model       pl-live-v0.2.0     stage EARLY
frozen at   2026-08-16T05:33:34.616Z   (kickoff 2026-08-21T19:00Z)
predicted   H 0.71198  D 0.18879  A 0.09923
actual      3–0  → HOME
Brier 0.12845   RPS 0.04640   LogLoss 0.33971   top pick correct
```

Metrics stay blank until 20 settlements exist. One match is not evidence of
model quality in either direction.

---

## 8. Tests

```text
Phase 1 core          55 passed, 0 failed
Phase 1.1             33 passed, 0 failed
Phase 2A              56 passed, 0 failed
Phase 2A.1            45 passed, 0 failed
Phase 2A.2           104 passed, 0 failed
Phase 2A.3            27 passed, 0 failed
Phase 2A.4            62 passed, 0 failed
Phase 2B0             44 passed, 0 failed
Hardening             77 passed, 0 failed
Match ledger         193 passed, 0 failed
──────────────────────────────────────────
TOTAL                696 passed, 0 failed
```

No existing test was weakened. The canonical 380-row LIVE_OOS tape is
byte-identical (md5 `34f7ca54025a3a48df9f1a169df66315`).

The 193 new gates cover canonical parsing, completed-vs-scheduled status
(including the malformed-status provider bug), idempotent ingestion, correction
handling, missing-statistic discipline, team identity normalization and
rename-stability, competition and season isolation, chronological cutoffs,
no-future-leakage, no-same-match-leakage, rolling 1/3/5, home/away splits,
early-season shrinkage, settlement linkage, the Arsenal 3–0 fixture end-to-end,
and API/UI serialization.

---

## 9. Production

**Runtime behaviour changed:** the ops tick now runs a ledger pass after the
forecast lease is released, under the same isolation contract as the market
recorder — it cannot fail a forecast tick. It is gated to one run per 30 minutes
(`MATCH_LEDGER_INTERVAL_MS`) rather than every 5, because a completed match
stays completed and the provider free tier is rate limited (~10 req/min; 429s
are retried with backoff).

**No second scheduler** was introduced. The existing GitHub-driven tick and its
Mongo 90-second lease remain the only driver.

**Migration:** none. The ledger creates its own collections
(`big_five_match_observations`, `big_five_team_identity`,
`big_five_ledger_state`) on first write.

**Backfill:** one run of `npm run ledger:backfill` in the production
environment. It is idempotent, so re-running is safe. On Vercel the backend
auto-selects Mongo; the local file mirror is gitignored because production truth
lives in Mongo and a committed local copy would diverge from it.

**Rollback:** set `MATCH_LEDGER_DISABLED=1`. Forecasting, settlement of the
existing PL path, and the market recorder are unaffected.

---

## 10. Remaining limitations

- **No match statistics at all.** The configured plan supplies results only.
  Every statistic-derived feature is structurally present but null. Any claim
  about xG, shots or possession is currently unsupported.
- **Four leagues are ledger-only.** La Liga, Bundesliga, Serie A and Ligue 1
  have no fitted model, no ratings, no fixture store and no frozen predictions.
  They accumulate evidence; they do not forecast. "Big Five supported" is true
  for **ingestion**, not for **prediction**.
- **Ten completed matches.** Rolling last-5, home/away splits and
  strength-of-schedule are implemented and tested, but at this sample size they
  describe almost nothing.
- **No lineups, no injuries.** Structured injury data is modelled but never
  populated; nothing is inferred from prose.
- **Single source.** Everything rests on one provider. There is no
  corroborating result feed for the four new leagues, so a provider error would
  currently be undetected — corrections are detectable, disagreements are not.
- **Team identity for the four new leagues is provider-anchored.** Slugs derive
  from provider names on first sight. They are stable across renames but were
  not cross-checked against an official club registry the way PL slugs were.
- **`resultObservedAt` for backfilled matches is the backfill instant**, not the
  real-world moment of full time. This is conservative in the safe direction —
  it can only make evidence admissible later than reality, never earlier.

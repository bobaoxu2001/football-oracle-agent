# Premier League context provider gate (API-Football)

Status: **blocked pending `API_FOOTBALL_KEY`**. No live lineup/injury schema is authorized.

## availableAt contract

Preferred: a provider timestamp whose documented meaning is **when the fact became observable**.

Fallback: `firstObservedAt` — when this collector first received the observation.

Never use injury occurrence date, match date, kickoff, guessed publication time, or today's latest provider state as historical `availableAt`.

## Identity

Canonical fixture id is `pl-{season}-{homeSlug}-{awaySlug}`. Reverse fixtures are different ids.

Intelligence mapping must use provider team ids + league 39 + kickoff, never names. Unmapped ids fail closed.

## Reconstruction

If the provider is a latest-state API, the repository must keep append-only observations. Querying later must not be assumed to reconstruct T1/T2 knowledge.

## Isolation

World Cup `lib/live-sports/apiFootball.ts` defaults to league 1 and national-team slugs. It must not be reused for Premier League context.

Provider failure must not affect frozen champion serving.

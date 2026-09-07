# Premier League Match Intelligence Skill — V1

Research operating skill. Not a production probability model.

Champion remains `pl-live-v0.2.0`. Intelligence is Layer B.

`INTELLIGENCE ≠ PRODUCTION PROBABILITY`

## Checklist before every match

1. What does frozen production say?
2. What was its cutoff?
3. What player information was legally available at that cutoff (`availableAt <= cutoffAt`)?
4. Are the tactical-spine players available (GK, CB, DM, progression midfielder, main creator, primary finisher)?
5. How important is each absence to *this team* (minutes/role/scarcity), not fame?
6. Is the replacement system-compatible?
7. Is an entire unit disrupted?
8. What are the strongest flank / midfield / transition mismatches?
9. Can the favorite actually break this opponent (Kill Index, heuristic)?
10. Can the underdog survive expected pressure (Resistance Index, heuristic)?
11. Has each team faced this opponent archetype before, and did they *solve the tactical problem*?
12. Is sterile-possession risk present?
13. Are there set-piece or aerial mismatches?
14. Does schedule / rest / rotation matter as an observable incentive, not “trying harder”?
15. Is the lineup confirmed, expected, or uncertain?
16. What evidence is fact vs narrative?
17. What is uncertain or conflicted?
18. Does contextual intelligence SUPPORT, CHALLENGE, or remain NEUTRAL to the frozen champion?
19. Is confidence high enough to make any contextual claim?
20. What should be learned after settlement — without patching the champion from one anecdote?

## Invariants

- Never mint a public PL probability from intelligence.
- Never rewrite a frozen LIVE_OOS snapshot.
- Confirmed lineup cannot leak into an earlier context stage.
- Unknown remains unknown.
- Speculation never becomes confirmed absence.
- No authorized injury/lineup provider is currently configured. Production reports `SOURCE_AUTHORIZATION_REQUIRED` / `NONE_CONFIGURED`.

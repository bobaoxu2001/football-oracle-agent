import type {
  EvidenceSourceTier,
  IntelligenceContextStage,
  IntelligenceEvidenceRef,
  StatementClass,
  VerificationState,
} from "./types";

const TIER_RANK: Record<EvidenceSourceTier, number> = {
  OFFICIAL_COMPETITION: 0,
  CONFIRMED_LINEUP: 1,
  MANAGER_AVAILABILITY: 2,
  REPUTABLE_TEAM_REPORTER: 3,
  REPUTABLE_SPORTS_REPORTING: 4,
  AGGREGATOR: 5,
  SPECULATION: 6,
  SYNTHETIC_TEST: 7,
  UNDECLARED: 8,
};

export function classifySourceTier(sourceName: string, lineupStatus: string | null): EvidenceSourceTier {
  const name = sourceName.trim().toLowerCase();
  if (name === "synthetic-test" || name.startsWith("synthetic")) return "SYNTHETIC_TEST";
  if (lineupStatus === "CONFIRMED") return "CONFIRMED_LINEUP";
  if (/(premier-league|football-data|official)/.test(name)) return "OFFICIAL_COMPETITION";
  if (/(press-conference|manager|coach)/.test(name)) return "MANAGER_AVAILABILITY";
  if (/(athletic|sky-sports|bbc|reuters)/.test(name)) return "REPUTABLE_SPORTS_REPORTING";
  if (/(reporter|correspondent)/.test(name)) return "REPUTABLE_TEAM_REPORTER";
  if (/(aggregator|transfermarkt|sofascore)/.test(name)) return "AGGREGATOR";
  if (/(twitter|x.com|rumour|rumor|fan)/.test(name)) return "SPECULATION";
  if (!name) return "UNDECLARED";
  return "UNDECLARED";
}

export function legallyAvailable(availableAt: string | null, cutoffAt: string): boolean {
  if (!availableAt) return false;
  const availableMs = Date.parse(availableAt);
  const cutoffMs = Date.parse(cutoffAt);
  return Number.isFinite(availableMs) && Number.isFinite(cutoffMs) && availableMs <= cutoffMs;
}

export function verificationFor(tier: EvidenceSourceTier, conflicted: boolean): VerificationState {
  if (conflicted) return "CONFLICTED";
  if (tier === "OFFICIAL_COMPETITION" || tier === "CONFIRMED_LINEUP") return "VERIFIED";
  if (tier === "MANAGER_AVAILABILITY" || tier === "REPUTABLE_TEAM_REPORTER") return "CORROBORATED";
  if (tier === "REPUTABLE_SPORTS_REPORTING") return "UNCONFIRMED";
  if (tier === "SPECULATION") return "SPECULATIVE";
  if (tier === "SYNTHETIC_TEST") return "UNCONFIRMED";
  return "UNKNOWN";
}

export function statementClassFor(kind: string, payload?: Record<string, unknown> | null): StatementClass {
  if (payload && payload.statementClass === "NARRATIVE") return "NARRATIVE";
  if (payload && payload.statementClass === "FACT") return "FACT";
  if (kind === "LINEUP" || kind === "SQUAD_AVAILABILITY" || kind === "FIXTURE") return "FACT";
  if (kind === "TEAM_NEWS" || kind === "TACTICAL_CONTEXT") return "NARRATIVE";
  return "UNKNOWN";
}

export function contextStageFromLineup(
  overall: "NONE" | "EXPECTED" | "CONFIRMED" | "PARTIAL" | null
): IntelligenceContextStage {
  if (overall === "CONFIRMED") return "CONFIRMED_LINEUP";
  if (overall === "EXPECTED" || overall === "PARTIAL") return "PRE_LINEUP";
  return "EARLY_PREMATCH";
}

export function lineupStateFromStage(
  stage: IntelligenceContextStage
): "CONFIRMED" | "EXPECTED" | "LINEUP_UNCERTAIN" {
  if (stage === "CONFIRMED_LINEUP") return "CONFIRMED";
  if (stage === "PRE_LINEUP") return "EXPECTED";
  return "LINEUP_UNCERTAIN";
}

export function evidenceRef(input: {
  evidenceId: string | null;
  sourceName: string;
  lineupStatus: string | null;
  observedAt: string | null;
  fetchedAt: string | null;
  availableAt: string | null;
  cutoffAt: string;
  kind: string;
  payload?: Record<string, unknown> | null;
  conflicted?: boolean;
  note?: string;
}): IntelligenceEvidenceRef {
  const sourceTier = classifySourceTier(input.sourceName, input.lineupStatus);
  const legal = legallyAvailable(input.availableAt, input.cutoffAt);
  return {
    evidenceId: input.evidenceId,
    sourceName: input.sourceName || "undeclared",
    sourceTier,
    observedAt: input.observedAt,
    fetchedAt: input.fetchedAt,
    availableAt: input.availableAt,
    legallyAvailable: legal,
    verification: verificationFor(sourceTier, Boolean(input.conflicted) || !legal),
    statementClass: statementClassFor(input.kind, input.payload),
    note: input.note ?? (legal ? "Admitted at cutoff." : "Excluded or unknown relative to cutoff."),
  };
}

export function preferHigherTier(a: EvidenceSourceTier, b: EvidenceSourceTier): EvidenceSourceTier {
  return TIER_RANK[a] <= TIER_RANK[b] ? a : b;
}

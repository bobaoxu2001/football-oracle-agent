/**
 * Deterministic model auditor — migrated from world-cup-ai-lab and
 * generalized so it does not depend on the 48-nation World Cup table.
 */

import type { MatchPrediction } from "@/lib/types";
import type { AuditIssue, AuditReport, AuditStatus } from "./types";

const PROB_TOL = 1e-3;

const GUARANTEE_PATTERNS: RegExp[] = [
  /\bguaranteed to win\b/i,
  /\bguaranteed (?:win|victory|result)\b/i,
  /\bcertain to win\b/i,
  /\b(?:will|going to) (?:surely|certainly|definitely) win\b/i,
  /\bsure thing\b/i,
  /\bcan(?:no|')t lose\b/i,
  /\bcannot lose\b/i,
  /\b100% (?:to win|win|certain)\b/i,
  /\block(?:ed)? (?:of the day|in)\b/i,
  /\brisk-free\b/i,
];

const BETTING_PATTERNS: RegExp[] = [
  /\bplace a bet\b/i,
  /\bsure bet\b/i,
  /\bwager\b/i,
  /\bbookmaker'?s?\b/i,
  /\baccumulator\b/i,
  /\bparlay\b/i,
  /\b(?:back|lay) (?:this|the favourite|the underdog)\b/i,
];

function scan(text: string, patterns: RegExp[]): string[] {
  return patterns.filter((p) => p.test(text)).map((p) => p.source);
}

function report(subject: string, issues: AuditIssue[], fixes: string[]): AuditReport {
  const status: AuditStatus = issues.some((i) => i.severity === "fail")
    ? "fail"
    : issues.some((i) => i.severity === "warning")
      ? "warning"
      : "pass";
  return { subject, status, issues, recommendedFixes: [...new Set(fixes)] };
}

export function auditPrediction(p: MatchPrediction): AuditReport {
  const issues: AuditIssue[] = [];
  const fixes: string[] = [];
  const subject = p.matchId;
  const add = (code: string, severity: "warning" | "fail", message: string, fix: string) => {
    issues.push({ code, severity, message, subject });
    fixes.push(fix);
  };

  const a = p.teamAWinProbability;
  const d = p.drawProbability;
  const b = p.teamBWinProbability;
  const sum = a + d + b;
  if (Math.abs(sum - 1) > PROB_TOL)
    add("PROBS_SUM", "fail", `1X2 probabilities sum to ${sum.toFixed(5)}, not 1.`, "Re-normalise the 1X2 vector before display.");

  for (const [name, v] of [
    ["home", a],
    ["draw", d],
    ["away", b],
  ] as const) {
    if (v < 0 || v > 1)
      add("PROB_RANGE", "fail", `${name} probability ${v} is outside [0,1].`, "Clamp/normalise probabilities into [0,1].");
  }

  for (const [name, v] of [
    ["homeExpectedGoals", p.expectedGoalsA],
    ["awayExpectedGoals", p.expectedGoalsB],
  ] as const) {
    if (v < 0 || v > 6)
      add("GOAL_RANGE", v < 0 ? "fail" : "warning", `${name} = ${v.toFixed(2)} is implausible.`, "Check the expected-goals clamp (0.3–3.5).");
  }

  const gridSum = p.topScorelines.reduce((s, c) => s + c.prob, 0);
  if (p.topScorelines.length > 0 && gridSum > 1 + PROB_TOL)
    add("SCORE_SUM", "fail", `Top scorelines sum to ${gridSum.toFixed(4)} > 1.`, "Normalise the scoreline grid.");

  if (p.teamA === p.teamB)
    add("TEAMS_SWAPPED", "fail", "Home and away slugs are identical.", "Resolve two distinct clubs.");

  const text = `${p.modelSummary}\n${p.fullReport}`;
  const betting = scan(text, BETTING_PATTERNS);
  if (betting.length)
    add("BETTING_LANGUAGE", "fail", `Betting-advice language detected.`, "Remove betting-advice phrasing.");
  const guarantee = scan(text, GUARANTEE_PATTERNS);
  if (guarantee.length)
    add("GUARANTEE_LANGUAGE", "fail", `Guaranteed-outcome language detected.`, "Use probabilistic phrasing.");

  if (!p.modelVersion)
    add("NO_MODEL_VERSION", "warning", "Prediction has no modelVersion.", "Stamp MODEL_VERSION on every prediction.");

  return report(subject, issues, fixes);
}

export function auditScorelineGrid(grid: { p: number }[], subject = "scoreline-grid"): AuditReport {
  const issues: AuditIssue[] = [];
  const fixes: string[] = [];
  const sum = grid.reduce((s, c) => s + c.p, 0);
  if (Math.abs(sum - 1) > 1e-6) {
    issues.push({
      code: "GRID_SUM",
      severity: "fail",
      message: `Scoreline probabilities sum to ${sum.toFixed(8)}, not 1.`,
      subject,
    });
    fixes.push("Normalise the Dixon-Coles grid.");
  }
  return report(subject, issues, fixes);
}

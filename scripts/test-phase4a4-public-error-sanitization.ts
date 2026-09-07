/** Phase 4A4: public operational errors never expose internal diagnostics. */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { MarketHealthReport } from "@/lib/competitions/premier-league/market/health";
import type { HealthReport } from "@/lib/competitions/premier-league/ops/health";
import {
  buildPublicHealthResponse,
  sanitizePublicHealthReport,
  sanitizePublicMarketHealthReport,
} from "@/lib/competitions/premier-league/ops/public-health";
import {
  classifyPublicOperationalError,
  containsSensitivePublicValue,
  publicFailureBody,
  publicOperationalErrorText,
  sanitizePublicOperationalPayload,
  sanitizePublicShadowReport,
} from "@/lib/competitions/premier-league/ops/public-errors";
import { redactCredentialText } from "@/lib/competitions/premier-league/ops/secrets";

const SECRET_URI =
  "mongodb+srv://admin:hunter2@cluster0.invalid/oracle?authSource=admin";
const PRIVATE_PATH = "/Users/operator/private/ops.jsonl";
const PRIVATE_STACK = "Error: failed\n    at hydrate (/var/task/server.js:88:4)";
const PRIVATE_TOKEN = "Authorization: Bearer sk-live-super-secret";
const PRIVATE_OBJECT_ID = 'ObjectId("507f1f77bcf86cd799439011")';
const RAW_PAYLOAD = '{"raw-upstream-body":"private","apiKey":"provider-secret"}';
const POSTGRES_URI = "postgresql://internal-db:5432/oracle";
const REDIS_URI = "redis://cache.internal:6379/0";
const PREFIXED_SECRET = "sk-live-super-secret-token";
const KEY_ONLY_SECRET = "opaque-provider-credential";
const INTERNAL_HOST = "scheduler-17.internal.example";

const HOSTILE_DIAGNOSTIC = [
  SECRET_URI,
  PRIVATE_PATH,
  PRIVATE_STACK,
  PRIVATE_TOKEN,
  PRIVATE_OBJECT_ID,
  RAW_PAYLOAD,
].join(" | ");

const forbiddenFragments = [
  "hunter2",
  "cluster0.invalid",
  "/Users/operator",
  "/var/task",
  "sk-live-super-secret",
  "507f1f77bcf86cd799439011",
  "raw-upstream-body",
  "provider-secret",
  "internal-db",
  "cache.internal",
  PREFIXED_SECRET,
  KEY_ONLY_SECRET,
  INTERNAL_HOST,
];

let passed = 0;

function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`✓ ${name}`);
    });
}

function assertNoPrivateDiagnostics(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const fragment of forbiddenFragments) {
    assert.equal(serialized.includes(fragment), false, fragment);
  }
}

function publicRenderTreeProps(value: unknown, seen = new Set<object>()): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => publicRenderTreeProps(entry, seen));
  }
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return null;
  seen.add(value);
  if ("type" in value && "props" in value) {
    return publicRenderTreeProps(
      (value as { props: unknown }).props,
      seen
    );
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      publicRenderTreeProps(entry, seen),
    ])
  );
}

function hostileHealthReport(): HealthReport {
  return {
    overall: "DEGRADED",
    reasons: [
      "fixture sync stale",
      `last error: ${HOSTILE_DIAGNOSTIC}`,
      `next production forecast is not PIT-evidence ready: ${HOSTILE_DIAGNOSTIC}`,
    ],
    season: {
      dataReadyReasons: [HOSTILE_DIAGNOSTIC],
    },
    scheduler: {
      host: INTERNAL_HOST,
      jobs: { PENDING: 1 },
    },
    provenanceCapture: {
      nextForecast: {
        reasons: [HOSTILE_DIAGNOSTIC],
      },
    },
    conflicts: [
      {
        kind: "result-score",
        fixtureId: "public-fixture-id",
        sources: [SECRET_URI],
        detail: RAW_PAYLOAD,
        recordedAt: "2026-08-27T00:00:00.000Z",
      },
    ],
    lastError: HOSTILE_DIAGNOSTIC,
    ledgerMetrics: { schemaVersion: "pl-ledger-metrics-v3" },
    diagnosticBlob: {
      raw: RAW_PAYLOAD,
      postgresql: POSTGRES_URI,
      redis: REDIS_URI,
      token: PREFIXED_SECRET,
      apiKey: KEY_ONLY_SECRET,
    },
  } as unknown as HealthReport;
}

function hostileMarketReport(): MarketHealthReport {
  return {
    overall: "DEGRADED",
    freshness: {
      scope: "marketObserver",
      status: "ERROR",
      evaluatedAt: "2026-08-27T00:00:00.000Z",
      configured: true,
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastAttemptAgeMs: null,
      lastSuccessAgeMs: null,
      staleAfterMs: 60_000,
      cadenceMs: 60_000,
      reasonCodes: ["LAST_ERROR_RECORDED"],
      affectsProductionForecast: false,
    },
    reasons: [`last poll failed: ${HOSTILE_DIAGNOSTIC}`],
    source: {
      id: SECRET_URI,
      configured: true,
      region: PRIVATE_PATH,
      sport: RAW_PAYLOAD,
      market: PRIVATE_TOKEN,
    },
    lastSuccessAt: null,
    lastFailedAt: "2026-08-27T00:00:00.000Z",
    lastError: HOSTILE_DIAGNOSTIC,
    quotaRemaining: null,
    quotaUsed: null,
    lastRequestCost: null,
    nextScheduledPoll: null,
    currentCadenceMs: null,
    eventsHint: RAW_PAYLOAD,
    fixturesMatched: null,
    unmatched: null,
    ambiguous: null,
    bookmakersObserved: null,
    observationsStored: null,
    consensusStored: null,
    firstMarketObservationAt: null,
    schemaVersion: RAW_PAYLOAD,
  };
}

async function main(): Promise<void> {
  await check("odds API keys are stripped from operator diagnostics", () => {
    const key = "test-odds-key-SHOULD-NOT-LEAK-9f3a";
    const raw = `the-odds-api request failed: fetch failed for https://api.the-odds-api.com/v4/sports/soccer_epl/odds?apiKey=${key}`;
    const redacted = redactCredentialText(raw, [key]);
    assert.equal(redacted.includes(key), false);
    assert.match(redacted, /apiKey=\[redacted\]/);
  });

  await check("credential diagnostics map to a bounded authentication category", () => {
    assert.equal(
      classifyPublicOperationalError(PRIVATE_TOKEN).category,
      "AUTHENTICATION_FAILED"
    );
    assert.equal(
      classifyPublicOperationalError("ODDS_API_KEY is not configured").category,
      "CONFIGURATION_INCOMPLETE"
    );
  });

  await check("credentialed Mongo URIs map to a bounded category", () => {
    const result = classifyPublicOperationalError(SECRET_URI);
    assert.ok(
      result.category === "AUTHENTICATION_FAILED" ||
        result.category === "DURABLE_STORE_UNAVAILABLE"
    );
    assertNoPrivateDiagnostics(result);
  });

  await check("datastore URIs, token prefixes, and sensitive-key values are redacted", () => {
    assert.equal(containsSensitivePublicValue(POSTGRES_URI), true);
    assert.equal(containsSensitivePublicValue(REDIS_URI), true);
    assert.equal(containsSensitivePublicValue(PREFIXED_SECRET), true);
    assertNoPrivateDiagnostics(sanitizePublicHealthReport(hostileHealthReport()));
  });

  await check("network failures expose only the upstream-unavailable category", () => {
    assert.equal(
      classifyPublicOperationalError(
        new Error(`ETIMEDOUT calling https://provider.invalid at ${PRIVATE_PATH}`)
      ).category,
      "UPSTREAM_UNAVAILABLE"
    );
  });

  await check("raw malformed payloads expose only the invalid-response category", () => {
    const result = classifyPublicOperationalError(
      new Error('invalid JSON response {"raw-upstream-body":"private"}')
    );
    assert.equal(result.category, "UPSTREAM_RESPONSE_INVALID");
    assertNoPrivateDiagnostics(result);
  });

  await check("PIT failures expose only the evidence-validation category", () => {
    assert.equal(
      classifyPublicOperationalError(
        new Error(`manifest lost immutable reference at ${PRIVATE_PATH}`)
      ).category,
      "EVIDENCE_VALIDATION_FAILED"
    );
  });

  await check("route failure bodies contain no raw message, stack or cause", () => {
    const body = publicFailureBody(
      "health_failed",
      new Error(HOSTILE_DIAGNOSTIC)
    );
    assert.deepEqual(Object.keys(body).sort(), ["category", "error", "message"]);
    assertNoPrivateDiagnostics(body);
  });

  await check("scheduler and observer payload diagnostics are categorised", () => {
    const result = sanitizePublicOperationalPayload({
      errors: [HOSTILE_DIAGNOSTIC],
      shadowErrors: [PRIVATE_PATH],
      state: { lastError: SECRET_URI, lastShadowError: PRIVATE_TOKEN },
      conflict: { detail: RAW_PAYLOAD },
    });
    assertNoPrivateDiagnostics(result);
    assert.ok(result.errors[0].includes(":"));
  });

  await check("shadow lifecycle diagnostics are sanitized without mutating the internal report", () => {
    const internalReport = {
      season: "2026-27",
      collection: {
        lastShadowLifecycleError: HOSTILE_DIAGNOSTIC,
        frozenSnapshotPairs: 7,
      },
    };
    const publicReport = sanitizePublicShadowReport(internalReport);
    assert.equal(
      publicReport.collection.lastShadowLifecycleError,
      publicOperationalErrorText(HOSTILE_DIAGNOSTIC)
    );
    assert.equal(publicReport.collection.frozenSnapshotPairs, 7);
    assert.equal(
      internalReport.collection.lastShadowLifecycleError,
      HOSTILE_DIAGNOSTIC
    );
    assertNoPrivateDiagnostics(publicReport);
  });

  await check("shadow success surfaces expose only the public lifecycle diagnostic", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foa-shadow-public-"));
    const env = {
      PL_OPS_BACKEND: "file",
      PL_TICK_STATE_PATH: path.join(dir, "tick-state.json"),
      PL_JOB_STORE_PATH: path.join(dir, "prediction-jobs.jsonl"),
      PL_OPERATIONAL_LIVE_OOS_PATH: path.join(dir, "live-oos-operational.jsonl"),
      SETTLEMENT_STORE_PATH: path.join(dir, "settlements.jsonl"),
      SNAPSHOT_STORE_PATH: path.join(dir, "working-snapshots.jsonl"),
    } as const;
    const previous = new Map(
      Object.keys(env).map((key) => [key, process.env[key]])
    );
    Object.assign(process.env, env);
    fs.writeFileSync(
      env.PL_TICK_STATE_PATH,
      JSON.stringify({
        lastTickAt: "2026-08-27T12:00:00.000Z",
        lastSuccessAt: "2026-08-27T12:00:00.000Z",
        lastError: null,
        lastFixtureSyncAt: "2026-08-27T12:00:00.000Z",
        lastFixtureSyncOkAt: "2026-08-27T12:00:00.000Z",
        lastResultSyncAt: "2026-08-27T12:00:00.000Z",
        lastResultSyncOkAt: "2026-08-27T12:00:00.000Z",
        lastVerifiedResultAt: null,
        lastVerifiedFixtureId: null,
        ticks: 1,
        lastShadowFreezeAt: null,
        lastShadowError: HOSTILE_DIAGNOSTIC,
        lastShadowFrozen: 0,
      })
    );

    try {
      const [shadowRoute, accuracyRoute, shadowPage, shadowReport] =
        await Promise.all([
          import("@/app/api/shadow/route"),
          import("@/app/api/accuracy/route"),
          import("@/app/shadow/page"),
          import("@/lib/competitions/premier-league/shadow/report"),
        ]);

      const internalReport = shadowReport.shadowEvaluationReport("2026-27");
      assert.equal(
        internalReport.collection.lastShadowLifecycleError,
        HOSTILE_DIAGNOSTIC
      );

      const shadowResponse = await shadowRoute.GET(
        new Request("http://localhost/api/shadow")
      );
      assert.equal(shadowResponse.status, 200);
      const shadowBody = await shadowResponse.json();
      assert.equal(
        shadowBody.collection.lastShadowLifecycleError,
        publicOperationalErrorText(HOSTILE_DIAGNOSTIC)
      );
      assertNoPrivateDiagnostics(shadowBody);

      const accuracyResponse = await accuracyRoute.GET();
      assert.equal(accuracyResponse.status, 200);
      const accuracyBody = await accuracyResponse.json();
      assert.equal(
        accuracyBody.shadow.collection.lastShadowLifecycleError,
        publicOperationalErrorText(HOSTILE_DIAGNOSTIC)
      );
      assertNoPrivateDiagnostics(accuracyBody);

      const pageTree = publicRenderTreeProps(await shadowPage.default());
      const serializedPage = JSON.stringify(pageTree);
      assert.ok(
        serializedPage.includes(publicOperationalErrorText(HOSTILE_DIAGNOSTIC))
      );
      assertNoPrivateDiagnostics(pageTree);
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  const internalHealth = hostileHealthReport();
  const publicHealth = sanitizePublicHealthReport(internalHealth);

  await check("public Health reasons redact scheduler and provider diagnostics", () => {
    assert.ok(publicHealth.reasons.includes("fixture sync stale"));
    assert.ok(
      publicHealth.reasons.some((reason) =>
        reason.startsWith("EVIDENCE_VALIDATION_FAILED:")
      )
    );
    assertNoPrivateDiagnostics(publicHealth.reasons);
    assert.equal(containsSensitivePublicValue(HOSTILE_DIAGNOSTIC), true);
    assertNoPrivateDiagnostics(publicHealth);
  });

  await check("public Health lastError is a stable category and message", () => {
    assert.equal(publicHealth.lastError, publicOperationalErrorText(HOSTILE_DIAGNOSTIC));
    assertNoPrivateDiagnostics(publicHealth.lastError);
  });

  await check("public PIT preflight reasons never return raw validation errors", () => {
    assert.equal(publicHealth.provenanceCapture.nextForecast?.reasons.length, 1);
    assertNoPrivateDiagnostics(
      publicHealth.provenanceCapture.nextForecast?.reasons
    );
  });

  await check("public conflict summaries redact raw payloads and source identifiers", () => {
    assert.deepEqual(publicHealth.conflicts[0]?.sources, ["source-observations"]);
    assert.equal(
      publicHealth.conflicts[0]?.detail,
      "DATA_CONFLICT: Conflicting source observations require review."
    );
    assertNoPrivateDiagnostics(publicHealth.conflicts);
  });

  await check("public Health suppresses the internal scheduler hostname", () => {
    assert.equal(publicHealth.scheduler.host, null);
  });

  await check("sanitization preserves health decisions, counts and public fixture identity", () => {
    assert.equal(publicHealth.overall, internalHealth.overall);
    assert.deepEqual(publicHealth.scheduler.jobs, internalHealth.scheduler.jobs);
    assert.deepEqual(publicHealth.ledgerMetrics, internalHealth.ledgerMetrics);
    assert.equal(publicHealth.conflicts[0]?.fixtureId, "public-fixture-id");
  });

  await check("market Health redacts errors, source internals and raw event hints", () => {
    const market = sanitizePublicMarketHealthReport(hostileMarketReport());
    assert.equal(market.overall, "DEGRADED");
    assert.equal(market.freshness.status, "ERROR");
    assert.equal(market.source.id, "external-market-source");
    assert.equal(market.schemaVersion, "unavailable");
    assertNoPrivateDiagnostics(market);
  });

  await check("public Health market fallback is sanitized while raw detail remains internal", async () => {
    const originalConsoleError = console.error;
    const internalLog: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      internalLog.push(args);
    };
    try {
      const response = await buildPublicHealthResponse({
        now: new Date("2026-08-27T12:00:00.000Z"),
        marketHealthBuilder: async () => {
          throw new Error(HOSTILE_DIAGNOSTIC);
        },
      });
      assert.equal(response.market.overall, "DEGRADED");
      assert.equal(response.market.observationsStored, null);
      assertNoPrivateDiagnostics(response);
      assert.equal(internalLog.length, 1);
      assert.equal(internalLog[0]?.[0], "[public-health.market]");
      assert.ok(internalLog[0]?.[1] instanceof Error);
      assert.equal((internalLog[0]?.[1] as Error).message, HOSTILE_DIAGNOSTIC);
    } finally {
      console.error = originalConsoleError;
    }
  });

  await check("Health page and Health APIs are wired only to sanitized projections", () => {
    const page = fs.readFileSync(path.resolve("app/health/page.tsx"), "utf8");
    const healthRoute = fs.readFileSync(
      path.resolve("app/api/health/route.ts"),
      "utf8"
    );
    const marketRoute = fs.readFileSync(
      path.resolve("app/api/market/health/route.ts"),
      "utf8"
    );
    const marketSummaryRoute = fs.readFileSync(
      path.resolve("app/api/market/route.ts"),
      "utf8"
    );
    const tickRoute = fs.readFileSync(path.resolve("app/api/ops/tick/route.ts"), "utf8");
    const observersRoute = fs.readFileSync(
      path.resolve("app/api/ops/observers/route.ts"),
      "utf8"
    );
    const matchesRoute = fs.readFileSync(path.resolve("app/api/matches/route.ts"), "utf8");
    const storageRoute = fs.readFileSync(path.resolve("app/api/ops/storage/route.ts"), "utf8");
    const shadowRoute = fs.readFileSync(path.resolve("app/api/shadow/route.ts"), "utf8");
    const accuracyRoute = fs.readFileSync(
      path.resolve("app/api/accuracy/route.ts"),
      "utf8"
    );
    const shadowPage = fs.readFileSync(path.resolve("app/shadow/page.tsx"), "utf8");
    const accuracyPage = fs.readFileSync(path.resolve("app/accuracy/page.tsx"), "utf8");
    const benchmarkRoute = fs.readFileSync(
      path.resolve("app/api/market/benchmark/route.ts"),
      "utf8"
    );
    assert.ok(page.includes("buildPublicHealthResponse"));
    assert.equal(page.includes("buildHealthReport"), false);
    assert.ok(healthRoute.includes("publicFailureBody"));
    assert.ok(marketRoute.includes("sanitizePublicMarketHealthReport"));
    assert.ok(marketRoute.includes("publicFailureBody"));
    assert.ok(marketSummaryRoute.includes("sanitizePublicMarketHealthReport"));
    assert.ok(marketSummaryRoute.includes("recordInternalOperationalError"));
    assert.ok(tickRoute.includes("sanitizePublicOperationalPayload"));
    assert.ok(observersRoute.includes("sanitizePublicOperationalPayload"));
    assert.ok(matchesRoute.includes("publicOperationalErrorText"));
    assert.ok(storageRoute.includes("sanitizePublicOperationalPayload"));
    assert.ok(shadowRoute.includes("publicFailureBody"));
    assert.ok(shadowRoute.includes("sanitizePublicShadowReport"));
    assert.ok(accuracyRoute.includes("sanitizePublicShadowReport"));
    assert.ok(shadowPage.includes("sanitizePublicShadowReport"));
    assert.ok(accuracyPage.includes("sanitizePublicShadowReport"));
    assert.ok(benchmarkRoute.includes("recordInternalOperationalError"));
    assert.equal(healthRoute.includes("(err as Error).message"), false);
    assert.equal(marketRoute.includes("(err as Error).message"), false);
    assert.equal(marketSummaryRoute.includes("(err as Error).message"), false);
    assert.equal(tickRoute.includes("(err as Error).message"), false);
    assert.equal(observersRoute.includes("(err as Error).message"), false);
    assert.equal(matchesRoute.includes("(err as Error).message"), false);
    assert.equal(storageRoute.includes("(err as Error).message"), false);
    assert.equal(shadowRoute.includes("(err as Error).message"), false);
    assert.equal(benchmarkRoute.includes("(err as Error).message"), false);
  });

  console.log(`\nPhase 4A4 public error sanitization: ${passed} passed, 0 failed.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

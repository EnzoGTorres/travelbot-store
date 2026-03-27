import { config } from "../src/config";
import { ChecksRunPersistenceError, runChecksWithSummary } from "../src/runtime";

interface VercelRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  query?: Record<string, string | string[] | undefined>;
}

interface VercelResponse {
  status(code: number): VercelResponse;
  json(body: unknown): void;
  setHeader(name: string, value: string): void;
}

function readSecretFromRequest(req: VercelRequest): string | undefined {
  const headerValue = req.headers["x-travelbot-secret"];

  if (typeof headerValue === "string" && headerValue.trim()) {
    return headerValue.trim();
  }

  const queryValue = req.query?.secret;

  if (typeof queryValue === "string" && queryValue.trim()) {
    return queryValue.trim();
  }

  return undefined;
}

function readBooleanQueryParam(value: string | string[] | undefined): boolean | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalizedValue = value.trim().toLowerCase();

  if (["1", "true", "yes", "on"].includes(normalizedValue)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalizedValue)) {
    return false;
  }

  return undefined;
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method !== "GET" && req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed. Usa GET o POST." });
    return;
  }

  if (!config.checks.secret) {
    console.error("/api/check rechazado: falta TRAVELBOT_CHECK_SECRET.");
    res.status(500).json({ ok: false, error: "TRAVELBOT_CHECK_SECRET no esta configurado." });
    return;
  }

  const receivedSecret = readSecretFromRequest(req);
  const dryRun = readBooleanQueryParam(req.query?.dryRun) ?? config.checks.dryRun;

  if (!receivedSecret || receivedSecret !== config.checks.secret) {
    console.warn("/api/check rechazado: secret invalido.");
    res.status(401).json({ ok: false, error: "Unauthorized." });
    return;
  }

  try {
    const summary = await runChecksWithSummary({ dryRun });

    console.log(
      `/api/check ok: chequeadas=${summary.checkedCount} elegibles=${summary.alertsEligible} alertas=${summary.alertsSent} skipped=${summary.skipped} errores=${summary.errors} dryRun=${summary.dryRun} store=${summary.storeLabel}`
    );

    res.status(200).json({
      ok: true,
      dryRun: summary.dryRun,
      storageMode: summary.storageMode,
      checkedCount: summary.checkedCount,
      alertsEligible: summary.alertsEligible,
      alertsSent: summary.alertsSent,
      skipped: summary.skipped,
      errors: summary.errors,
      durationMs: summary.durationMs,
      startedAt: summary.startedAt,
      finishedAt: summary.finishedAt,
      store: summary.storeLabel,
      persistence: summary.persistence,
      details: summary.details
    });
  } catch (error: unknown) {
    if (error instanceof ChecksRunPersistenceError) {
      console.error(`/api/check persistence error: ${error.message}`);
      res.status(500).json({
        ok: false,
        error: error.message,
        dryRun: error.summary.dryRun,
        storageMode: error.summary.storageMode,
        checkedCount: error.summary.checkedCount,
        alertsEligible: error.summary.alertsEligible,
        alertsSent: error.summary.alertsSent,
        skipped: error.summary.skipped,
        errors: error.summary.errors,
        durationMs: error.summary.durationMs,
        startedAt: error.summary.startedAt,
        finishedAt: error.summary.finishedAt,
        store: error.summary.storeLabel,
        persistence: error.summary.persistence,
        details: error.summary.details
      });
      return;
    }

    const message = error instanceof Error ? error.message : "Error desconocido.";
    console.error(`/api/check error: ${message}`);
    res.status(500).json({ ok: false, error: message });
  }
}

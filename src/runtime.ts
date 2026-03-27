import { config } from "./config";
import { formatCheckLog, runSearchCheckWithStore } from "./check";
import { getAlertsStoreLabel, readAlertsStore, writeAlertsStore } from "./store";
import { ChecksRunSummary, RunChecksOptions, SearchCheckDetail } from "./types";

export class ChecksRunPersistenceError extends Error {
  constructor(
    message: string,
    public readonly summary: ChecksRunSummary
  ) {
    super(message);
    this.name = "ChecksRunPersistenceError";
  }
}

function resolveDryRun(options: RunChecksOptions | undefined): boolean {
  return options?.dryRun ?? config.checks.dryRun;
}

function buildShortSuccessSummary(result: Parameters<typeof formatCheckLog>[0]): string {
  return [
    `[${result.search.id}]`,
    `status=${result.status}`,
    `eligible=${result.shouldAlert ? "yes" : "no"}`,
    `notification=${result.notification.status}`,
    `price=${result.current.currency} ${result.current.price}`,
    `airline=${result.current.airline}`
  ].join(" ");
}

function buildSuccessDetail(result: Parameters<typeof formatCheckLog>[0]): SearchCheckDetail {
  return {
    searchId: result.search.id,
    searchName: result.search.name,
    ok: true,
    status: result.status,
    dryRun: result.dryRun,
    airline: result.current.airline,
    alertEligible: result.shouldAlert,
    alertSent: result.notification.status === "sent",
    notificationStatus: result.notification.status,
    alertType: result.alertType,
    currentPrice: result.current.price,
    currency: result.current.currency,
    notificationReason: result.notification.reason,
    summary: buildShortSuccessSummary(result),
    log: formatCheckLog(result)
  };
}

function buildErrorDetail(
  searchId: string,
  searchName: string,
  dryRun: boolean,
  error: unknown
): SearchCheckDetail {
  const message = error instanceof Error ? error.message : "Error desconocido.";
  const summary = `[${searchId}] status=error eligible=no notification=skipped`;

  return {
    searchId,
    searchName,
    ok: false,
    dryRun,
    error: message,
    summary,
    log: `${summary}\nBusqueda: ${searchName}\nError: ${message}`
  };
}

function buildBaseSummary(
  startedAt: string,
  startedTime: number,
  dryRun: boolean,
  details: SearchCheckDetail[]
): ChecksRunSummary {
  const finishedAt = new Date().toISOString();

  return {
    startedAt,
    finishedAt,
    durationMs: Date.now() - startedTime,
    dryRun,
    storageMode: config.storage.provider,
    storeLabel: getAlertsStoreLabel(),
    checkedCount: details.length,
    alertsEligible: details.filter((detail) => detail.alertEligible).length,
    alertsSent: details.filter((detail) => detail.alertSent).length,
    skipped: details.filter((detail) => detail.ok && detail.notificationStatus !== "sent").length,
    errors: details.filter((detail) => !detail.ok).length,
    persistence: {
      attempted: false,
      persisted: false,
      retried: false
    },
    details
  };
}

export async function runChecksWithSummary(options?: RunChecksOptions): Promise<ChecksRunSummary> {
  const dryRun = resolveDryRun(options);
  const startedAt = new Date().toISOString();
  const startedTime = Date.now();
  const store = await readAlertsStore();
  const enabledSearches = store.searches.filter((search) => search.enabled);
  const details: SearchCheckDetail[] = [];

  console.log(
    `Inicio de corrida Travelbot: dryRun=${dryRun} storageMode=${config.storage.provider} store=${getAlertsStoreLabel()}`
  );

  for (const search of enabledSearches) {
    try {
      const result = await runSearchCheckWithStore(store, search, { dryRun });
      details.push(buildSuccessDetail(result));
    } catch (error: unknown) {
      details.push(buildErrorDetail(search.id, search.name, dryRun, error));
    }
  }

  const summary = buildBaseSummary(startedAt, startedTime, dryRun, details);

  if (dryRun) {
    summary.persistence = {
      attempted: false,
      persisted: false,
      retried: false
    };
    return summary;
  }

  try {
    const writeResult = await writeAlertsStore(store, {
      updatedSearchIds: enabledSearches.map((search) => search.id)
    });

    summary.persistence = {
      attempted: true,
      persisted: true,
      retried: writeResult.retried
    };

    return summary;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Error desconocido.";

    summary.persistence = {
      attempted: true,
      persisted: false,
      retried: false,
      error: message
    };

    throw new ChecksRunPersistenceError(
      `La corrida termino pero fallo la persistencia final: ${message}`,
      summary
    );
  }
}

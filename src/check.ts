import { getBestFlightPrice } from "./flights";
import { config } from "./config";
import { readAlertsStore, writeAlertsStore } from "./store";
import { sendTelegramMessage } from "./telegram";
import {
  AlertType,
  BestFlightPrice,
  MonitoredSearch,
  NotificationResult,
  RunChecksOptions,
  SearchCheckResult,
  SearchCheckStatus,
  SearchState,
  AlertsStore
} from "./types";

interface CheckExecutionOptions {
  dryRun: boolean;
}

function resolveComparablePrevious(
  previousState: SearchState | undefined,
  current: BestFlightPrice
): { previous: SearchState | undefined; resetReason?: string } {
  if (!previousState) {
    return { previous: undefined };
  }

  if (previousState.lastCurrency !== current.currency) {
    return {
      previous: undefined,
      resetReason: `No se envia: se reinicia referencia por cambio de moneda (${previousState.lastCurrency} -> ${current.currency}).`
    };
  }

  return { previous: previousState };
}

function resolveStatus(
  previousState: SearchState | undefined,
  current: BestFlightPrice
): SearchCheckStatus {
  if (!previousState) {
    return "first_check";
  }

  if (current.price < previousState.lastPrice) {
    return "price_down";
  }

  if (current.price > previousState.lastPrice) {
    return "price_up";
  }

  return "unchanged";
}

function resolveAlertType(
  search: MonitoredSearch,
  status: SearchCheckStatus,
  current: BestFlightPrice
): AlertType | undefined {
  if (status !== "price_down") {
    return undefined;
  }

  if (typeof search.alertBelowPrice === "number" && current.price <= search.alertBelowPrice) {
    return "below_threshold";
  }

  return "price_dropped";
}

function formatTripDate(current: BestFlightPrice): string {
  return current.returnDate
    ? `${current.departureDate} -> ${current.returnDate}`
    : current.departureDate;
}

function formatCurrencyAmount(currency: string, price: number): string {
  return `${currency} ${price}`;
}

function formatPercent(value: number): string {
  return `${value.toFixed(2)}%`;
}

function resolveCheckOptions(options?: RunChecksOptions): CheckExecutionOptions {
  return {
    dryRun: options?.dryRun ?? config.checks.dryRun
  };
}

function buildResolutionSummary(current: BestFlightPrice): string {
  const parts = [
    `Mejor opcion: ${current.metadata.selectedCombinationLabel}`,
    `Combinaciones evaluadas: ${current.metadata.checkedCombinationCount}`
  ];

  if (current.metadata.checkedDestinationCount > 1) {
    parts.push(`Destinos: ${current.metadata.checkedDestinationCount}`);
  }

  if (current.metadata.checkedDepartureDateCount > 1) {
    parts.push(`Fechas ida: ${current.metadata.checkedDepartureDateCount}`);
  }

  if (current.metadata.checkedReturnDateCount > 1) {
    parts.push(`Fechas vuelta: ${current.metadata.checkedReturnDateCount}`);
  }

  if (current.metadata.directOnlyRequested) {
    parts.push(
      current.metadata.directOnlyApplied
        ? "DirectOnly: aplicado"
        : "DirectOnly: sin filtro robusto, degradado"
    );
  }

  return parts.join(" | ");
}

export function formatTelegramAlert(result: SearchCheckResult): string {
  const alertType =
    result.alertType === "below_threshold" ? "Precio bajo tu umbral" : "Precio mas bajo";
  const previousPrice = result.previous
    ? `${result.previous.lastCurrency} ${result.previous.lastPrice}`
    : "n/a";

  return [
    "Travelbot",
    "",
    `Busqueda: ${result.search.name}`,
    `Ruta: ${result.current.origin} -> ${result.current.destination}`,
    `Fecha: ${formatTripDate(result.current)}`,
    `Precio actual: ${result.current.currency} ${result.current.price}`,
    `Precio anterior: ${previousPrice}`,
    `Baja absoluta: ${result.current.currency} ${result.dropAmount}`,
    `Baja porcentual: ${result.dropPercent !== undefined ? formatPercent(result.dropPercent) : "n/a"}`,
    `Tipo de alerta: ${alertType}`,
    buildResolutionSummary(result.current)
  ].join("\n");
}

function isDuplicateAlert(
  previous: SearchState | undefined,
  current: BestFlightPrice,
  alertType: AlertType | undefined
): boolean {
  if (!previous?.lastAlertedAt || !alertType) {
    return false;
  }

  return (
    previous.lastAlertType === alertType &&
    previous.lastAlertedPrice === current.price &&
    previous.lastPrice === current.price &&
    previous.lastAlertedCurrency === current.currency
  );
}

function isRepeatedAlertedPrice(
  previous: SearchState | undefined,
  current: BestFlightPrice
): boolean {
  return Boolean(
    previous?.lastAlertedAt &&
      previous.lastAlertedPrice === current.price &&
      previous.lastPrice === current.price &&
      previous.lastAlertedCurrency === current.currency
  );
}

function getCooldownUntil(
  search: MonitoredSearch,
  previous: SearchState | undefined
): string | undefined {
  if (
    typeof search.alertCooldownHours !== "number" ||
    search.alertCooldownHours <= 0 ||
    !previous?.lastAlertedAt
  ) {
    return undefined;
  }

  const lastAlertedAt = new Date(previous.lastAlertedAt);
  const cooldownUntil = new Date(
    lastAlertedAt.getTime() + search.alertCooldownHours * 60 * 60 * 1000
  );

  if (Date.now() >= cooldownUntil.getTime()) {
    return undefined;
  }

  return cooldownUntil.toISOString();
}

function evaluateMinimumDropRules(
  search: MonitoredSearch,
  current: BestFlightPrice,
  previous: SearchState | undefined
): string | undefined {
  if (!previous || current.price >= previous.lastPrice) {
    return undefined;
  }

  const dropAmount = previous.lastPrice - current.price;
  const dropPercent = previous.lastPrice > 0 ? (dropAmount / previous.lastPrice) * 100 : undefined;

  if (
    typeof search.minimumDropAmount === "number" &&
    dropAmount < search.minimumDropAmount
  ) {
    return `No se envia: la baja fue ${formatCurrencyAmount(current.currency, dropAmount)} y no alcanza minimumDropAmount=${formatCurrencyAmount(current.currency, search.minimumDropAmount)}.`;
  }

  if (
    typeof search.minimumDropPercent === "number" &&
    (dropPercent === undefined || dropPercent < search.minimumDropPercent)
  ) {
    return `No se envia: la baja fue ${dropPercent !== undefined ? formatPercent(dropPercent) : "n/a"} y no alcanza minimumDropPercent=${formatPercent(search.minimumDropPercent)}.`;
  }

  return undefined;
}

function buildSkippedNotification(
  search: MonitoredSearch,
  status: SearchCheckStatus,
  previous: SearchState | undefined,
  current: BestFlightPrice,
  alertType: AlertType | undefined,
  cooldownUntil: string | undefined,
  resetReason?: string
): NotificationResult {
  if (resetReason) {
    return { status: "skipped", reason: resetReason };
  }

  if (status === "first_check") {
    return { status: "skipped", reason: "No se envia: primera consulta." };
  }

  if (status === "unchanged" && isRepeatedAlertedPrice(previous, current)) {
    return { status: "skipped", reason: "No se envia: alerta duplicada." };
  }

  if (status === "unchanged") {
    return { status: "skipped", reason: "No se envia: sin cambios." };
  }

  if (status === "price_up") {
    return { status: "skipped", reason: "No se envia: el precio subio." };
  }

  const minimumDropReason = evaluateMinimumDropRules(search, current, previous);

  if (minimumDropReason) {
    return { status: "skipped", reason: minimumDropReason, alertType };
  }

  if (!alertType) {
    return { status: "skipped", reason: "No se envia: no cumple reglas de alerta." };
  }

  if (isDuplicateAlert(previous, current, alertType)) {
    return { status: "skipped", reason: "No se envia: alerta duplicada.", alertType };
  }

  if (cooldownUntil) {
    return {
      status: "skipped",
      reason: `No se envia: cooldown activo hasta ${cooldownUntil}.`,
      alertType
    };
  }

  if (!config.telegram.isConfigured()) {
    return {
      status: "skipped",
      reason: "No se envia: Telegram no esta configurado.",
      alertType
    };
  }

  return {
    status: "skipped",
    reason: "No se envia: condicion no resuelta.",
    alertType
  };
}

function buildSentNotification(
  current: BestFlightPrice,
  previous: SearchState | undefined,
  alertType: AlertType
): NotificationResult {
  if (alertType === "below_threshold") {
    return {
      status: "sent",
      reason: `Alerta enviada: precio bajo umbral (${formatCurrencyAmount(
        current.currency,
        current.price
      )}).`,
      alertType,
      sentAt: new Date().toISOString()
    };
  }

  return {
    status: "sent",
    reason: `Alerta enviada: bajo de ${formatCurrencyAmount(
      previous?.lastCurrency ?? current.currency,
      previous?.lastPrice ?? current.price
    )} a ${formatCurrencyAmount(current.currency, current.price)}.`,
    alertType,
    sentAt: new Date().toISOString()
  };
}

function buildDryRunNotification(
  current: BestFlightPrice,
  alertType: AlertType
): NotificationResult {
  if (alertType === "below_threshold") {
    return {
      status: "dry_run",
      reason: `Dry-run: alerta elegible por precio bajo umbral (${formatCurrencyAmount(
        current.currency,
        current.price
      )}).`,
      alertType
    };
  }

  return {
    status: "dry_run",
    reason: "Dry-run: alerta elegible, no se envia Telegram ni se persiste estado.",
    alertType
  };
}

function buildSearchState(
  searchId: string,
  current: BestFlightPrice,
  previous: SearchState | undefined,
  notification: NotificationResult
): SearchState {
  return {
    searchId,
    lastPrice: current.price,
    lastCurrency: current.currency,
    lastCheckedAt: new Date().toISOString(),
    lastResult: current,
    lastAlertedPrice:
      notification.status === "sent" ? current.price : previous?.lastAlertedPrice,
    lastAlertedCurrency:
      notification.status === "sent" ? current.currency : previous?.lastAlertedCurrency,
    lastAlertedAt:
      notification.status === "sent" ? notification.sentAt : previous?.lastAlertedAt,
    lastAlertType:
      notification.status === "sent" ? notification.alertType : previous?.lastAlertType
  };
}

async function finalizeSearchCheck(
  search: MonitoredSearch,
  previousState: SearchState | undefined,
  current: BestFlightPrice,
  options: CheckExecutionOptions
): Promise<{ result: SearchCheckResult; nextState: SearchState }> {
  const comparable = resolveComparablePrevious(previousState, current);
  const previous = comparable.previous;
  const status = resolveStatus(previous, current);
  const difference = previous ? current.price - previous.lastPrice : 0;
  const dropAmount =
    previous && current.price < previous.lastPrice ? previous.lastPrice - current.price : 0;
  const dropPercent =
    previous && current.price < previous.lastPrice && previous.lastPrice > 0
      ? (dropAmount / previous.lastPrice) * 100
      : undefined;
  const alertType = resolveAlertType(search, status, current);
  const minimumDropReason = evaluateMinimumDropRules(search, current, previous);
  const cooldownUntil = alertType ? getCooldownUntil(search, previous) : undefined;
  const duplicateAlert = isDuplicateAlert(previous, current, alertType);
  const alertEligible =
    Boolean(alertType) &&
    !comparable.resetReason &&
    !minimumDropReason &&
    !duplicateAlert &&
    !cooldownUntil;

  let notification = buildSkippedNotification(
    search,
    status,
    previous,
    current,
    alertType,
    cooldownUntil,
    comparable.resetReason
  );

  if (alertEligible && options.dryRun && alertType) {
    notification = buildDryRunNotification(current, alertType);
  }

  const shouldAlert = alertEligible;
  const baseResult = {
    search,
    current,
    previous,
    status,
    difference,
    dropAmount,
    dropPercent,
    shouldAlert,
    dryRun: options.dryRun,
    alertType
  };

  if (
    alertEligible &&
    alertType &&
    !options.dryRun &&
    config.telegram.isConfigured()
  ) {
    await sendTelegramMessage(
      formatTelegramAlert({
        ...baseResult,
        notification: { status: "sent", reason: "", alertType }
      }),
      { dryRun: options.dryRun }
    );
    notification = buildSentNotification(current, previous, alertType);
  }

  const nextState = buildSearchState(search.id, current, previousState, notification);

  return {
    result: {
      ...baseResult,
      notification
    },
    nextState
  };
}

export async function runSearchCheckWithStore(
  store: AlertsStore,
  search: MonitoredSearch,
  options?: RunChecksOptions
): Promise<SearchCheckResult> {
  const resolvedOptions = resolveCheckOptions(options);
  const current = await getBestFlightPrice(search);
  const previous = store.states[search.id];
  const { result, nextState } = await finalizeSearchCheck(
    search,
    previous,
    current,
    resolvedOptions
  );

  if (!resolvedOptions.dryRun) {
    store.states[search.id] = nextState;
  }

  return result;
}

export async function runSearchCheck(
  searchId: string,
  options?: RunChecksOptions
): Promise<SearchCheckResult> {
  const resolvedOptions = resolveCheckOptions(options);
  const store = await readAlertsStore();
  const search = store.searches.find((item) => item.id === searchId);

  if (!search) {
    throw new Error(`No existe una busqueda con id "${searchId}".`);
  }

  const result = await runSearchCheckWithStore(store, search, resolvedOptions);

  if (!resolvedOptions.dryRun) {
    await writeAlertsStore(store, { updatedSearchIds: [search.id] });
  }

  return result;
}

export async function runAllSearchChecks(options?: RunChecksOptions): Promise<SearchCheckResult[]> {
  const resolvedOptions = resolveCheckOptions(options);
  const store = await readAlertsStore();
  const enabledSearches = store.searches.filter((search) => search.enabled);

  if (enabledSearches.length === 0) {
    return [];
  }

  const results: SearchCheckResult[] = [];

  for (const search of enabledSearches) {
    const result = await runSearchCheckWithStore(store, search, resolvedOptions);
    results.push(result);
  }

  if (!resolvedOptions.dryRun) {
    await writeAlertsStore(store, {
      updatedSearchIds: enabledSearches.map((search) => search.id)
    });
  }

  return results;
}

export function formatCheckLog(result: SearchCheckResult): string {
  const route = `${result.current.origin} -> ${result.current.destination}`;
  const tripDate = result.current.returnDate
    ? `${result.current.departureDate} / ${result.current.returnDate}`
    : result.current.departureDate;
  const currentPrice = `${result.current.currency} ${result.current.price}`;
  const metadataNotes = result.current.metadata.notes.length > 0
    ? `Notas: ${result.current.metadata.notes.join(" | ")}`
    : undefined;

  switch (result.status) {
    case "first_check":
      return [
        `[${result.search.id}] Primera consulta`,
        `Busqueda: ${result.search.name}`,
        `Ruta: ${route}`,
        `Fecha: ${tripDate}`,
        `Precio actual: ${currentPrice}`,
        buildResolutionSummary(result.current),
        metadataNotes,
        `Alerta: ${result.notification.reason}`
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n");
    case "price_down":
      return [
        `[${result.search.id}] Bajo de precio`,
        `Busqueda: ${result.search.name}`,
        `Antes: ${result.previous?.lastCurrency} ${result.previous?.lastPrice}`,
        `Ahora: ${currentPrice}`,
        `Baja absoluta: ${result.current.currency} ${result.dropAmount}`,
        `Baja porcentual: ${result.dropPercent !== undefined ? formatPercent(result.dropPercent) : "n/a"}`,
        `Tipo: ${result.alertType === "below_threshold" ? "below_threshold" : "price_dropped"}`,
        buildResolutionSummary(result.current),
        metadataNotes,
        `Alerta: ${result.notification.reason}`
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n");
    case "price_up":
      return [
        `[${result.search.id}] Subio de precio`,
        `Busqueda: ${result.search.name}`,
        `Antes: ${result.previous?.lastCurrency} ${result.previous?.lastPrice}`,
        `Ahora: ${currentPrice}`,
        `Diferencia: ${result.current.currency} ${result.difference}`,
        buildResolutionSummary(result.current),
        metadataNotes,
        `Alerta: ${result.notification.reason}`
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n");
    case "unchanged":
      return [
        `[${result.search.id}] Sin cambios`,
        `Busqueda: ${result.search.name}`,
        `Precio: ${currentPrice}`,
        `Ultimo chequeo previo: ${result.previous?.lastCheckedAt ?? "n/a"}`,
        buildResolutionSummary(result.current),
        metadataNotes,
        `Alerta: ${result.notification.reason}`
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n");
  }
}

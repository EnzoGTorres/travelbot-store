import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";
import { config } from "./config";
import { HttpRequestError, requestJson } from "./http";
import {
  AlertsStore,
  BestFlightPrice,
  DEFAULT_AIRLINE_LABEL,
  MonitoredSearch,
  SearchState,
  StoreWriteOptions,
  StoreWriteResult
} from "./types";

const DEFAULT_DATA_DIRECTORY = path.join(process.cwd(), "data");
const ALERTS_FILE_PATH = config.storage.filePath
  ? path.resolve(process.cwd(), config.storage.filePath)
  : path.join(DEFAULT_DATA_DIRECTORY, "alerts.json");
const ALERTS_EXAMPLE_FILE_PATH = path.join(DEFAULT_DATA_DIRECTORY, "alerts.example.json");
const GITHUB_API_BASE_URL = "https://api.github.com";

interface GithubContentResponse {
  sha: string;
  content?: string;
  encoding?: string;
}

interface GithubContentWriteResponse {
  content?: {
    sha?: string;
    path?: string;
  };
  commit?: {
    sha?: string;
    html_url?: string;
  };
}

interface GithubRepositoryResponse {
  full_name: string;
  private: boolean;
  default_branch: string;
}

interface GithubStoreFileReadResult {
  store: AlertsStore;
  sha?: string;
  rawContent?: string;
}

interface GithubErrorInfo {
  status?: number;
  message: string;
  detail?: string;
}

type GithubDiagnosticContext = "repo_access" | "file_read" | "file_create" | "file_write";

export interface GitHubStoreDiagnosticResult {
  ok: boolean;
  repoAccessible: boolean;
  fileFound: boolean;
  fileCreated: boolean;
  readSucceeded: boolean;
  writeSucceeded: boolean;
  storeLabel: string;
}

export interface GitHubStoreIntegrationTestOptions {
  dryRun?: boolean;
}

export interface GitHubStoreIntegrationTestResult {
  ok: boolean;
  dryRun: boolean;
  repoAccessible: boolean;
  fileRead: boolean;
  jsonValid: boolean;
  writeSucceeded: boolean;
  verificationSucceeded: boolean;
  revertSucceeded: boolean;
  storeLabel: string;
  testTimestamp: string;
}

export function loadExampleSearches(): MonitoredSearch[] {
  return [
    {
      id: "eze-espana-roundtrip-may-aug-2026",
      name: "España ida y vuelta desde EZE (MAD/BCN, mayo-agosto 2026)",
      enabled: true,
      params: {
        origin: "EZE",
        destinations: ["MAD", "BCN"],
        departureDateRange: {
          from: "2026-05-01",
          to: "2026-08-31",
          stepDays: 14,
          maxOptions: 8
        },
        returnDateRange: {
          from: "2026-05-10",
          to: "2026-09-15",
          stepDays: 14,
          maxOptions: 8
        },
        adults: 1,
        currency: "USD",
        language: "es",
        market: "ar"
      },
      alertBelowPrice: 1090,
      minimumDropAmount: 120,
      minimumDropPercent: 8,
      alertCooldownHours: 24
    },
    {
      id: "eze-espana-oneway-may-aug-2026",
      name: "España solo ida desde EZE (MAD/BCN, mayo-agosto 2026)",
      enabled: true,
      params: {
        origin: "EZE",
        destinations: ["MAD", "BCN"],
        departureDateRange: {
          from: "2026-05-01",
          to: "2026-08-31",
          stepDays: 10,
          maxOptions: 10
        },
        adults: 1,
        currency: "USD",
        language: "es",
        market: "ar"
      },
      alertBelowPrice: 560,
      minimumDropAmount: 60,
      minimumDropPercent: 8,
      alertCooldownHours: 18
    },
    {
      id: "eze-espana-returnlike-may-aug-2026",
      name: "España -> EZE tramo simple (MAD/BCN, mayo-septiembre 2026)",
      enabled: true,
      params: {
        origin: "MAD",
        origins: ["BCN"],
        destination: "EZE",
        departureDateRange: {
          from: "2026-05-10",
          to: "2026-09-15",
          stepDays: 10,
          maxOptions: 10
        },
        adults: 1,
        currency: "USD",
        language: "es",
        market: "ar"
      },
      alertBelowPrice: 620,
      minimumDropAmount: 70,
      minimumDropPercent: 8,
      alertCooldownHours: 18
    }
  ];
}

function createInitialStore(): AlertsStore {
  return {
    searches: loadExampleSearches(),
    states: {}
  };
}

function normalizeLastResult(value: Partial<BestFlightPrice> | undefined): BestFlightPrice | undefined {
  if (
    !value ||
    typeof value.price !== "number" ||
    typeof value.currency !== "string" ||
    typeof value.origin !== "string" ||
    typeof value.destination !== "string" ||
    typeof value.departureDate !== "string"
  ) {
    return undefined;
  }

  return {
    price: value.price,
    currency: value.currency,
    origin: value.origin,
    destination: value.destination,
    departureDate: value.departureDate,
    returnDate: typeof value.returnDate === "string" ? value.returnDate : undefined,
    airline: typeof value.airline === "string" && value.airline.trim()
      ? value.airline.trim()
      : DEFAULT_AIRLINE_LABEL,
    market: typeof value.market === "string" ? value.market : "unknown",
    language: typeof value.language === "string" ? value.language : "unknown",
    directOnly: typeof value.directOnly === "boolean" ? value.directOnly : false,
    metadata: {
      checkedOriginCount:
        typeof value.metadata?.checkedOriginCount === "number"
          ? value.metadata.checkedOriginCount
          : 1,
      checkedCombinationCount:
        typeof value.metadata?.checkedCombinationCount === "number"
          ? value.metadata.checkedCombinationCount
          : 1,
      checkedDestinationCount:
        typeof value.metadata?.checkedDestinationCount === "number"
          ? value.metadata.checkedDestinationCount
          : 1,
      checkedDepartureDateCount:
        typeof value.metadata?.checkedDepartureDateCount === "number"
          ? value.metadata.checkedDepartureDateCount
          : 1,
      checkedReturnDateCount:
        typeof value.metadata?.checkedReturnDateCount === "number"
          ? value.metadata.checkedReturnDateCount
          : value.returnDate
            ? 1
            : 0,
      selectedCombinationLabel:
        typeof value.metadata?.selectedCombinationLabel === "string"
          ? value.metadata.selectedCombinationLabel
          : value.returnDate
            ? `${value.origin} -> ${value.destination} | ${value.departureDate} -> ${value.returnDate}`
            : `${value.origin} -> ${value.destination} | ${value.departureDate}`,
      directOnlyRequested:
        typeof value.metadata?.directOnlyRequested === "boolean"
          ? value.metadata.directOnlyRequested
          : false,
      directOnlyApplied:
        typeof value.metadata?.directOnlyApplied === "boolean"
          ? value.metadata.directOnlyApplied
          : false,
      notes: Array.isArray(value.metadata?.notes)
        ? value.metadata.notes.filter((note): note is string => typeof note === "string")
        : []
    }
  };
}

function normalizeState(searchId: string, state: Partial<SearchState>): SearchState | undefined {
  const normalizedLastResult = normalizeLastResult(
    state.lastResult as Partial<BestFlightPrice> | undefined
  );

  if (
    typeof state.lastPrice !== "number" ||
    typeof state.lastCurrency !== "string" ||
    typeof state.lastCheckedAt !== "string" ||
    !normalizedLastResult
  ) {
    return undefined;
  }

  return {
    searchId,
    lastPrice: state.lastPrice,
    lastCurrency: state.lastCurrency,
    lastCheckedAt: state.lastCheckedAt,
    lastResult: normalizedLastResult,
    lastAlertedPrice:
      typeof state.lastAlertedPrice === "number" ? state.lastAlertedPrice : undefined,
    lastAlertedCurrency:
      typeof state.lastAlertedCurrency === "string" ? state.lastAlertedCurrency : undefined,
    lastAlertedAt:
      typeof state.lastAlertedAt === "string" ? state.lastAlertedAt : undefined,
    lastAlertType:
      state.lastAlertType === "price_dropped" || state.lastAlertType === "below_threshold"
        ? state.lastAlertType
        : undefined
  };
}

function normalizeStore(store: Partial<AlertsStore>): AlertsStore {
  const normalizedStates = Object.entries(store.states ?? {}).reduce<Record<string, SearchState>>(
    (accumulator, [searchId, state]) => {
      const normalizedState = normalizeState(searchId, state ?? {});

      if (normalizedState) {
        accumulator[searchId] = normalizedState;
      }

      return accumulator;
    },
    {}
  );

  return {
    searches: Array.isArray(store.searches) ? store.searches : loadExampleSearches(),
    states: normalizedStates
  };
}

function getGithubStoreConfig() {
  const githubConfig = config.storage.github;

  if (!githubConfig.owner || !githubConfig.repo || !githubConfig.path || !githubConfig.token) {
    throw new Error(
      "Falta configuracion del store GitHub. Revisa GITHUB_STORE_OWNER, GITHUB_STORE_REPO, GITHUB_STORE_PATH y GITHUB_STORE_TOKEN."
    );
  }

  return githubConfig;
}

function getGithubHeaders() {
  const githubConfig = getGithubStoreConfig();

  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${githubConfig.token}`,
    "User-Agent": "travelbot"
  };
}

function getGithubRepoUrl(): string {
  const githubConfig = getGithubStoreConfig();

  return `${GITHUB_API_BASE_URL}/repos/${githubConfig.owner}/${githubConfig.repo}`;
}

function getGithubContentsUrl(): string {
  const githubConfig = getGithubStoreConfig();

  return `${getGithubRepoUrl()}/contents/${githubConfig.path}`;
}

function getGithubStoreLabelFromConfig(): string {
  const githubConfig = getGithubStoreConfig();

  return `github://${githubConfig.owner}/${githubConfig.repo}/${githubConfig.path}@${githubConfig.branch}`;
}

function extractGithubErrorInfo(error: unknown, fallbackMessage: string): GithubErrorInfo {
  if (!(error instanceof HttpRequestError)) {
    if (error instanceof Error) {
      return { message: error.message };
    }

    return { message: fallbackMessage };
  }

  const status = error.status;
  const message = error.message || fallbackMessage;
  const detail = error.detail;

  return {
    status,
    message,
    detail
  };
}

function getGithubDiagnosticSuggestion(
  context: GithubDiagnosticContext,
  status: number | undefined
): string {
  const githubConfig = getGithubStoreConfig();

  switch (status) {
    case 401:
      return "Sugerencia: revisa GITHUB_STORE_TOKEN. Debe ser valido, no estar expirado y pertenecer a un token con acceso al repo.";
    case 403:
      return "Sugerencia: el token necesita permiso Contents con lectura y escritura sobre el repo. Si es fine-grained, confirma tambien que el repositorio este seleccionado.";
    case 404:
      if (context === "repo_access") {
        return `Sugerencia: verifica GITHUB_STORE_OWNER (${githubConfig.owner}) y GITHUB_STORE_REPO (${githubConfig.repo}), y que el token pueda ver ese repositorio.`;
      }

      if (context === "file_read") {
        return `Sugerencia: verifica GITHUB_STORE_PATH (${githubConfig.path}) y GITHUB_STORE_BRANCH (${githubConfig.branch}). Si el archivo no existe, el diagnostico intentara crearlo.`;
      }

      return `Sugerencia: verifica que el branch ${githubConfig.branch} exista y que el token tenga permiso de escritura Contents sobre ${githubConfig.owner}/${githubConfig.repo}.`;
    default:
      return "Sugerencia: revisa owner, repo, branch, path y permisos del token; si usas un token fine-grained, confirma acceso explicito al repositorio.";
  }
}

function logGithubDiagnosticError(
  context: GithubDiagnosticContext,
  label: string,
  error: unknown
): GithubErrorInfo {
  const info = extractGithubErrorInfo(error, label);

  if (info.status) {
    console.error(`[GitHub Store] ${label}: HTTP ${info.status} - ${info.message}`);
  } else {
    console.error(`[GitHub Store] ${label}: ${info.message}`);
  }

  if (info.detail && info.detail !== info.message) {
    console.error(`[GitHub Store] Detalle HTTP: ${info.detail}`);
  }

  console.info(`[GitHub Store] ${getGithubDiagnosticSuggestion(context, info.status)}`);

  return info;
}

function formatGithubOperationError(prefix: string, error: unknown): Error {
  const info = extractGithubErrorInfo(error, prefix);
  const detailSuffix = info.detail && info.detail !== info.message ? ` ${info.detail}` : "";

  if (info.status) {
    return new Error(`${prefix}. Status ${info.status}: ${info.message}${detailSuffix}`);
  }

  return new Error(`${prefix}: ${info.message}`);
}

function isRecoverableGithubConflictStatus(status: number | undefined): boolean {
  return status === 409 || status === 412 || status === 422;
}

function mergeStoreForRetry(
  latestStore: AlertsStore,
  nextStore: AlertsStore,
  options: StoreWriteOptions | undefined
): AlertsStore {
  if (!options?.updatedSearchIds || options.updatedSearchIds.length === 0) {
    return nextStore;
  }

  const mergedStates = { ...latestStore.states };

  for (const searchId of options.updatedSearchIds) {
    const nextState = nextStore.states[searchId];

    if (nextState) {
      mergedStates[searchId] = nextState;
    }
  }

  return {
    searches: latestStore.searches,
    states: mergedStates
  };
}

async function readGithubStoreFile(
  options?: { allowMissing?: boolean }
): Promise<GithubStoreFileReadResult> {
  const githubConfig = getGithubStoreConfig();
  const allowMissing = options?.allowMissing ?? true;

  try {
    const url = new URL(getGithubContentsUrl());
    url.searchParams.set("ref", githubConfig.branch);
    const response = await requestJson<GithubContentResponse>(url, {
      headers: getGithubHeaders()
    });
    const encodedContent = response.content?.replace(/\n/g, "");

    if (!encodedContent || response.encoding !== "base64") {
      throw new Error("GitHub devolvio un contenido invalido para el store JSON.");
    }

    const decodedContent = Buffer.from(encodedContent, "base64").toString("utf-8");
    const parsedContent = JSON.parse(decodedContent) as Partial<AlertsStore>;

    return {
      store: normalizeStore(parsedContent),
      sha: response.sha,
      rawContent: decodedContent
    };
  } catch (error: unknown) {
    if (allowMissing && error instanceof HttpRequestError && error.status === 404) {
      console.warn("Store GitHub no existe todavia. Se usara un store inicial en memoria.");
      return { store: createInitialStore() };
    }

    throw formatGithubOperationError("No se pudo leer el store en GitHub", error);
  }
}

async function putGithubStoreFileContent(
  contentText: string,
  message: string,
  sha?: string
): Promise<GithubContentWriteResponse> {
  const githubConfig = getGithubStoreConfig();

  return requestJson<GithubContentWriteResponse>(getGithubContentsUrl(), {
    method: "PUT",
    headers: getGithubHeaders(),
    body: {
      message,
      content: Buffer.from(contentText, "utf-8").toString("base64"),
      branch: githubConfig.branch,
      sha
    }
  });
}

async function writeGithubStoreFile(
  store: AlertsStore,
  options?: StoreWriteOptions
): Promise<StoreWriteResult> {
  let nextStore = store;
  let retried = false;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const current = await readGithubStoreFile();

    try {
      await putGithubStoreFileContent(
        JSON.stringify(nextStore, null, 2),
        "chore: update travelbot alerts store",
        current.sha
      );

      if (retried) {
        console.log("Store GitHub persistido luego de reintento por conflicto.");
      }

      return {
        mode: "github",
        retried
      };
    } catch (error: unknown) {
      if (error instanceof HttpRequestError) {
        const status = error.status;

        if (attempt === 1 && isRecoverableGithubConflictStatus(status)) {
          retried = true;
          console.warn(
            `Conflicto al persistir store GitHub (status ${status ?? "unknown"}). Se reintenta una vez con sha fresco.`
          );
          nextStore = mergeStoreForRetry(current.store, nextStore, options);
          continue;
        }

        throw formatGithubOperationError("No se pudo escribir el store en GitHub", error);
      }

      throw error;
    }
  }

  throw new Error("No se pudo escribir el store en GitHub despues del reintento.");
}

async function readGithubRepository(): Promise<GithubRepositoryResponse> {
  return requestJson<GithubRepositoryResponse>(getGithubRepoUrl(), {
    headers: getGithubHeaders()
  });
}

function parseGithubStoreJsonDocument(rawContent: string): Record<string, unknown> {
  const parsed = JSON.parse(rawContent) as unknown;

  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("El archivo debe contener un objeto JSON en el nivel superior.");
  }

  return parsed as Record<string, unknown>;
}

function buildGithubStoreIntegrationPayload(
  document: Record<string, unknown>,
  testTimestamp: string
): string {
  return JSON.stringify(
    {
      ...document,
      __testWrite: {
        timestamp: testTimestamp,
        source: "travelbot",
        type: "integration-test"
      }
    },
    null,
    2
  );
}

function hasMatchingTestWriteMarker(
  document: Record<string, unknown>,
  testTimestamp: string
): boolean {
  const marker = document.__testWrite;

  return (
    typeof marker === "object" &&
    marker !== null &&
    "timestamp" in marker &&
    marker.timestamp === testTimestamp
  );
}

async function ensureLocalAlertsFilesExist(): Promise<void> {
  await mkdir(path.dirname(ALERTS_FILE_PATH), { recursive: true });
  await mkdir(DEFAULT_DATA_DIRECTORY, { recursive: true });

  try {
    await readFile(ALERTS_FILE_PATH, "utf-8");
  } catch {
    const initialStore = createInitialStore();
    const content = JSON.stringify(initialStore, null, 2);

    await writeFile(ALERTS_FILE_PATH, content, "utf-8");
  }

  try {
    await readFile(ALERTS_EXAMPLE_FILE_PATH, "utf-8");
  } catch {
    const exampleStore = createInitialStore();
    const content = JSON.stringify(exampleStore, null, 2);

    await writeFile(ALERTS_EXAMPLE_FILE_PATH, content, "utf-8");
  }
}

async function readLocalAlertsStore(): Promise<AlertsStore> {
  await ensureLocalAlertsFilesExist();

  const rawContent = await readFile(ALERTS_FILE_PATH, "utf-8");
  const parsedContent = JSON.parse(rawContent) as Partial<AlertsStore>;

  return normalizeStore(parsedContent);
}

async function writeLocalAlertsStore(store: AlertsStore): Promise<void> {
  await ensureLocalAlertsFilesExist();
  await writeFile(ALERTS_FILE_PATH, JSON.stringify(store, null, 2), "utf-8");
}

export async function ensureAlertsFileExists(): Promise<void> {
  if (config.storage.provider === "file") {
    await ensureLocalAlertsFilesExist();
  }
}

export async function readAlertsStore(): Promise<AlertsStore> {
  return config.storage.provider === "github"
    ? (await readGithubStoreFile()).store
    : readLocalAlertsStore();
}

export async function writeAlertsStore(
  store: AlertsStore,
  options?: StoreWriteOptions
): Promise<StoreWriteResult> {
  if (config.storage.provider === "github") {
    return writeGithubStoreFile(store, options);
  }

  await writeLocalAlertsStore(store);

  return {
    mode: "file",
    retried: false
  };
}

export async function runGitHubStoreIntegrationTest(
  options?: GitHubStoreIntegrationTestOptions
): Promise<GitHubStoreIntegrationTestResult> {
  const dryRun = options?.dryRun ?? false;
  const testTimestamp = new Date().toISOString();
  const result: GitHubStoreIntegrationTestResult = {
    ok: false,
    dryRun,
    repoAccessible: false,
    fileRead: false,
    jsonValid: false,
    writeSucceeded: false,
    verificationSucceeded: false,
    revertSucceeded: false,
    storeLabel: getGithubStoreLabelFromConfig(),
    testTimestamp
  };

  let originalRawContent: string | undefined;
  let revertSha: string | undefined;
  let shouldRevert = false;

  console.log("[GitHub Store] Iniciando prueba de integracion...");
  console.log(`[GitHub Store] Destino: ${result.storeLabel}`);
  console.log(`[GitHub Store] DRY_RUN=${dryRun}`);
  console.log("[GitHub Store] Paso 1/6: verificando acceso al repositorio...");

  try {
    await readGithubRepository();
    result.repoAccessible = true;
    console.log("[GitHub Store] Repo accesible");
  } catch (error: unknown) {
    logGithubDiagnosticError("repo_access", "No se pudo acceder al repositorio", error);
    return result;
  }

  console.log("[GitHub Store] Paso 2/6: leyendo data/alerts.json...");

  let storeFile: GithubStoreFileReadResult;

  try {
    storeFile = await readGithubStoreFile({ allowMissing: false });
    result.fileRead = true;
    originalRawContent = storeFile.rawContent;
    revertSha = storeFile.sha;
    console.log("[GitHub Store] Archivo leido correctamente");
  } catch (error: unknown) {
    logGithubDiagnosticError("file_read", "No se pudo leer el archivo del store", error);
    return result;
  }

  if (!storeFile.sha || !storeFile.rawContent) {
    console.error("[GitHub Store] Error: el archivo existe pero GitHub no devolvio sha o contenido.");
    return result;
  }

  console.log("[GitHub Store] Paso 3/6: parseando JSON...");

  let parsedDocument: Record<string, unknown>;

  try {
    parsedDocument = parseGithubStoreJsonDocument(storeFile.rawContent);
    result.jsonValid = true;
    console.log("[GitHub Store] JSON valido");
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "No se pudo parsear el JSON del store.";
    console.error(`[GitHub Store] Error de parseo JSON: ${message}`);
    return result;
  }

  if (dryRun) {
    result.ok = true;
    console.log("[GitHub Store] DRY_RUN activo. Se omite la escritura y la verificacion remota.");
    return result;
  }

  console.log("[GitHub Store] Paso 4/6: escribiendo marca temporal de prueba...");

  try {
    const response = await putGithubStoreFileContent(
      buildGithubStoreIntegrationPayload(parsedDocument, testTimestamp),
      `chore: travelbot github store integration test ${testTimestamp}`,
      storeFile.sha
    );
    result.writeSucceeded = true;
    revertSha = response.content?.sha ?? revertSha;
    shouldRevert = true;
    console.log("[GitHub Store] Write OK");
  } catch (error: unknown) {
    logGithubDiagnosticError("file_write", "No se pudo escribir el archivo del store", error);
    return result;
  }

  console.log("[GitHub Store] Paso 5/6: verificando el cambio remoto...");

  try {
    const verificationFile = await readGithubStoreFile({ allowMissing: false });

    if (!verificationFile.rawContent) {
      throw new Error("GitHub no devolvio el contenido actualizado del archivo.");
    }

    const verifiedDocument = parseGithubStoreJsonDocument(verificationFile.rawContent);

    if (!hasMatchingTestWriteMarker(verifiedDocument, testTimestamp)) {
      throw new Error("El campo __testWrite no coincide con el timestamp esperado.");
    }

    result.verificationSucceeded = true;
    revertSha = verificationFile.sha ?? revertSha;
    console.log("[GitHub Store] Verificacion OK");
  } catch (error: unknown) {
    if (error instanceof SyntaxError) {
      console.error(`[GitHub Store] Error de parseo JSON: ${error.message}`);
    } else if (error instanceof HttpRequestError) {
      logGithubDiagnosticError("file_read", "No se pudo releer el archivo para verificar", error);
    } else {
      const message =
        error instanceof Error ? error.message : "No se pudo verificar el cambio remoto.";
      console.error(`[GitHub Store] Error de verificacion: ${message}`);
    }
  } finally {
    if (shouldRevert && originalRawContent && revertSha) {
      console.log("[GitHub Store] Paso 6/6: revirtiendo el cambio temporal...");

      try {
        await putGithubStoreFileContent(
          originalRawContent,
          `chore: revert travelbot github store integration test ${testTimestamp}`,
          revertSha
        );
        result.revertSucceeded = true;
        console.log("[GitHub Store] Revert OK");
      } catch (error: unknown) {
        logGithubDiagnosticError("file_write", "No se pudo revertir el cambio temporal", error);
      }
    }
  }

  result.ok =
    result.repoAccessible &&
    result.fileRead &&
    result.jsonValid &&
    result.writeSucceeded &&
    result.verificationSucceeded &&
    result.revertSucceeded;

  return result;
}

export async function testGitHubStoreConnection(): Promise<GitHubStoreDiagnosticResult> {
  const result: GitHubStoreDiagnosticResult = {
    ok: false,
    repoAccessible: false,
    fileFound: false,
    fileCreated: false,
    readSucceeded: false,
    writeSucceeded: false,
    storeLabel: getGithubStoreLabelFromConfig()
  };

  console.log("[GitHub Store] Iniciando diagnostico de conexion...");
  console.log(`[GitHub Store] Destino: ${result.storeLabel}`);
  console.log("[GitHub Store] Paso 1/4: verificando acceso al repositorio...");

  try {
    const repo = await readGithubRepository();
    result.repoAccessible = true;
    console.log(
      `[GitHub Store] Repo accesible: ${repo.full_name} (default_branch=${repo.default_branch}, privado=${repo.private ? "si" : "no"})`
    );
  } catch (error: unknown) {
    logGithubDiagnosticError("repo_access", "No se pudo acceder al repositorio", error);
    return result;
  }

  console.log("[GitHub Store] Paso 2/4: leyendo archivo del store...");

  let storeFile: GithubStoreFileReadResult;

  try {
    storeFile = await readGithubStoreFile();
    result.readSucceeded = true;

    if (storeFile.sha) {
      result.fileFound = true;
      console.log(`[GitHub Store] Archivo encontrado y leido correctamente. sha=${storeFile.sha}`);
    } else {
      console.warn("[GitHub Store] Archivo no encontrado. Se intentara crearlo con contenido base.");
    }
  } catch (error: unknown) {
    logGithubDiagnosticError("file_read", "No se pudo leer el archivo del store", error);
    return result;
  }

  if (!storeFile.sha) {
    console.log("[GitHub Store] Paso 3/4: creando archivo base...");

    try {
      const response = await putGithubStoreFileContent(
        JSON.stringify(createInitialStore(), null, 2),
        "chore: bootstrap travelbot alerts store"
      );
      result.fileCreated = true;
      result.writeSucceeded = true;
      result.ok = true;
      console.log(
        `[GitHub Store] Archivo creado correctamente en ${response.content?.path ?? getGithubStoreConfig().path}. sha=${response.content?.sha ?? "unknown"}`
      );
      console.log("[GitHub Store] Paso 4/4: diagnostico completado. Lectura y escritura OK.");
      return result;
    } catch (error: unknown) {
      logGithubDiagnosticError("file_create", "No se pudo crear el archivo del store", error);
      return result;
    }
  }

  console.log("[GitHub Store] Paso 3/4: validando escritura con un write probe...");

  try {
    const response = await putGithubStoreFileContent(
      storeFile.rawContent ?? JSON.stringify(storeFile.store, null, 2),
      "chore: github store diagnostic write probe",
      storeFile.sha
    );
    result.writeSucceeded = true;
    result.ok = true;
    console.log(
      `[GitHub Store] Write probe exitoso. commit=${response.commit?.sha ?? "unknown"} sha=${response.content?.sha ?? "unknown"}`
    );
    console.log("[GitHub Store] Paso 4/4: diagnostico completado. Repo, lectura y escritura OK.");
    return result;
  } catch (error: unknown) {
    logGithubDiagnosticError("file_write", "No se pudo completar el write probe", error);
    return result;
  }
}

export function getAlertsStoreLabel(): string {
  if (config.storage.provider === "github") {
    return getGithubStoreLabelFromConfig();
  }

  return ALERTS_FILE_PATH;
}

export { ALERTS_FILE_PATH, ALERTS_EXAMPLE_FILE_PATH };

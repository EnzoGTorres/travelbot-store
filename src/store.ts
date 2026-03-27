import axios, { AxiosError } from "axios";
import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";
import { config } from "./config";
import {
  AlertsStore,
  BestFlightPrice,
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

interface GithubStoreFileReadResult {
  store: AlertsStore;
  sha?: string;
}

export function loadExampleSearches(): MonitoredSearch[] {
  return [
    {
      id: "eze-mad-may-2026",
      name: "Buenos Aires a Madrid en mayo 2026",
      enabled: true,
      params: {
        origin: "EZE",
        destination: "MAD",
        departureDate: "2026-05-10",
        adults: 1
      },
      alertBelowPrice: 800,
      alertCooldownHours: 12
    },
    {
      id: "eze-mad-bcn-flex-jun-2026",
      name: "Buenos Aires a Madrid o Barcelona con fechas flexibles",
      enabled: false,
      params: {
        origin: "EZE",
        destinations: ["MAD", "BCN"],
        departureDateRange: {
          from: "2026-06-10",
          to: "2026-06-16",
          maxOptions: 4
        },
        returnDateRange: {
          from: "2026-06-24",
          to: "2026-06-30",
          maxOptions: 4
        },
        adults: 1,
        currency: "EUR",
        language: "es",
        market: "ar",
        directOnly: true
      },
      minimumDropAmount: 40,
      minimumDropPercent: 5,
      alertCooldownHours: 24
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
    market: typeof value.market === "string" ? value.market : "unknown",
    language: typeof value.language === "string" ? value.language : "unknown",
    directOnly: typeof value.directOnly === "boolean" ? value.directOnly : false,
    metadata: {
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

async function readGithubStoreFile(): Promise<GithubStoreFileReadResult> {
  const githubConfig = getGithubStoreConfig();
  const url = `${GITHUB_API_BASE_URL}/repos/${githubConfig.owner}/${githubConfig.repo}/contents/${githubConfig.path}`;

  try {
    const response = await axios.get<GithubContentResponse>(url, {
      headers: getGithubHeaders(),
      params: { ref: githubConfig.branch }
    });
    const encodedContent = response.data.content?.replace(/\n/g, "");

    if (!encodedContent || response.data.encoding !== "base64") {
      throw new Error("GitHub devolvio un contenido invalido para el store JSON.");
    }

    const decodedContent = Buffer.from(encodedContent, "base64").toString("utf-8");
    const parsedContent = JSON.parse(decodedContent) as Partial<AlertsStore>;

    return {
      store: normalizeStore(parsedContent),
      sha: response.data.sha
    };
  } catch (error: unknown) {
    if (axios.isAxiosError(error) && error.response?.status === 404) {
      console.warn("Store GitHub no existe todavia. Se usara un store inicial en memoria.");
      return { store: createInitialStore() };
    }

    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      const detail =
        typeof error.response?.data === "object" && error.response?.data !== null
          ? JSON.stringify(error.response.data)
          : undefined;

      throw new Error(
        status
          ? `No se pudo leer el store en GitHub. Status ${status}.${detail ? ` ${detail}` : ""}`
          : "No se pudo leer el store en GitHub."
      );
    }

    if (error instanceof Error) {
      throw new Error(`No se pudo leer el store en GitHub: ${error.message}`);
    }

    throw error;
  }
}

async function writeGithubStoreFile(
  store: AlertsStore,
  options?: StoreWriteOptions
): Promise<StoreWriteResult> {
  const githubConfig = getGithubStoreConfig();
  const url = `${GITHUB_API_BASE_URL}/repos/${githubConfig.owner}/${githubConfig.repo}/contents/${githubConfig.path}`;
  let nextStore = store;
  let retried = false;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const current = await readGithubStoreFile();
    const content = Buffer.from(JSON.stringify(nextStore, null, 2), "utf-8").toString("base64");

    try {
      await axios.put(
        url,
        {
          message: "chore: update travelbot alerts store",
          content,
          branch: githubConfig.branch,
          sha: current.sha
        },
        {
          headers: getGithubHeaders()
        }
      );

      if (retried) {
        console.log("Store GitHub persistido luego de reintento por conflicto.");
      }

      return {
        mode: "github",
        retried
      };
    } catch (error: unknown) {
      if (error instanceof AxiosError) {
        const status = error.response?.status;

        if (attempt === 1 && isRecoverableGithubConflictStatus(status)) {
          retried = true;
          console.warn(
            `Conflicto al persistir store GitHub (status ${status ?? "unknown"}). Se reintenta una vez con sha fresco.`
          );
          nextStore = mergeStoreForRetry(current.store, nextStore, options);
          continue;
        }

        const detail =
          typeof error.response?.data === "object" && error.response?.data !== null
            ? JSON.stringify(error.response.data)
            : undefined;

        throw new Error(
          status
            ? `No se pudo escribir el store en GitHub. Status ${status}.${detail ? ` ${detail}` : ""}`
            : "No se pudo escribir el store en GitHub."
        );
      }

      throw error;
    }
  }

  throw new Error("No se pudo escribir el store en GitHub despues del reintento.");
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

export function getAlertsStoreLabel(): string {
  if (config.storage.provider === "github") {
    const githubConfig = config.storage.github;
    return `github://${githubConfig.owner}/${githubConfig.repo}/${githubConfig.path}@${githubConfig.branch}`;
  }

  return ALERTS_FILE_PATH;
}

export { ALERTS_FILE_PATH, ALERTS_EXAMPLE_FILE_PATH };

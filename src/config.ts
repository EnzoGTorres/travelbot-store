import dotenv from "dotenv";

dotenv.config();

function readOptionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();

  return value ? value : undefined;
}

function readRequiredEnv(name: string): string {
  const value = readOptionalEnv(name);

  if (!value) {
    throw new Error(`Falta la variable de entorno ${name}.`);
  }

  return value;
}

function readBooleanEnv(name: string, defaultValue = false): boolean {
  const value = readOptionalEnv(name);

  if (!value) {
    return defaultValue;
  }

  const normalizedValue = value.toLowerCase();

  if (["1", "true", "yes", "on"].includes(normalizedValue)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalizedValue)) {
    return false;
  }

  throw new Error(`${name} debe ser un booleano valido.`);
}

function readStorageProvider(): "file" | "github" {
  const provider = readOptionalEnv("TRAVELBOT_STORE_PROVIDER") ?? "file";

  if (provider !== "file" && provider !== "github") {
    throw new Error("TRAVELBOT_STORE_PROVIDER debe ser 'file' o 'github'.");
  }

  return provider;
}

export const config = {
  telegram: {
    botToken: readOptionalEnv("TELEGRAM_BOT_TOKEN"),
    chatId: readOptionalEnv("TELEGRAM_CHAT_ID"),
    isConfigured(): boolean {
      return Boolean(this.botToken && this.chatId);
    }
  },
  serpApi: {
    baseUrl: readOptionalEnv("SERPAPI_BASE_URL") ?? "https://serpapi.com/search.json",
    getApiKey: () => readOptionalEnv("SERPAPI_API_KEY") ?? readRequiredEnv("SERPAPI_KEY"),
    currency: readOptionalEnv("SERPAPI_CURRENCY") ?? "USD",
    language: readOptionalEnv("SERPAPI_LANGUAGE") ?? "en",
    market: readOptionalEnv("SERPAPI_MARKET") ?? "us"
  },
  checks: {
    secret: readOptionalEnv("TRAVELBOT_CHECK_SECRET"),
    dryRun: readBooleanEnv("TRAVELBOT_DRY_RUN", false)
  },
  storage: {
    provider: readStorageProvider(),
    filePath: readOptionalEnv("TRAVELBOT_ALERTS_FILE"),
    github: {
      owner: readOptionalEnv("GITHUB_STORE_OWNER"),
      repo: readOptionalEnv("GITHUB_STORE_REPO"),
      branch: readOptionalEnv("GITHUB_STORE_BRANCH") ?? "main",
      path: readOptionalEnv("GITHUB_STORE_PATH") ?? "data/alerts.json",
      token: readOptionalEnv("GITHUB_STORE_TOKEN")
    }
  }
};

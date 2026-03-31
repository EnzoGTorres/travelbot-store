import { config } from "../src/config";
import { readAlertsStore } from "../src/store";

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

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.method !== "GET") {
    res.status(405).json({ ok: false, error: "Method not allowed." });
    return;
  }

  // Require secret if configured
  if (config.checks.secret) {
    const provided =
      (req.headers["x-travelbot-secret"] as string | undefined) ??
      (typeof req.query?.secret === "string" ? req.query.secret : undefined);

    if (!provided || provided !== config.checks.secret) {
      res.status(401).json({ ok: false, error: "Unauthorized." });
      return;
    }
  }

  try {
    const store = await readAlertsStore();

    const searches = store.searches.map((s) => {
      const state = store.states[s.id];
      return {
        id: s.id,
        name: s.name,
        enabled: s.enabled,
        alertBelowPrice: s.alertBelowPrice,
        params: {
          origin: s.params.origin,
          origins: s.params.origins,
          destination: s.params.destination,
          destinations: s.params.destinations,
          currency: s.params.currency,
          directOnly: s.params.directOnly
        },
        state: state
          ? {
              lastPrice: state.lastPrice,
              lastCurrency: state.lastCurrency,
              lastCheckedAt: state.lastCheckedAt,
              airline: state.lastResult?.airline,
              origin: state.lastResult?.origin,
              destination: state.lastResult?.destination,
              departureDate: state.lastResult?.departureDate,
              returnDate: state.lastResult?.returnDate,
              lastAlertedAt: state.lastAlertedAt,
              lastAlertedPrice: state.lastAlertedPrice,
              lastAlertType: state.lastAlertType
            }
          : null
      };
    });

    res.status(200).json({ ok: true, searches, generatedAt: new Date().toISOString() });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Error desconocido.";
    res.status(500).json({ ok: false, error: message });
  }
}

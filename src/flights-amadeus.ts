import { config } from "./config";
import { HttpRequestError, requestJson } from "./http";
import { BestFlightPrice, DEFAULT_AIRLINE_LABEL, MonitoredSearch } from "./types";

// Amadeus API: https://developers.amadeus.com/self-service/category/flights/api-doc/flight-offers-search
// Free tier: 2000 transactions/month en produccion
// Auth: OAuth2 client_credentials
// Registro: https://developers.amadeus.com/register

const AMADEUS_TOKEN_URL_TEST = "https://test.api.amadeus.com/v1/security/oauth2/token";
const AMADEUS_TOKEN_URL_PROD = "https://api.amadeus.com/v1/security/oauth2/token";
const AMADEUS_FLIGHTS_URL_TEST = "https://test.api.amadeus.com/v2/shopping/flight-offers";
const AMADEUS_FLIGHTS_URL_PROD = "https://api.amadeus.com/v2/shopping/flight-offers";

interface AmadeusTokenResponse {
  access_token: string;
  expires_in: number;
}

interface AmadeusFlightOffer {
  price?: { grandTotal?: string };
  itineraries?: Array<{
    segments?: Array<{
      carrierCode?: string;
      numberOfStops?: number;
    }>;
  }>;
}

interface AmadeusFlightsResponse {
  data?: AmadeusFlightOffer[];
  errors?: Array<{ title?: string; detail?: string }>;
}

let cachedToken: { value: string; expiresAt: number } | undefined;

async function getAmadeusToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.value;
  }

  const isProd = config.amadeus.env === "production";
  const tokenUrl = isProd ? AMADEUS_TOKEN_URL_PROD : AMADEUS_TOKEN_URL_TEST;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: config.amadeus.clientId,
    client_secret: config.amadeus.clientSecret
  });

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    signal: AbortSignal.timeout(config.amadeus.requestTimeoutMs)
  });

  if (!response.ok) {
    throw new Error(`Amadeus auth fallida: HTTP ${response.status}`);
  }

  const data = (await response.json()) as AmadeusTokenResponse;
  cachedToken = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return cachedToken.value;
}

export async function getBestFlightPriceAmadeus(search: MonitoredSearch): Promise<BestFlightPrice> {
  const params = search.params;
  const origins = [params.origin, ...(params.origins ?? [])].filter(Boolean);
  const destinations = [params.destination, ...(params.destinations ?? [])].filter(
    (d): d is string => typeof d === "string"
  );

  const departureDates = params.departureDate ? [params.departureDate] : [];
  const returnDates = params.returnDate ? [params.returnDate] : [undefined];

  if (!departureDates.length) {
    throw new Error(`La busqueda "${search.id}" requiere departureDate para Amadeus (rangos no soportados aun).`);
  }

  const isProd = config.amadeus.env === "production";
  const flightsUrl = isProd ? AMADEUS_FLIGHTS_URL_PROD : AMADEUS_FLIGHTS_URL_TEST;
  const token = await getAmadeusToken();

  let bestPrice: number | undefined;
  let bestAirline = DEFAULT_AIRLINE_LABEL;
  let bestOrigin = origins[0];
  let bestDestination = destinations[0];
  let bestDepartureDate = departureDates[0];
  let bestReturnDate: string | undefined;

  for (const origin of origins) {
    for (const destination of destinations) {
      for (const departureDate of departureDates) {
        for (const returnDate of returnDates) {
          try {
            const url = new URL(flightsUrl);
            url.searchParams.set("originLocationCode", origin);
            url.searchParams.set("destinationLocationCode", destination);
            url.searchParams.set("departureDate", departureDate);
            url.searchParams.set("adults", String(params.adults));
            url.searchParams.set("currencyCode", params.currency ?? config.serpApi.currency);
            url.searchParams.set("max", "5");
            if (returnDate) url.searchParams.set("returnDate", returnDate);
            if (params.directOnly) url.searchParams.set("nonStop", "true");

            const res = await fetch(url.toString(), {
              headers: { Authorization: `Bearer ${token}` },
              signal: AbortSignal.timeout(config.amadeus.requestTimeoutMs)
            });

            if (!res.ok) {
              const text = await res.text();
              throw new Error(`Amadeus HTTP ${res.status}: ${text.slice(0, 200)}`);
            }

            const data = (await res.json()) as AmadeusFlightsResponse;

            if (data.errors?.length) {
              throw new Error(`Amadeus error: ${data.errors[0].detail ?? data.errors[0].title}`);
            }

            if (!data.data?.length) continue;

            for (const offer of data.data) {
              const price = parseFloat(offer.price?.grandTotal ?? "");
              if (!isFinite(price)) continue;
              if (bestPrice === undefined || price < bestPrice) {
                bestPrice = price;
                bestOrigin = origin;
                bestDestination = destination;
                bestDepartureDate = departureDate;
                bestReturnDate = returnDate;
                const segments = offer.itineraries?.[0]?.segments ?? [];
                const carriers = [...new Set(segments.map((s) => s.carrierCode).filter(Boolean))];
                bestAirline = carriers.length ? carriers.join(" / ") : DEFAULT_AIRLINE_LABEL;
              }
            }
          } catch (err) {
            // log and continue to next combination
            console.warn(`[Amadeus] ${origin}->${destination} ${departureDate}: ${err instanceof Error ? err.message : err}`);
          }
        }
      }
    }
  }

  if (bestPrice === undefined) {
    throw new Error(`Amadeus no devolvio precios para la busqueda "${search.id}".`);
  }

  return {
    price: bestPrice,
    currency: params.currency ?? config.serpApi.currency,
    origin: bestOrigin,
    destination: bestDestination,
    departureDate: bestDepartureDate,
    returnDate: bestReturnDate,
    airline: bestAirline,
    market: params.market ?? config.serpApi.market,
    language: params.language ?? config.serpApi.language,
    directOnly: params.directOnly ?? false,
    metadata: {
      checkedOriginCount: origins.length,
      checkedCombinationCount: origins.length * destinations.length * departureDates.length,
      checkedDestinationCount: destinations.length,
      checkedDepartureDateCount: departureDates.length,
      checkedReturnDateCount: returnDates.filter(Boolean).length,
      selectedCombinationLabel: bestReturnDate
        ? `${bestOrigin} -> ${bestDestination} | ${bestDepartureDate} -> ${bestReturnDate}`
        : `${bestOrigin} -> ${bestDestination} | ${bestDepartureDate}`,
      directOnlyRequested: params.directOnly ?? false,
      directOnlyApplied: params.directOnly ?? false,
      notes: []
    }
  };
}

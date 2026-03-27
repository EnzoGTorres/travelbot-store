import axios from "axios";
import { config } from "./config";
import {
  BestFlightPrice,
  DateRangeInput,
  FlightSearchParams,
  MonitoredSearch,
  ResolvedFlightSearchParams
} from "./types";

const DEFAULT_MAX_RANGE_OPTIONS = 7;

interface SerpApiFlightOption {
  price?: number | string;
  flights?: unknown[];
  layovers?: unknown[];
}

interface SerpApiFlightsResponse {
  search_metadata?: {
    status?: string;
  };
  search_parameters?: {
    currency?: string;
    hl?: string;
    gl?: string;
  };
  best_flights?: SerpApiFlightOption[];
  other_flights?: SerpApiFlightOption[];
  price_insights?: {
    lowest_price?: number;
  };
  error?: string;
}

interface FlightResolutionContext {
  combinations: ResolvedFlightSearchParams[];
  destinationCount: number;
  departureDateCount: number;
  returnDateCount: number;
  notes: string[];
}

function normalizePrice(value: number | string | undefined): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const numericValue = Number(value.replace(/[^\d.]/g, ""));

    if (Number.isFinite(numericValue)) {
      return numericValue;
    }
  }

  return undefined;
}

function isValidDate(value: string): boolean {
  const parsedDate = new Date(`${value}T00:00:00.000Z`);

  return !Number.isNaN(parsedDate.getTime()) && parsedDate.toISOString().startsWith(value);
}

function addDays(value: string, amount: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function expandDateValues(
  fixedDate: string | undefined,
  range: DateRangeInput | undefined,
  label: string,
  notes: string[]
): string[] {
  if (fixedDate && range) {
    throw new Error(
      `La busqueda define ${label} y ${label}Range al mismo tiempo. Usa solo una opcion.`
    );
  }

  if (fixedDate) {
    if (!isValidDate(fixedDate)) {
      throw new Error(`La fecha ${label}="${fixedDate}" no tiene formato YYYY-MM-DD valido.`);
    }

    return [fixedDate];
  }

  if (!range) {
    return [];
  }

  if (!isValidDate(range.from) || !isValidDate(range.to)) {
    throw new Error(`El rango ${label}Range debe usar fechas YYYY-MM-DD validas.`);
  }

  if (range.from > range.to) {
    throw new Error(`El rango ${label}Range debe tener from <= to.`);
  }

  const stepDays = range.stepDays ?? 1;
  const maxOptions = range.maxOptions ?? DEFAULT_MAX_RANGE_OPTIONS;

  if (!Number.isInteger(stepDays) || stepDays <= 0) {
    throw new Error(`El rango ${label}Range debe tener stepDays > 0.`);
  }

  if (!Number.isInteger(maxOptions) || maxOptions <= 0) {
    throw new Error(`El rango ${label}Range debe tener maxOptions > 0.`);
  }

  const values: string[] = [];
  let cursor = range.from;

  while (cursor <= range.to && values.length < maxOptions) {
    values.push(cursor);
    cursor = addDays(cursor, stepDays);
  }

  if (cursor <= range.to) {
    notes.push(
      `${label}Range truncado a ${values.length} fecha(s) para evitar demasiadas combinaciones.`
    );
  }

  return values;
}

function getDestinations(params: FlightSearchParams): string[] {
  const values = [params.destination, ...(params.destinations ?? [])]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean);

  return [...new Set(values)];
}

function buildCombinationLabel(params: ResolvedFlightSearchParams): string {
  return params.returnDate
    ? `${params.origin} -> ${params.destination} | ${params.departureDate} -> ${params.returnDate}`
    : `${params.origin} -> ${params.destination} | ${params.departureDate}`;
}

function resolveSearchParams(search: MonitoredSearch): FlightResolutionContext {
  const notes: string[] = [];
  const destinations = getDestinations(search.params);

  if (destinations.length === 0) {
    throw new Error(`La busqueda "${search.id}" no tiene ningun destino definido.`);
  }

  const departureDates = expandDateValues(
    search.params.departureDate,
    search.params.departureDateRange,
    "departureDate",
    notes
  );

  if (departureDates.length === 0) {
    throw new Error(`La busqueda "${search.id}" debe definir departureDate o departureDateRange.`);
  }

  const returnDates = expandDateValues(
    search.params.returnDate,
    search.params.returnDateRange,
    "returnDate",
    notes
  );

  if (!search.params.returnDate && !search.params.returnDateRange) {
    returnDates.push("");
  }

  const combinations: ResolvedFlightSearchParams[] = [];
  const currency = search.params.currency ?? config.serpApi.currency;
  const language = search.params.language ?? config.serpApi.language;
  const market = search.params.market ?? config.serpApi.market;
  const directOnly = search.params.directOnly ?? false;

  for (const destination of destinations) {
    for (const departureDate of departureDates) {
      for (const returnDate of returnDates) {
        if (returnDate && returnDate < departureDate) {
          continue;
        }

        combinations.push({
          origin: search.params.origin,
          destination,
          departureDate,
          returnDate: returnDate || undefined,
          adults: search.params.adults,
          currency,
          language,
          market,
          directOnly
        });
      }
    }
  }

  if (combinations.length === 0) {
    throw new Error(`La busqueda "${search.id}" no genero combinaciones validas.`);
  }

  return {
    combinations,
    destinationCount: destinations.length,
    departureDateCount: departureDates.length,
    returnDateCount: returnDates.filter(Boolean).length,
    notes
  };
}

function isDirectFlightOption(option: SerpApiFlightOption): boolean | undefined {
  if (Array.isArray(option.layovers)) {
    return option.layovers.length === 0;
  }

  if (Array.isArray(option.flights)) {
    return option.flights.length === 1;
  }

  return undefined;
}

async function fetchCombinationPrice(
  params: ResolvedFlightSearchParams
): Promise<{
  price: number;
  currency: string;
  directOnlyApplied: boolean;
  notes: string[];
}> {
  try {
    const response = await axios.get<SerpApiFlightsResponse>(config.serpApi.baseUrl, {
      params: {
        engine: "google_flights",
        api_key: config.serpApi.getApiKey(),
        departure_id: params.origin,
        arrival_id: params.destination,
        outbound_date: params.departureDate,
        return_date: params.returnDate,
        adults: params.adults,
        currency: params.currency,
        hl: params.language,
        gl: params.market,
        type: params.returnDate ? 1 : 2
      }
    });

    if (response.data.error) {
      throw new Error(`SerpAPI devolvio un error: ${response.data.error}`);
    }

    const rawFlights = [
      ...(response.data.best_flights ?? []),
      ...(response.data.other_flights ?? [])
    ];

    let candidateFlights = rawFlights;
    let directOnlyApplied = false;
    const notes: string[] = [];

    if (params.directOnly) {
      const directMatches = rawFlights.filter((flight) => isDirectFlightOption(flight) === true);
      const directSignalsDetected = rawFlights.some(
        (flight) => isDirectFlightOption(flight) !== undefined
      );

      if (directMatches.length > 0) {
        candidateFlights = directMatches;
        directOnlyApplied = true;
      } else if (directSignalsDetected) {
        candidateFlights = [];
        directOnlyApplied = true;
        notes.push("No se encontraron opciones directas para esta combinacion.");
      } else {
        notes.push(
          "SerpAPI no expuso datos suficientes para validar escalas; se usa la mejor tarifa disponible."
        );
      }
    }

    const baseInsightPrice = !params.directOnly || directOnlyApplied
      ? response.data.price_insights?.lowest_price
      : undefined;

    const lowestFlightPrice = candidateFlights.reduce<number | undefined>((bestPrice, flight) => {
      const currentPrice = normalizePrice(flight.price);

      if (currentPrice === undefined) {
        return bestPrice;
      }

      if (bestPrice === undefined || currentPrice < bestPrice) {
        return currentPrice;
      }

      return bestPrice;
    }, normalizePrice(baseInsightPrice));

    if (lowestFlightPrice === undefined) {
      throw new Error("SerpAPI no devolvio ofertas para la busqueda indicada.");
    }

    return {
      price: lowestFlightPrice,
      currency: response.data.search_parameters?.currency ?? params.currency,
      directOnlyApplied,
      notes
    };
  } catch (error: unknown) {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      const detail =
        typeof error.response?.data === "object" && error.response?.data !== null
          ? JSON.stringify(error.response.data)
          : undefined;

      throw new Error(
        status
          ? `No se pudo consultar vuelos en SerpAPI. Status ${status}.${detail ? ` ${detail}` : ""}`
          : "No se pudo consultar vuelos en SerpAPI."
      );
    }

    throw error;
  }
}

export async function getBestFlightPrice(search: MonitoredSearch): Promise<BestFlightPrice> {
  const resolution = resolveSearchParams(search);
  let bestResult:
    | {
        params: ResolvedFlightSearchParams;
        price: number;
        currency: string;
        directOnlyApplied: boolean;
        notes: string[];
      }
    | undefined;

  for (const combination of resolution.combinations) {
    try {
      const result = await fetchCombinationPrice(combination);

      if (!bestResult || result.price < bestResult.price) {
        bestResult = {
          params: combination,
          price: result.price,
          currency: result.currency,
          directOnlyApplied: result.directOnlyApplied,
          notes: result.notes
        };
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Error desconocido.";
      resolution.notes.push(`${buildCombinationLabel(combination)}: ${message}`);
    }
  }

  if (!bestResult) {
    throw new Error(
      `No se pudo resolver ningun precio para la busqueda "${search.id}". ${resolution.notes.join(" ")}`
    );
  }

  return {
    price: bestResult.price,
    currency: bestResult.currency,
    origin: bestResult.params.origin,
    destination: bestResult.params.destination,
    departureDate: bestResult.params.departureDate,
    returnDate: bestResult.params.returnDate,
    market: bestResult.params.market,
    language: bestResult.params.language,
    directOnly: bestResult.params.directOnly,
    metadata: {
      checkedCombinationCount: resolution.combinations.length,
      checkedDestinationCount: resolution.destinationCount,
      checkedDepartureDateCount: resolution.departureDateCount,
      checkedReturnDateCount: resolution.returnDateCount,
      selectedCombinationLabel: buildCombinationLabel(bestResult.params),
      directOnlyRequested: bestResult.params.directOnly,
      directOnlyApplied: bestResult.directOnlyApplied,
      notes: [...resolution.notes, ...bestResult.notes]
    }
  };
}

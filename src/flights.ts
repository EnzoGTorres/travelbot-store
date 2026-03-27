import { config } from "./config";
import { HttpRequestError, requestJson } from "./http";
import {
  BestFlightPrice,
  DEFAULT_AIRLINE_LABEL,
  DateRangeInput,
  FlightSearchParams,
  MonitoredSearch,
  ResolvedFlightSearchParams
} from "./types";

const DEFAULT_MAX_RANGE_OPTIONS = 7;

interface SerpApiFlightOption {
  price?: number | string;
  flights?: SerpApiFlightSegment[];
  layovers?: unknown[];
}

interface SerpApiFlightSegment {
  airline?: string;
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
  originCount: number;
  destinationCount: number;
  departureDateCount: number;
  returnDateCount: number;
  notes: string[];
}

interface CombinationPriceResult {
  params: ResolvedFlightSearchParams;
  price: number;
  currency: string;
  airline: string;
  directOnlyApplied: boolean;
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

function getOrigins(params: FlightSearchParams): string[] {
  const values = [params.origin, ...(params.origins ?? [])]
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
  const origins = getOrigins(search.params);
  const destinations = getDestinations(search.params);

  if (origins.length === 0) {
    throw new Error(`La busqueda "${search.id}" no tiene ningun origen definido.`);
  }

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

  for (const origin of origins) {
    for (const destination of destinations) {
      for (const departureDate of departureDates) {
        for (const returnDate of returnDates) {
          if (returnDate && returnDate < departureDate) {
            continue;
          }

          combinations.push({
            origin,
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
  }

  if (combinations.length === 0) {
    throw new Error(`La busqueda "${search.id}" no genero combinaciones validas.`);
  }

  return {
    combinations,
    originCount: origins.length,
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

function buildAirlineLabel(option: SerpApiFlightOption | undefined): string {
  if (!option?.flights || option.flights.length === 0) {
    return DEFAULT_AIRLINE_LABEL;
  }

  const airlines = option.flights
    .map((segment) => (typeof segment.airline === "string" ? segment.airline.trim() : ""))
    .filter(Boolean);

  if (airlines.length === 0) {
    return DEFAULT_AIRLINE_LABEL;
  }

  const uniqueAirlines = [...new Set(airlines)];

  if (uniqueAirlines.length === 1) {
    return uniqueAirlines[0];
  }

  const [primaryAirline, ...otherAirlines] = uniqueAirlines;

  if (otherAirlines.length === 1) {
    return `${primaryAirline} / ${otherAirlines[0]}`;
  }

  return `${primaryAirline} / ${otherAirlines[0]} / +${otherAirlines.length - 1}`;
}

async function fetchCombinationPrice(
  params: ResolvedFlightSearchParams
): Promise<{
  price: number;
  currency: string;
  airline: string;
  directOnlyApplied: boolean;
  notes: string[];
}> {
  try {
    const url = new URL(config.serpApi.baseUrl);
    url.searchParams.set("engine", "google_flights");
    url.searchParams.set("api_key", config.serpApi.getApiKey());
    url.searchParams.set("departure_id", params.origin);
    url.searchParams.set("arrival_id", params.destination);
    url.searchParams.set("outbound_date", params.departureDate);
    url.searchParams.set("adults", String(params.adults));
    url.searchParams.set("currency", params.currency);
    url.searchParams.set("hl", params.language);
    url.searchParams.set("gl", params.market);
    url.searchParams.set("type", params.returnDate ? "1" : "2");

    if (params.returnDate) {
      url.searchParams.set("return_date", params.returnDate);
    }

    const response = await requestJson<SerpApiFlightsResponse>(url, {
      timeoutMs: config.serpApi.requestTimeoutMs
    });

    if (response.error) {
      throw new Error(`SerpAPI devolvio un error: ${response.error}`);
    }

    const rawFlights = [
      ...(response.best_flights ?? []),
      ...(response.other_flights ?? [])
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

    const bestFlightOption = candidateFlights.reduce<SerpApiFlightOption | undefined>(
      (bestOption, flight) => {
        const currentPrice = normalizePrice(flight.price);
        const bestPrice = bestOption ? normalizePrice(bestOption.price) : undefined;

        if (currentPrice === undefined) {
          return bestOption;
        }

        if (bestPrice === undefined || currentPrice < bestPrice) {
          return flight;
        }

        return bestOption;
      },
      undefined
    );

    const baseInsightPrice = !params.directOnly || directOnlyApplied
      ? response.price_insights?.lowest_price
      : undefined;
    const lowestFlightPrice = bestFlightOption
      ? normalizePrice(bestFlightOption.price)
      : normalizePrice(baseInsightPrice);

    if (lowestFlightPrice === undefined) {
      throw new Error("SerpAPI no devolvio ofertas para la busqueda indicada.");
    }

    return {
      price: lowestFlightPrice,
      currency: response.search_parameters?.currency ?? params.currency,
      airline: buildAirlineLabel(bestFlightOption),
      directOnlyApplied,
      notes
    };
  } catch (error: unknown) {
    if (error instanceof HttpRequestError) {
      const status = error.status;
      const detail = error.detail;

      if (error.message === `La solicitud excedio el timeout de ${config.serpApi.requestTimeoutMs}ms.`) {
        throw new Error(
          `SerpAPI excedio el timeout de ${config.serpApi.requestTimeoutMs}ms para esta combinacion.`
        );
      }

      throw new Error(
        status
          ? `No se pudo consultar vuelos en SerpAPI. Status ${status}.${detail ? ` ${detail}` : ""}`
          : "No se pudo consultar vuelos en SerpAPI."
      );
    }

    throw error;
  }
}

async function findBestPriceAcrossCombinations(
  search: MonitoredSearch,
  resolution: FlightResolutionContext
): Promise<CombinationPriceResult | undefined> {
  const concurrency = Math.min(
    Math.max(config.flights.fetchConcurrency, 1),
    resolution.combinations.length
  );
  let bestResult: CombinationPriceResult | undefined;
  let nextIndex = 0;
  let completedCount = 0;

  console.log(
    `[Travelbot] ${search.id}: evaluando ${resolution.combinations.length} combinacion(es) con concurrencia=${concurrency} timeout=${config.serpApi.requestTimeoutMs}ms`
  );

  async function worker(): Promise<void> {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;

      if (currentIndex >= resolution.combinations.length) {
        return;
      }

      const combination = resolution.combinations[currentIndex];

      try {
        const result = await fetchCombinationPrice(combination);

        if (!bestResult || result.price < bestResult.price) {
          bestResult = {
            params: combination,
            price: result.price,
            currency: result.currency,
            airline: result.airline,
            directOnlyApplied: result.directOnlyApplied,
            notes: result.notes
          };
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "Error desconocido.";
        resolution.notes.push(`${buildCombinationLabel(combination)}: ${message}`);
      } finally {
        completedCount += 1;

        if (
          completedCount === resolution.combinations.length ||
          completedCount % Math.min(concurrency * 2, 10) === 0
        ) {
          console.log(
            `[Travelbot] ${search.id}: progreso ${completedCount}/${resolution.combinations.length} combinacion(es) evaluadas`
          );
        }
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  return bestResult;
}

export async function getBestFlightPrice(search: MonitoredSearch): Promise<BestFlightPrice> {
  const resolution = resolveSearchParams(search);
  const bestResult = await findBestPriceAcrossCombinations(search, resolution);

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
    airline: bestResult.airline,
    market: bestResult.params.market,
    language: bestResult.params.language,
    directOnly: bestResult.params.directOnly,
    metadata: {
      checkedOriginCount: resolution.originCount,
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

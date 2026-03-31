import { config } from "./config";
import { BestFlightPrice, DEFAULT_AIRLINE_LABEL, DateRangeInput, MonitoredSearch } from "./types";

// Kiwi.com Tequila API — https://tequila.kiwi.com
// Free tier disponible para desarrolladores externos
// Registro: https://tequila.kiwi.com/
// Auth: header "apikey: <tu_api_key>"
// Ventaja clave: soporta rangos de fechas en un solo request

const TEQUILA_SEARCH_URL = "https://tequila-api.kiwi.com/v2/search";

interface KiwiRoute {
  airline?: string;
  flyFrom?: string;
  flyTo?: string;
  local_departure?: string;
}

interface KiwiFlightOffer {
  price?: number;
  airlines?: string[];
  route?: KiwiRoute[];
  fly_from?: string;
  fly_to?: string;
  local_departure?: string;
  return_duration?: string;
}

interface KiwiSearchResponse {
  data?: KiwiFlightOffer[];
  _results?: number;
  error?: string;
}

// Kiwi espera fechas en formato dd/MM/yyyy
function toKiwiDate(isoDate: string): string {
  const [year, month, day] = isoDate.split("-");
  return `${day}/${month}/${year}`;
}

function lastDateOfRange(range: DateRangeInput): string {
  return range.to;
}

function buildAirlineLabel(offer: KiwiFlightOffer): string {
  const airlines = [
    ...(offer.airlines ?? []),
    ...(offer.route?.map((r) => r.airline).filter((a): a is string => Boolean(a)) ?? [])
  ];
  const unique = [...new Set(airlines.filter(Boolean))];
  if (!unique.length) return DEFAULT_AIRLINE_LABEL;
  if (unique.length === 1) return unique[0];
  return unique.slice(0, 2).join(" / ") + (unique.length > 2 ? ` / +${unique.length - 2}` : "");
}

export async function getBestFlightPriceKiwi(search: MonitoredSearch): Promise<BestFlightPrice> {
  const p = search.params;
  const origins = [p.origin, ...(p.origins ?? [])].filter(Boolean).join(",");
  const destinations = [p.destination, ...(p.destinations ?? [])]
    .filter((d): d is string => typeof d === "string" && Boolean(d))
    .join(",");

  if (!origins) throw new Error(`La busqueda "${search.id}" no tiene origen definido.`);
  if (!destinations) throw new Error(`La busqueda "${search.id}" no tiene destino definido.`);

  // Fechas de ida
  const depFrom = p.departureDate ?? p.departureDateRange?.from;
  const depTo = p.departureDate ?? (p.departureDateRange ? lastDateOfRange(p.departureDateRange) : undefined);
  if (!depFrom || !depTo) throw new Error(`La busqueda "${search.id}" debe definir departureDate o departureDateRange.`);

  // Fechas de vuelta
  const retFrom = p.returnDate ?? p.returnDateRange?.from;
  const retTo = p.returnDate ?? (p.returnDateRange ? lastDateOfRange(p.returnDateRange) : undefined);
  const isRoundTrip = Boolean(retFrom);

  const currency = p.currency ?? config.serpApi.currency;
  const language = p.language ?? config.serpApi.language;

  const url = new URL(TEQUILA_SEARCH_URL);
  url.searchParams.set("fly_from", origins);
  url.searchParams.set("fly_to", destinations);
  url.searchParams.set("dateFrom", toKiwiDate(depFrom));
  url.searchParams.set("dateTo", toKiwiDate(depTo));
  url.searchParams.set("flight_type", isRoundTrip ? "round" : "oneway");
  url.searchParams.set("adults", String(p.adults));
  url.searchParams.set("curr", currency);
  url.searchParams.set("locale", language);
  url.searchParams.set("sort", "price");
  url.searchParams.set("limit", "5");

  if (isRoundTrip && retFrom && retTo) {
    url.searchParams.set("return_from", toKiwiDate(retFrom));
    url.searchParams.set("return_to", toKiwiDate(retTo));
  }

  if (p.directOnly) {
    url.searchParams.set("max_stopovers", "0");
  }

  const res = await fetch(url.toString(), {
    headers: { apikey: config.kiwi.getApiKey() },
    signal: AbortSignal.timeout(config.kiwi.requestTimeoutMs)
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Kiwi API HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = (await res.json()) as KiwiSearchResponse;

  if (data.error) throw new Error(`Kiwi API error: ${data.error}`);
  if (!data.data?.length) throw new Error(`Kiwi no devolvio vuelos para la busqueda "${search.id}".`);

  const best = data.data.reduce<KiwiFlightOffer | undefined>((acc, offer) => {
    if (offer.price === undefined) return acc;
    if (!acc || offer.price < (acc.price ?? Infinity)) return offer;
    return acc;
  }, undefined);

  if (!best || best.price === undefined) {
    throw new Error(`Kiwi no devolvio precios validos para la busqueda "${search.id}".`);
  }

  const bestOrigin = best.fly_from ?? (p.origin ?? origins.split(",")[0]);
  const bestDestination = best.fly_to ?? destinations.split(",")[0];
  const bestDepartureDate = best.local_departure?.slice(0, 10) ?? depFrom;
  const bestReturnDate = isRoundTrip ? retFrom : undefined;
  const originCount = origins.split(",").length;
  const destCount = destinations.split(",").length;

  return {
    price: best.price,
    currency,
    origin: bestOrigin,
    destination: bestDestination,
    departureDate: bestDepartureDate,
    returnDate: bestReturnDate,
    airline: buildAirlineLabel(best),
    market: p.market ?? config.serpApi.market,
    language,
    directOnly: p.directOnly ?? false,
    metadata: {
      checkedOriginCount: originCount,
      checkedCombinationCount: originCount * destCount,
      checkedDestinationCount: destCount,
      checkedDepartureDateCount: 1,
      checkedReturnDateCount: isRoundTrip ? 1 : 0,
      selectedCombinationLabel: bestReturnDate
        ? `${bestOrigin} -> ${bestDestination} | ${bestDepartureDate} -> ${bestReturnDate}`
        : `${bestOrigin} -> ${bestDestination} | ${bestDepartureDate}`,
      directOnlyRequested: p.directOnly ?? false,
      directOnlyApplied: p.directOnly ?? false,
      notes: [`Resultados disponibles: ${data._results ?? data.data.length}`]
    }
  };
}

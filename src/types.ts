export interface DateRangeInput {
  from: string;
  to: string;
  stepDays?: number;
  maxOptions?: number;
}

export interface FlightSearchParams {
  origin: string;
  origins?: string[];
  destination?: string;
  destinations?: string[];
  departureDate?: string;
  departureDateRange?: DateRangeInput;
  returnDate?: string;
  returnDateRange?: DateRangeInput;
  adults: number;
  currency?: string;
  language?: string;
  market?: string;
  directOnly?: boolean;
}

export interface ResolvedFlightSearchParams {
  origin: string;
  destination: string;
  departureDate: string;
  returnDate?: string;
  adults: number;
  currency: string;
  language: string;
  market: string;
  directOnly: boolean;
}

export interface FlightSelectionMetadata {
  checkedOriginCount: number;
  checkedCombinationCount: number;
  checkedDestinationCount: number;
  checkedDepartureDateCount: number;
  checkedReturnDateCount: number;
  selectedCombinationLabel: string;
  directOnlyRequested: boolean;
  directOnlyApplied: boolean;
  notes: string[];
}

export interface BestFlightPrice {
  price: number;
  currency: string;
  origin: string;
  destination: string;
  departureDate: string;
  returnDate?: string;
  airline: string;
  market: string;
  language: string;
  directOnly: boolean;
  metadata: FlightSelectionMetadata;
}

export interface MonitoredSearch {
  id: string;
  name: string;
  enabled: boolean;
  params: FlightSearchParams;
  alertBelowPrice?: number;
  alertCooldownHours?: number;
  minimumDropAmount?: number;
  minimumDropPercent?: number;
}

export interface SearchState {
  searchId: string;
  lastPrice: number;
  lastCurrency: string;
  lastCheckedAt: string;
  lastResult: BestFlightPrice;
  lastAlertedPrice?: number;
  lastAlertedCurrency?: string;
  lastAlertedAt?: string;
  lastAlertType?: AlertType;
}

export interface AlertsStore {
  searches: MonitoredSearch[];
  states: Record<string, SearchState>;
}

export type SearchCheckStatus =
  | "first_check"
  | "price_down"
  | "price_up"
  | "unchanged";

export type AlertType = "price_dropped" | "below_threshold";
export type NotificationStatus = "sent" | "skipped" | "dry_run";
export type StorageMode = "file" | "github";

export interface NotificationResult {
  status: NotificationStatus;
  reason: string;
  alertType?: AlertType;
  sentAt?: string;
}

export interface SearchCheckResult {
  search: MonitoredSearch;
  current: BestFlightPrice;
  previous?: SearchState;
  status: SearchCheckStatus;
  difference: number;
  dropAmount: number;
  dropPercent?: number;
  shouldAlert: boolean;
  dryRun: boolean;
  alertType?: AlertType;
  notification: NotificationResult;
}

export interface RunChecksOptions {
  dryRun?: boolean;
}

export interface StoreWriteOptions {
  updatedSearchIds?: string[];
}

export interface StoreWriteResult {
  mode: StorageMode;
  retried: boolean;
}

export interface ChecksPersistenceSummary {
  attempted: boolean;
  persisted: boolean;
  retried: boolean;
  error?: string;
}

export interface SearchCheckDetail {
  searchId: string;
  searchName: string;
  ok: boolean;
  status?: SearchCheckStatus;
  dryRun: boolean;
  airline?: string;
  alertEligible?: boolean;
  alertSent?: boolean;
  notificationStatus?: NotificationStatus;
  alertType?: AlertType;
  currentPrice?: number;
  currency?: string;
  notificationReason?: string;
  summary: string;
  log: string;
  error?: string;
}

export interface ChecksRunSummary {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  dryRun: boolean;
  storageMode: StorageMode;
  storeLabel: string;
  checkedCount: number;
  alertsEligible: number;
  alertsSent: number;
  skipped: number;
  errors: number;
  persistence: ChecksPersistenceSummary;
  details: SearchCheckDetail[];
}

export const DEFAULT_AIRLINE_LABEL = "Aerolínea no disponible";

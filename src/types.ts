export interface CarrierData {
  name: string;
  callsign: string;
  /** Journal CarrierID / MarketID, stored as a decimal string. */
  carrierId: string;
  currentSystem: string;
  /** Journal SystemAddress / Spansh id64; absent when not yet resolved. */
  currentSystemAddress?: string;
  previousSystem?: string;
  previousSystemAddress?: string;
  lastPositionObservation?: { eventId: string; observedAt: string; source: string };
  lastPositionSyncAt?: string;
  status: string;
  role: string[];
  welcomeMessage: string;
  shortGreeting: string;
  locationNote: string;
}

export type ServiceState = "online" | "limited" | "offline";

export interface ServiceData {
  name: string;
  status: ServiceState;
  summary: string;
  note?: string;
}

export type DepartureStatus =
  | "scheduled"
  | "boarding"
  | "delayed"
  | "completed"
  | "cancelled";

export interface DepartureData {
  title: string;
  originSystem: string;
  originSystemAddress?: string;
  destinationSystem: string;
  destinationSystemAddress?: string;
  departureTime: string;
  boardingDeadline: string;
  status: DepartureStatus;
  notes: string;
  itinerary?: string;
}

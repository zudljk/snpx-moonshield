export interface CarrierData {
  name: string;
  callsign: string;
  carrierId: string;
  currentSystem: string;
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
  originSystemId: number;
  destinationSystem: string;
  destinationSystemId: number;
  departureTime: string;
  boardingDeadline: string;
  status: DepartureStatus;
  notes: string;
}

import type { DepartureData, DepartureStatus, ServiceState } from "../types";

const dateFormatter = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC"
});

export function formatUtcDate(value: Date | string) {
  const date = value instanceof Date ? value : new Date(value);
  return `${dateFormatter.format(date)} UTC`;
}

export function getNextDeparture(departures: DepartureData[]) {
  return departures
    .filter((departure) =>
      ["scheduled", "boarding", "delayed"].includes(departure.status)
    )
    .sort(
      (left, right) =>
        new Date(left.departureTime).getTime() -
        new Date(right.departureTime).getTime()
    )[0];
}

export function isExpired(date: Date | string) {
  const current = new Date();
  const expiry = date instanceof Date ? date : new Date(date);
  return expiry.getTime() < current.getTime();
}

export function serviceTone(status: ServiceState) {
  if (status === "online") return "online";
  if (status === "limited") return "warning";
  return "offline";
}

export function departureTone(status: DepartureStatus) {
  if (status === "boarding") return "online";
  if (status === "scheduled") return "info";
  if (status === "delayed") return "warning";
  return "offline";
}

export function priorityTone(priority: "low" | "normal" | "high" | "critical") {
  if (priority === "critical") return "critical";
  if (priority === "high") return "warning";
  if (priority === "low") return "muted";
  return "info";
}

export function titleToId(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

export function entrySlug(id: string) {
  return id.replace(/\.[^.]+$/, "");
}

export function nameToAssetSlug(value: string) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function crewPortraitPath(name: string) {
  return `/portraits/${nameToAssetSlug(name)}.png`;
}

export function crewProfileImagePath(name: string) {
  return `/img/personnel/${nameToAssetSlug(name)}.png`;
}

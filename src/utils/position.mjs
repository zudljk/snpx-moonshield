import { normaliseGameId } from "./identifiers.mjs";

export function sameSystem(left, right) {
  if (!left || !right) return false;
  if (left.systemAddress != null && right.systemAddress != null) {
    return normaliseGameId(left.systemAddress) === normaliseGameId(right.systemAddress);
  }
  return typeof left.name === "string" && typeof right.name === "string" &&
    left.name.trim().toLowerCase() === right.name.trim().toLowerCase();
}

export function carrierPosition(carrier) {
  return { name: carrier.currentSystem, systemAddress: carrier.currentSystemAddress };
}

// Shared boundary for polling now and timestamped Journal observations later.
export function applyPositionObservation(carrier, observation) {
  const { eventId, observedAt, source, name, systemAddress } = observation;
  if (typeof eventId !== "string" || !eventId || typeof source !== "string" || !source ||
      typeof name !== "string" || !name.trim() || !Number.isFinite(Date.parse(observedAt))) {
    throw new Error("Position observation requires eventId, source, name and a valid observedAt timestamp.");
  }
  const last = carrier.lastPositionObservation;
  if (last?.eventId === eventId || Date.parse(observedAt) <= Date.parse(last?.observedAt ?? carrier.lastPositionSyncAt)) {
    return { accepted: false, moved: false, carrier, reason: "Duplicate or stale position observation." };
  }
  const address = systemAddress == null ? undefined : normaliseGameId(systemAddress);
  const current = { name: name.trim(), systemAddress: address };
  const previous = carrierPosition(carrier);
  const moved = !sameSystem(previous, current);
  return {
    accepted: true, moved, previous, current,
    carrier: {
      ...carrier,
      currentSystem: current.name,
      currentSystemAddress: address ?? (!moved ? carrier.currentSystemAddress : undefined),
      ...(moved ? { previousSystem: previous.name, previousSystemAddress: previous.systemAddress } : {}),
      lastPositionObservation: { eventId, observedAt: new Date(observedAt).toISOString(), source },
    },
  };
}

// Game identifiers are unsigned 64-bit integers, stored as decimal strings.
// Reject already-rounded JSON numbers instead of silently using a different ID.
export function normaliseGameId(value) {
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value <= 0)) {
    throw new Error("Game ID must be a positive safe integer or a decimal string.");
  }
  if ((typeof value !== "number" && typeof value !== "string") || !/^\d+$/.test(String(value))) {
    throw new Error("Game ID must be a positive safe integer or a decimal string.");
  }
  const id = BigInt(value);
  if (id <= 0n || id > 18446744073709551615n) throw new Error("Game ID is outside the unsigned 64-bit range.");
  return id.toString();
}

export function inaraSystemUrl(name, systemAddress) {
  const search = systemAddress == null ? name : normaliseGameId(systemAddress);
  return `https://inara.cz/elite/starsystem/?search=${encodeURIComponent(search)}`;
}

export function inaraCarrierUrl(callsign) {
  return `https://inara.cz/elite/station/?search=${encodeURIComponent(callsign)}`;
}

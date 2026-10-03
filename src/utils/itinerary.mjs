import { sameSystem } from "./position.mjs";

export function validateItineraryId(id) {
  if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error("Itinerary must be a Spansh result UUID.");
  }
  return id;
}

// Spansh IDs are compared at the boundary; the supplied values are never rewritten.
export function advanceItinerary(data, previous, current) {
  const jumps = validateItinerary(data, data.job ?? "local route");
  const position = jump => jump && ({ name: jump.name, systemAddress: jump.id64 });
  const matches = (jump, system) => sameSystem(position(jump), system);
  const marked = jumps.flatMap((jump, index) => jump.current ? [index] : []);
  let index = data.moonshieldProgress?.currentIndex;
  if (index == null) index = marked.length === 1 ? marked[0] : -1;
  if (!Number.isInteger(index) || index < -1 || index >= jumps.length || marked.length > 1 ||
      (marked.length === 1 && marked[0] !== index)) {
    throw new Error("Inconsistent itinerary progress: current index and current marker must agree.");
  }
  const unchanged = reason => ({ data, index, advanced: false, reason });
  const uncertain = reason => ({
    data: { ...data, moonshieldProgress: { currentIndex: index, status: "uncertain", message: reason } },
    index, advanced: false, reason,
  });
  const confirm = (target, observedIndices) => ({
    index: target, advanced: target > index, reason: `Confirmed route stop ${target + 1}: ${current.name}.`,
    data: {
      ...data,
      moonshieldProgress: { currentIndex: target, status: "confirmed" },
      result: { ...data.result, jumps: jumps.map((jump, at) => ({
        ...jump,
        visited: jump.visited === true || observedIndices.includes(at),
        skipped: at < target && jump.visited !== true && !observedIndices.includes(at),
        current: at === target,
      })) },
    },
  });

  // Migrate legacy routes from their current marker, or an unambiguous observation.
  if (index === -1) {
    const anchors = jumps.flatMap((jump, at) => matches(jump, previous) ? [at] : []);
    if (anchors.length === 1) index = anchors[0];
    else return uncertain("Route position is ambiguous; no unique starting observation is available.");
  }
  if (sameSystem(previous, current)) {
    if (!matches(jumps[index], current)) return uncertain("Observed position differs from the last confirmed route stop.");
    if (data.moonshieldProgress?.status === "uncertain") return unchanged("No new movement observed; route uncertainty remains.");
    if (data.moonshieldProgress) return unchanged("No new movement observed.");
    return confirm(index, [index]);
  }

  // The next edge relative to the cursor takes precedence over repeated edges later on.
  if (matches(jumps[index], previous) && matches(jumps[index + 1], current)) {
    return confirm(index + 1, [index, index + 1]);
  }
  const pairs = jumps.flatMap((jump, at) => at > index &&
    matches(jumps[at - 1], previous) && matches(jump, current) ? [at] : []);
  if (pairs.length === 1) return confirm(pairs[0], [pairs[0] - 1, pairs[0]]);
  return uncertain(pairs.length > 1
    ? "Several remaining route legs match the observed movement; progress needs confirmation."
    : "Observed movement does not match a remaining route leg; intermediate observations may be missing.");
}

export async function fetchItinerary(id) {
  validateItineraryId(id);
  try {
    const response = await fetch(`https://spansh.co.uk/api/results/${id}`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    return validateItinerary(await response.json(), id);
  } catch (error) {
    throw new Error(`Could not load Spansh itinerary ${id}: ${error.message}`, { cause: error });
  }
}

export function validateItinerary(data, id) {
  const jumps = data?.result?.jumps;
  if (!Array.isArray(jumps) || jumps.some((jump) =>
    !jump || typeof jump.name !== "string" || !jump.name.trim() ||
    ["distance", "distance_to_destination", "fuel_used"].some((key) =>
      typeof jump[key] !== "number" || !Number.isFinite(jump[key]) || jump[key] < 0
    )
  )) {
    throw new Error(`Invalid itinerary "${id}": result.jumps must be an array of systems with name, distance, distance_to_destination and fuel_used.`);
  }
  return jumps;
}

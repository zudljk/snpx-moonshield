export function validateItineraryId(id) {
  if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error("Itinerary must be a Spansh result UUID.");
  }
  return id;
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

import { validateItinerary, validateItineraryId } from "../src/utils/itinerary.mjs";

async function request(endpoint, options = {}) {
  const response = await fetch(`https://spansh.co.uk/api/${endpoint}`, {
    ...options, signal: options.signal ?? AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Spansh ${endpoint}: HTTP ${response.status}`);
  return response.json();
}

export function parseCapacityUsed(value) {
  if (typeof value !== "string" || !/^\d+$/.test(value) || Number(value) > 25000) {
    throw new Error("--capacity-used must be an integer between 0 and 25000.");
  }
  return Number(value);
}

export async function findSystem(name) {
  const data = await request(`systems/field_values/system_names?q=${encodeURIComponent(name.trim())}`);
  const matches = (data.min_max ?? []).filter((system) =>
    typeof system.name === "string" && system.name.toLowerCase() === name.trim().toLowerCase());
  const ids = new Set(matches.map((system) => String(system.id64)));
  if (ids.size !== 1 || !/^\d+$/.test([...ids][0]) || matches.some((system) =>
    typeof system.id64 === "number" && !Number.isSafeInteger(system.id64))) {
    throw new Error(`Spansh: no unambiguous exact system match for "${name}".`);
  }
  return [...ids][0];
}

export async function waitForItinerary(id, { timeoutMs = 120_000, pollMs = 2000 } = {}) {
  validateItineraryId(id);
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    while (true) {
      signal.throwIfAborted();
      const data = await request(`results/${id}`, { signal });
      if (data.status === "queued" || data.status === "running") {
        await new Promise((resolve) => setTimeout(resolve, pollMs));
        continue;
      }
      if (data.status !== "ok") throw new Error(data.error ?? `Unexpected status: ${data.status}`);
      validateItinerary(data, id);
      return data;
    }
  } catch (error) {
    throw new Error(`Spansh job ${id}: ${signal.aborted ? "timed out waiting for route" : error.message}`, { cause: error });
  }
}

export async function calculateItinerary(sourceName, destinationName, capacityUsed, options) {
  parseCapacityUsed(String(capacityUsed));
  const [source, destination] = await Promise.all([findSystem(sourceName), findSystem(destinationName)]);
  const job = await request("fleetcarrier/route", {
    method: "POST",
    body: new URLSearchParams({ source, destinations: destination, capacity: "25000", mass: "25000",
      capacity_used: String(capacityUsed), calculate_starting_fuel: "1" }),
  });
  validateItineraryId(job.job);
  return { id: job.job, data: await waitForItinerary(job.job, options) };
}

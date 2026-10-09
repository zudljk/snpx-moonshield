#!/usr/bin/env node
import { readFile, writeFile, appendFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normaliseGameId } from "../src/utils/identifiers.mjs";
import { applyPositionObservation } from "../src/utils/position.mjs";
import { advanceItinerary, validateItineraryId } from "../src/utils/itinerary.mjs";

export function validateObservation(payload, carrierId, now = Date.now()) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Expected a position observation object.");
  const fields = ["schemaVersion", "carrierId", "eventId", "observedAt", "source", "name", "systemAddress"];
  if (Object.keys(payload).length !== fields.length || fields.some(key => !Object.hasOwn(payload, key))) {
    throw new Error("Unexpected observation fields.");
  }
  if (payload.schemaVersion !== 1 || payload.source !== "journal") throw new Error("Unsupported observation schema or source.");
  for (const key of ["carrierId", "systemAddress"]) {
    if (typeof payload[key] !== "string" || payload[key].length > 20 || normaliseGameId(payload[key]) !== payload[key]) {
      throw new Error(`${key} must be a canonical decimal string.`);
    }
  }
  if (payload.carrierId !== normaliseGameId(carrierId)) throw new Error("Observation belongs to another carrier.");
  if (typeof payload.name !== "string" || !payload.name.trim() || payload.name !== payload.name.trim() ||
      payload.name.length > 256 || /[\u0000-\u001f\u007f]/u.test(payload.name)) throw new Error("Invalid system name.");
  const timestamp = Date.parse(payload.observedAt);
  if (typeof payload.observedAt !== "string" || !Number.isFinite(timestamp) ||
      new Date(timestamp).toISOString() !== payload.observedAt || timestamp > now + 5 * 60_000) {
    throw new Error("Observation timestamp must be canonical UTC and not in the future.");
  }
  const digest = createHash("sha256").update(JSON.stringify([payload.carrierId, payload.observedAt, payload.systemAddress])).digest("hex");
  if (payload.eventId !== `journal:${digest}`) throw new Error("Observation eventId does not match its identity.");
  return payload;
}

export function extractObservation(event) {
  if (event.action === "moonshield-position-v1") return event.client_payload;
  if (typeof event.inputs?.observation === "string") return JSON.parse(event.inputs.observation);
  throw new Error("Expected moonshield-position-v1 dispatch or manual observation input.");
}

export async function importObservation(root, payload, { dryRun = false, now = Date.now() } = {}) {
  const carrierFile = "src/data/carrier.json";
  const read = async file => JSON.parse(await readFile(path.join(root, file), "utf8"));
  const carrier = await read(carrierFile);
  validateObservation(payload, carrier.carrierId, now);
  const observation = applyPositionObservation(carrier, payload);
  if (!observation.accepted) return { accepted: false, changed: [], reason: observation.reason };
  const nextCarrier = {
    ...observation.carrier,
    locationNote: `Holding position at ${payload.name}.`,
    lastPositionSyncAt: payload.observedAt,
  };
  const departures = await read("src/data/departures.json");
  if (!Array.isArray(departures)) throw new Error("departures.json must contain an array.");
  const active = departures.filter(item => ["scheduled", "boarding", "delayed"].includes(item.status))
    .sort((left, right) => Date.parse(right.departureTime) - Date.parse(left.departureTime))[0];
  // Compute and validate everything before writing any files.
  const updates = new Map([[carrierFile, nextCarrier]]);
  let progress;
  if (active?.itinerary) {
    const itineraryFile = `src/data/itinerary/${validateItineraryId(active.itinerary)}.json`;
    const original = await read(itineraryFile);
    progress = advanceItinerary(original, observation.previous, observation.current);
    if (JSON.stringify(original) !== JSON.stringify(progress.data)) updates.set(itineraryFile, progress.data);
  }
  if (!dryRun) {
    for (const [file, data] of updates) await writeFile(path.join(root, file), `${JSON.stringify(data, null, 2)}\n`);
  }
  return { accepted: true, moved: observation.moved, changed: [...updates.keys()],
    reason: progress?.reason ?? "Carrier position observation accepted." };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const files = args.filter(value => value !== "--dry-run");
  if (files.length > 1) throw new Error("Usage: node scripts/journal-position.mjs [event.json] [--dry-run]");
  const eventFile = files[0] ?? process.env.GITHUB_EVENT_PATH;
  if (!eventFile) throw new Error("Provide a GitHub event JSON file or GITHUB_EVENT_PATH.");
  const root = fileURLToPath(new URL("../", import.meta.url));
  const event = JSON.parse(await readFile(eventFile, "utf8"));
  const result = await importObservation(root, extractObservation(event), { dryRun });
  console.log(`${dryRun ? "Preview: " : ""}${result.reason}`);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT,
    `changed=${!dryRun && result.changed.length > 0}\naccepted=${result.accepted}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
    `Journal observation: ${result.accepted ? "accepted" : "duplicate or stale"}. ${dryRun ? "Preview only; no files written." : `${result.changed.length} data file(s) updated.`}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`Error: ${error.message}`); process.exitCode = 1; });
}

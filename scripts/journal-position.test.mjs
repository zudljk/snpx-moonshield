import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { validateObservation, extractObservation, importObservation } from "./journal-position.mjs";

const now = Date.parse("2026-10-03T12:00:00Z");
const carrierId = "3706829824";
const id = "323222D0-B9C9-11F1-9E6C-D258A06F1FBD";
const routeFile = `src/data/itinerary/${id}.json`;
function payload(name = "B", address = "2", at = "2026-10-03T10:00:00.000Z") {
  const eventId = "journal:" + createHash("sha256").update(JSON.stringify([carrierId, at, address])).digest("hex");
  return { schemaVersion: 1, carrierId, eventId, observedAt: at, source: "journal", name, systemAddress: address };
}
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "moonshield-journal-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "src/data/itinerary"), { recursive: true });
  const save = (file, value) => writeFile(path.join(root, file), JSON.stringify(value, null, 2) + "\n");
  const read = async file => JSON.parse(await readFile(path.join(root, file), "utf8"));
  await save("src/data/carrier.json", { carrierId, currentSystem: "A", currentSystemAddress: "1", status: "En Route", lastPositionSyncAt: "2026-10-03T09:00:00.000Z" });
  await save("src/data/departures.json", [{ status: "boarding", departureTime: "3312-09-21", itinerary: id }]);
  const route = { result: { jumps: ["A", "B", "C", "B"].map((name, at) => ({
    name, id64: [1, 2, 3, 2][at], distance: 1, distance_to_destination: 1, fuel_used: 1, current: at === 0, visited: at === 0,
  })) } };
  await save(routeFile, route);
  return { root, read, save, route };
}

test("receiver verifies the exact EDMC payload including Python's deterministic event ID", () => {
  const python = execFileSync("python3", ["-c", `import json; from edmc.Moonshield.moonshield_core import observation; print(json.dumps(observation({'event':'CarrierLocation','CarrierID':3706829824,'timestamp':'2026-10-03T10:00:00Z','StarSystem':'B','SystemAddress':2},'3706829824')))`], { cwd: new URL("../", import.meta.url), encoding: "utf8" });
  assert.deepEqual(validateObservation(JSON.parse(python), carrierId, now), payload());
  assert.equal(validateObservation(payload("B", "18446744073709551615"), carrierId, now).systemAddress, "18446744073709551615");
});

test("malformed, foreign, spoofed and future observations are rejected", () => {
  for (const changes of [
    { schemaVersion: 2 }, { source: "inara" }, { carrierId: "123" }, { systemAddress: 2 },
    { systemAddress: "02" }, { systemAddress: "18446744073709551616" }, { name: "\n::error::bad" },
    { name: " " }, { name: "B".repeat(257) }, { observedAt: "invalid" }, { observedAt: "2026-10-03T10:00:00Z" },
    { eventId: "journal:" + "0".repeat(64) }, { command: "echo unexpected" },
  ]) assert.throws(() => validateObservation({ ...payload(), ...changes }, carrierId, now));
  assert.throws(() => validateObservation(payload("B", "2", "2026-10-04T10:00:00.000Z"), carrierId, now), /future/);
  for (const input of [null, [], "payload", {}]) assert.throws(() => validateObservation(input, carrierId, now));
});

test("dispatch and manual preview use the same parser without interpreting payload as code", () => {
  assert.deepEqual(extractObservation({ action: "moonshield-position-v1", client_payload: payload() }), payload());
  assert.deepEqual(extractObservation({ inputs: { observation: JSON.stringify(payload()) } }), payload());
  assert.throws(() => extractObservation({ action: "another-event" }), /Expected/);
});

test("updates only carrier and active itinerary; replay and stale events do not write", async t => {
  const f = await fixture(t);
  const result = await importObservation(f.root, payload(), { now });
  assert.deepEqual(result.changed, ["src/data/carrier.json", routeFile]);
  const saved = await f.read("src/data/carrier.json");
  assert.equal(saved.currentSystem, "B");
  assert.equal(saved.previousSystem, "A");
  assert.equal(saved.status, "En Route");
  assert.equal(saved.lastPositionObservation.eventId, payload().eventId);
  assert.equal(saved.lastPositionSyncAt, payload().observedAt);
  const route = await f.read(routeFile);
  assert.equal(route.moonshieldProgress.currentIndex, 1);
  assert.equal(route.result.jumps[1].id64, 2);
  assert.equal((await importObservation(f.root, payload(), { now })).accepted, false);
  assert.equal((await importObservation(f.root, payload("A", "1", "2026-10-03T09:30:00.000Z"), { now })).accepted, false);
  assert.deepEqual(await f.read("src/data/carrier.json"), saved);
  assert.deepEqual(await f.read(routeFile), route);
  await importObservation(f.root, payload("B", "2", "2026-10-03T10:01:00.000Z"), { now });
  assert.equal((await f.read(routeFile)).moonshieldProgress.currentIndex, 1);
});

test("dry-run, invalid events and route errors leave data unchanged", async t => {
  const f = await fixture(t);
  const carrier = await f.read("src/data/carrier.json");
  const result = await importObservation(f.root, payload(), { dryRun: true, now });
  assert.equal(result.accepted, true);
  assert.deepEqual(await f.read("src/data/carrier.json"), carrier);
  assert.deepEqual(await f.read(routeFile), f.route);
  await assert.rejects(importObservation(f.root, { ...payload(), carrierId: "123" }, { now }), /another carrier/);
  await f.save(routeFile, { result: { jumps: "broken" } });
  await assert.rejects(importObservation(f.root, payload(), { now }), /Invalid itinerary/);
  assert.deepEqual(await f.read("src/data/carrier.json"), carrier);
});

test("off-route locations are committed with uncertainty, completed routes stay unchanged", async t => {
  const f = await fixture(t);
  await importObservation(f.root, payload("X", "99"), { now });
  assert.equal((await f.read("src/data/carrier.json")).currentSystem, "X");
  const route = await f.read(routeFile);
  assert.equal(route.moonshieldProgress.currentIndex, 0);
  assert.equal(route.moonshieldProgress.status, "uncertain");
  await f.save("src/data/departures.json", [{ status: "completed", itinerary: id }]);
  await importObservation(f.root, payload("B", "2", "2026-10-03T10:01:00.000Z"), { now });
  assert.deepEqual(await f.read(routeFile), route);
});

test("out-of-order workflow runs cannot move the carrier backwards", async t => {
  const f = await fixture(t);
  await importObservation(f.root, payload("C", "3", "2026-10-03T10:02:00.000Z"), { now });
  const late = await importObservation(f.root, payload(), { now });
  assert.equal(late.accepted, false);
  assert.equal((await f.read("src/data/carrier.json")).currentSystem, "C");
  assert.equal((await f.read(routeFile)).moonshieldProgress.status, "uncertain");
});

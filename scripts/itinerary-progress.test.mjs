import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { advanceItinerary } from "../src/utils/itinerary.mjs";

const route = () => ({ result: { jumps: ["A", "B", "C", "B", "A"].map(name => ({ name, distance: 1, distance_to_destination: 1, fuel_used: 1 })) } });

test("progress persists through repeated route systems and includes skipped stations", () => {
  const original = route();
  const first = advanceItinerary(original, "B");
  assert.equal(first.index, 1);
  assert.deepEqual(first.data.result.jumps.map(j => j.visited), [true, true, false, false, false]);
  assert.equal(original.result.jumps[0].visited, undefined);
  const second = advanceItinerary(first.data, "B");
  assert.equal(second.index, 3);
  assert.deepEqual(second.data.result.jumps.map(j => j.current), [false, false, false, true, false]);
  assert.deepEqual(second.data.result.jumps.map(j => j.visited), [true, true, true, true, false]);
  const last = advanceItinerary(second.data, "A");
  assert.equal(last.index, 4);
  assert(last.data.result.jumps.every(j => j.visited));
  assert.equal(advanceItinerary(last.data, "A").data, last.data);
});

test("absent systems preserve progress; matching handles casing and whitespace", () => {
  const first = advanceItinerary(route(), " b ").data;
  assert.equal(first.result.jumps[1].current, true);
  assert.equal(advanceItinerary(first, "Other").data, first);
});

test("sync-position persists progress only for the latest active route and honors dry-run", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "moonshield-progress-")));
  const id = "323222D0-B9C9-11F1-9E6C-D258A06F1FBD";
  const oldId = "323222D0-B9C9-11F1-9E6C-D258A06F1FBE";
  try {
    for (const dir of ["scripts", "src/utils", "src/data/itinerary"]) await mkdir(path.join(root, dir), { recursive: true });
    for (const file of ["scripts/moonshield.mjs", "scripts/spansh.mjs", "src/utils/itinerary.mjs", "src/utils/identifiers.mjs"]) await copyFile(new URL(`../${file}`, import.meta.url), path.join(root, file));
    const save = (file, data) => writeFile(path.join(root, file), JSON.stringify(data));
    const read = async file => JSON.parse(await readFile(path.join(root, file), "utf8"));
    const carrier = { name: "Test", callsign: "HHY-NTG", carrierId: "3706829824", currentSystem: "A", currentSystemAddress: "2" };
    const departures = [{ status: "completed", departureTime: "3312-01-01", itinerary: oldId }, { status: "boarding", departureTime: "3312-02-01", itinerary: id }];
    await save("src/data/carrier.json", carrier);
    await save("src/data/departures.json", departures);
    for (const uuid of [id, oldId]) await save(`src/data/itinerary/${uuid}.json`, route());
    await writeFile(path.join(root, "mock.mjs"), `globalThis.fetch = async url => new Response(url.includes("spansh.co.uk") ? JSON.stringify({ min_max: [{ name: "B", id64: 42 }] }) : '<a href="/elite/starsystem/3/">B</a>');`);
    const run = args => execFileSync(process.execPath, ["--import", path.join(root, "mock.mjs"), path.join(root, "scripts/moonshield.mjs"), "sync-position", ...args]);
    run(["--dry-run"]);
    assert.deepEqual(await read("src/data/carrier.json"), carrier);
    assert.deepEqual(await read(`src/data/itinerary/${id}.json`), route());
    run([]);
    assert.equal((await read("src/data/carrier.json")).currentSystem, "B");
    assert.equal((await read(`src/data/itinerary/${id}.json`)).result.jumps[1].current, true);
    run([]);
    assert.equal((await read(`src/data/itinerary/${id}.json`)).result.jumps[3].current, true);
    assert.deepEqual(await read(`src/data/itinerary/${oldId}.json`), route());
    assert.deepEqual(await read("src/data/departures.json"), departures);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

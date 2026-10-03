import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { advanceItinerary } from "../src/utils/itinerary.mjs";

const route = (names = ["A", "B", "C", "B", "A"]) => ({ result: { jumps: names.map((name, index) => ({ name, distance: 1, distance_to_destination: 1, fuel_used: 1, current: index === 0, visited: index === 0 })) } });
const pos = (name, systemAddress) => ({ name, systemAddress });
const advance = (data, from, to) => advanceItinerary(data, pos(from), pos(to));

test("repeated systems advance only on movement and never twice on one arrival", () => {
  const original = route();
  const first = advance(original, "A", "B");
  assert.equal(first.index, 1);
  assert.equal(advance(first.data, "B", "B").data, first.data);
  const second = advance(first.data, "B", "C");
  const third = advance(second.data, "C", "B");
  assert.equal(third.index, 3);
  assert.equal(advance(third.data, "B", "B").index, 3);
  const last = advance(third.data, "B", "A");
  assert.equal(last.index, 4);
  assert(last.data.result.jumps.every(j => j.visited));
  assert.equal(advance(last.data, "A", "A").data, last.data);
  assert.equal(original.result.jumps[0].current, true);
});

test("the next leg takes precedence over a repeated pair later in the route", () => {
  let data = route(["A", "B", "C", "A", "B"]);
  for (const [from, to, index] of [["A", "B", 1], ["B", "C", 2], ["C", "A", 3], ["A", "B", 4]]) {
    const result = advance(data, from, to);
    assert.equal(result.index, index);
    data = result.data;
  }
});

test("missing intermediate observations preserve the cursor and visited flags", () => {
  const data = route(["A", "B", "C", "D"]);
  const gap = advance(data, "A", "C");
  assert.equal(gap.index, 0);
  assert.equal(gap.data.moonshieldProgress.status, "uncertain");
  assert.deepEqual(gap.data.result, data.result);
  const repeated = advance(gap.data, "C", "C");
  assert.equal(repeated.index, 0);
  assert.equal(repeated.data.moonshieldProgress.status, "uncertain");
  const recovered = advance(repeated.data, "C", "D");
  assert.equal(recovered.index, 3);
  assert.equal(recovered.data.moonshieldProgress.status, "confirmed");
  assert.deepEqual(recovered.data.result.jumps.map(j => j.visited), [true, false, true, true]);
  assert.deepEqual(recovered.data.result.jumps.map(j => j.skipped), [false, true, false, false]);
});

test("ambiguous pairs, off-route positions and backwards movement do not advance", () => {
  const data = route(["A", "B", "C", "D", "C", "D"]);
  for (const [from, to] of [["C", "D"], ["A", "X"]]) {
    const result = advance(data, from, to);
    assert.equal(result.index, 0);
    assert.equal(result.data.moonshieldProgress.status, "uncertain");
    assert.deepEqual(result.data.result, data.result);
  }
  const moved = advance(data, "A", "B");
  assert.equal(advance(moved.data, "B", "A").index, 1);
});

test("IDs take precedence, numeric Spansh IDs stay intact and names are a fallback", () => {
  const data = route(["Old A", "Old B"]);
  data.result.jumps[0].id64 = 123;
  data.result.jumps[1].id64 = 456;
  const result = advanceItinerary(data, pos("New A", "123"), pos("New B", "456"));
  assert.equal(result.index, 1);
  assert.equal(result.data.result.jumps[1].id64, 456);
  assert.equal(advanceItinerary(data, pos("Old A", "123"), pos("Old B", "789")).index, 0);
  assert.equal(advance(data, " old a ", " OLD B ").index, 1);
});

test("legacy current flags migrate; an unmarked repeated starting system is ambiguous", () => {
  const data = route();
  const migrated = advance(data, "A", "A");
  assert.equal(migrated.data.moonshieldProgress.currentIndex, 0);
  assert.equal(migrated.index, 0);
  const fresh = route();
  fresh.result.jumps.forEach(j => { delete j.current; delete j.visited; });
  assert.equal(advance(fresh, "A", "B").data.moonshieldProgress.status, "uncertain");
  const unique = route(["A", "B"]);
  unique.result.jumps.forEach(j => { delete j.current; delete j.visited; });
  assert.equal(advance(unique, "A", "B").index, 1);
});

test("equal endpoints cannot prove a round trip; uncertainty survives repeated observations", () => {
  const first = advance(route(), "A", "A");
  assert.equal(advance(first.data, "A", "A").index, 0);
  const unknown = advance(first.data, "A", "X");
  const returned = advance(unknown.data, "X", "A");
  assert.equal(returned.index, 0);
  assert.equal(advance(returned.data, "A", "A").data.moonshieldProgress.status, "uncertain");
});

test("sync-position persists progress only for the latest active route and honors dry-run", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "moonshield-progress-")));
  const id = "323222D0-B9C9-11F1-9E6C-D258A06F1FBD";
  const oldId = "323222D0-B9C9-11F1-9E6C-D258A06F1FBE";
  try {
    for (const dir of ["scripts", "src/utils", "src/data/itinerary"]) await mkdir(path.join(root, dir), { recursive: true });
    for (const file of ["scripts/moonshield.mjs", "scripts/spansh.mjs", "src/utils/itinerary.mjs", "src/utils/identifiers.mjs", "src/utils/position.mjs"]) await copyFile(new URL(`../${file}`, import.meta.url), path.join(root, file));
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
    assert.equal((await read(`src/data/itinerary/${id}.json`)).result.jumps[1].current, true);
    assert.equal((await read(`src/data/itinerary/${id}.json`)).moonshieldProgress.currentIndex, 1);
    assert.equal((await read("src/data/carrier.json")).previousSystem, "A");
    const beforeUncertainty = await read(`src/data/itinerary/${id}.json`);
    const mockSystem = async name => writeFile(path.join(root, "mock.mjs"), `globalThis.fetch = async url => new Response(url.includes("spansh.co.uk") ? JSON.stringify({ min_max: [{ name: ${JSON.stringify(name)}, id64: ${name === "B" ? 42 : name === "C" ? 43 : 99} }] }) : '<a href="/elite/starsystem/3/">${name}</a>');`);
    await mockSystem("X");
    run(["--dry-run"]);
    assert.deepEqual(await read(`src/data/itinerary/${id}.json`), beforeUncertainty);
    run([]);
    assert.equal((await read("src/data/carrier.json")).currentSystem, "X");
    let uncertain = await read(`src/data/itinerary/${id}.json`);
    assert.equal(uncertain.moonshieldProgress.status, "uncertain");
    assert.deepEqual(uncertain.result, beforeUncertainty.result);
    run([]);
    assert.equal((await read(`src/data/itinerary/${id}.json`)).moonshieldProgress.currentIndex, 1);
    await mockSystem("C");
    run([]);
    await mockSystem("B");
    run([]);
    const recovered = await read(`src/data/itinerary/${id}.json`);
    assert.equal(recovered.moonshieldProgress.currentIndex, 3);
    assert.equal(recovered.moonshieldProgress.status, "confirmed");
    assert.deepEqual(await read(`src/data/itinerary/${oldId}.json`), route());
    assert.deepEqual(await read("src/data/departures.json"), departures);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

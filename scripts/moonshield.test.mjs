import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchHtml } from "./moonshield.mjs";
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("identifies the CLI and suggests retrying later when Inara returns HTTP 503", async (t) => {
  const url = "https://inara.cz/elite/station/356014/";
  const fetchMock = t.mock.method(globalThis, "fetch", async (requestedUrl, options) => {
    assert.equal(requestedUrl, url);
    assert.equal(options.headers["user-agent"], "moonshield-jump-control/0.1 (+https://inara.cz/)");
    return new Response("<html>Station</html>");
  });
  assert.equal(await fetchHtml(url), "<html>Station</html>");
  fetchMock.mock.mockImplementation(async () => new Response("Unavailable", {
    status: 503, statusText: "Service Unavailable",
  }));
  await assert.rejects(fetchHtml(url), /Inara is temporarily unavailable \(HTTP 503\). Please try again later\./);
  fetchMock.mock.mockImplementation(async () => new Response("Not found", {
    status: 404, statusText: "Not Found",
  }));
  await assert.rejects(fetchHtml(url), /404 Not Found/);
});

async function fixture(t, fetchSource) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "moonshield-ids-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of ["scripts", "src/utils", "src/data"]) await mkdir(path.join(root, dir), { recursive: true });
  for (const file of ["scripts/moonshield.mjs", "scripts/spansh.mjs", "src/utils/itinerary.mjs", "src/utils/identifiers.mjs"]) {
    await copyFile(new URL(`../${file}`, import.meta.url), path.join(root, file));
  }
  const save = (file, data) => writeFile(path.join(root, "src/data", file), JSON.stringify(data));
  const read = async file => JSON.parse(await readFile(path.join(root, "src/data", file), "utf8"));
  const carrier = { name: "Moonshield", callsign: "HHY-NTG", carrierId: "3706829824", currentSystem: "A", currentSystemAddress: "123", status: "En Route" };
  const departures = [{ title: "Old route", status: "boarding", departureTime: "3312-01-01T00:00:00Z" }];
  await save("carrier.json", carrier);
  await save("departures.json", departures);
  await writeFile(path.join(root, "mock.mjs"), `import assert from 'node:assert/strict';\nglobalThis.fetch = ${fetchSource};`);
  const run = (...args) => spawnSync(process.execPath, ["--import", path.join(root, "mock.mjs"), path.join(root, "scripts/moonshield.mjs"), ...args], { encoding: "utf8" });
  return { run, read, save, carrier, departures };
}

test("sync uses the callsign, stores the game address and honors dry-run", async t => {
  const f = await fixture(t, `async url => {
    if (url === 'https://inara.cz/elite/station/?search=HHY-NTG') return new Response('<a href="/elite/starsystem/777/">B</a>');
    assert.equal(url, 'https://spansh.co.uk/api/systems/field_values/system_names?q=B');
    return new Response(JSON.stringify({ min_max: [{ name: 'B', id64: '9007199254740993' }] }));
  }`);
  let result = f.run("sync-position", "--dry-run");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await f.read("carrier.json"), f.carrier);
  result = f.run("sync-position");
  assert.equal(result.status, 0, result.stderr);
  const saved = await f.read("carrier.json");
  assert.equal(saved.currentSystem, "B");
  assert.equal(saved.currentSystemAddress, "9007199254740993");
  assert.equal(saved.carrierId, "3706829824");
  assert.equal(saved.currentSystemId, undefined);
  assert.equal(saved.stationId, undefined);
});

test("failed system resolution clears a stale address without losing the new position", async t => {
  const f = await fixture(t, `async url => url.includes('inara.cz')
    ? new Response('<a href="/elite/starsystem/777/">B</a>')
    : new Response('Unavailable', { status: 503 })`);
  const result = f.run("sync-position");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /System address unresolved/);
  const saved = await f.read("carrier.json");
  assert.equal(saved.currentSystem, "B");
  assert.equal(saved.currentSystemAddress, undefined);
  assert.equal(saved.currentSystemId, undefined);
});

test("sync reuses a confirmed address for the unchanged system without a Spansh request", async t => {
  const f = await fixture(t, `async url => {
    assert.equal(url, 'https://inara.cz/elite/station/?search=HHY-NTG');
    return new Response('<a href="/elite/starsystem/777/">A</a>');
  }`);
  const result = f.run("sync-position");
  assert.equal(result.status, 0, result.stderr);
  assert.equal((await f.read("carrier.json")).currentSystemAddress, "123");
});

const scheduleArgs = ["schedule-jump", "--title", "New route", "--destination", "B", "--departure", "3312-02-01T12:00:00Z"];

test("schedule-jump stores game addresses without Inara and dry-run only performs lookups", async t => {
  const f = await fixture(t, `async url => {
    assert.equal(url, 'https://spansh.co.uk/api/systems/field_values/system_names?q=B');
    return new Response(JSON.stringify({ min_max: [{ name: 'B', id64: 456 }] }));
  }`);
  const id = "323222D0-B9C9-11F1-9E6C-D258A06F1FBD";
  for (const optional of [[], ["--capacity-used", "0"], ["--itinerary", id]]) {
    const result = f.run(...scheduleArgs, ...optional, "--dry-run");
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(await f.read("departures.json"), f.departures);
  }
  const result = f.run(...scheduleArgs);
  assert.equal(result.status, 0, result.stderr);
  const saved = await f.read("departures.json");
  assert.equal(saved[0].status, "completed");
  assert.equal(saved[1].originSystemAddress, "123");
  assert.equal(saved[1].destinationSystemAddress, "456");
  assert.equal(saved[1].originSystemId, undefined);
  assert.equal(saved[1].destinationSystemId, undefined);
});

test("schedule resolves a missing origin address and preserves imported numeric route IDs", async t => {
  const id = "323222D0-B9C9-11F1-9E6C-D258A06F1FBD";
  const f = await fixture(t, `async url => {
    assert(url.startsWith('https://spansh.co.uk/api/'));
    if (url.includes('/results/')) return new Response(JSON.stringify({ status: 'ok', result: { jumps: [
      { name: 'A', id64: 123, distance: 0, distance_to_destination: 1, fuel_used: 0 },
      { name: 'B', id64: 456, distance: 1, distance_to_destination: 0, fuel_used: 1 }
    ] } }));
    const name = new URL(url).searchParams.get('q');
    return new Response(JSON.stringify({ min_max: [{ name, id64: name === 'A' ? 123 : 456 }] }));
  }`);
  delete f.carrier.currentSystemAddress;
  await f.save("carrier.json", f.carrier);
  const result = f.run(...scheduleArgs, "--itinerary", id);
  assert.equal(result.status, 0, result.stderr);
  assert.equal((await f.read("departures.json"))[1].originSystemAddress, "123");
  const route = await f.read(`itinerary/${id}.json`);
  assert.deepEqual(route.result.jumps.map(jump => jump.id64), [123, 456]);
});

test("ambiguous destinations leave both carrier and departure data unchanged", async t => {
  const f = await fixture(t, `async () => new Response(JSON.stringify({ min_max: [{ name: 'B', id64: 456 }, { name: 'B', id64: 789 }] }))`);
  const result = f.run(...scheduleArgs);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unambiguous exact system match/);
  assert.deepEqual(await f.read("carrier.json"), f.carrier);
  assert.deepEqual(await f.read("departures.json"), f.departures);
});

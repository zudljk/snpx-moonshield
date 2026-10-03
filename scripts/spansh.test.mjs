import assert from "node:assert/strict";
import { test } from "node:test";
import { calculateItinerary, findSystem, parseCapacityUsed, waitForItinerary } from "./spansh.mjs";

const id = "323222D0-B9C9-11F1-9E6C-D258A06F1FBD";
const jumps = [{ name: "Target", distance: 0, distance_to_destination: 0, fuel_used: 0 }];
const response = (data) => new Response(JSON.stringify(data));

test("selects exact names, submits form parameters, and polls queued/running jobs", async (t) => {
  let polls = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (url.includes("system_names")) {
      const name = new URL(url).searchParams.get("q");
      return response({ min_max: [{ name: `${name} 2`, id64: 999 }, { name, id64: name === "Origin" ? 123 : 456 }] });
    }
    if (url.endsWith("fleetcarrier/route")) {
      assert.equal(options.method, "POST");
      assert.deepEqual(Object.fromEntries(options.body), { source: "123", destinations: "456", capacity: "25000", mass: "25000", capacity_used: "5208", calculate_starting_fuel: "1" });
      return response({ job: id, status: "queued" });
    }
    assert(url.endsWith(id));
    return response(++polls === 1 ? { status: "queued" } : polls === 2 ? { status: "running" } : { status: "ok", result: { jumps } });
  });
  assert.deepEqual(await calculateItinerary("Origin", "Target", 5208, { pollMs: 0 }), { id, data: { status: "ok", result: { jumps } } });
  assert.equal(polls, 3);
});

test("rejects approximate and ambiguous system matches", async (t) => {
  const results = [[{ name: "Target 2", id64: 1 }], [{ name: "Target", id64: 1 }, { name: "Target", id64: 2 }]];
  t.mock.method(globalThis, "fetch", async () => response({ min_max: results.shift() }));
  await assert.rejects(findSystem("Target"), /exact system match/);
  await assert.rejects(findSystem("Target"), /exact system match/);
});

test("route imports preserve Spansh ID types and other payload fields", async t => {
  const data = {
    status: "ok",
    result: {
      source: "123",
      jumps: [
        { ...jumps[0], id64: 123, visited: true },
        { ...jumps[0], id64: "9007199254740993" },
        { ...jumps[0] },
      ],
    },
  };
  t.mock.method(globalThis, "fetch", async () => response(data));
  assert.deepEqual(await waitForItinerary(id), data);
});

test("validates capacity including zero", () => {
  assert.equal(parseCapacityUsed("0"), 0);
  assert.equal(parseCapacityUsed("25000"), 25000);
  for (const value of [true, "", "-1", "25001", "1.5", "NaN"]) assert.throws(() => parseCapacityUsed(value));
});

test("reports failed jobs and stops polling at the deadline", async (t) => {
  t.mock.method(globalThis, "fetch", async () => response({ status: "error", error: "No route" }));
  await assert.rejects(waitForItinerary(id), /No route/);
  globalThis.fetch = async () => response({ status: "queued" });
  await assert.rejects(waitForItinerary(id, { timeoutMs: 10, pollMs: 5 }), /timed out/);
});

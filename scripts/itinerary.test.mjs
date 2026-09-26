import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchItinerary } from "../src/utils/itinerary.mjs";

const id = "F729E490-B9BC-11F1-AFDE-BC72EDD44A13";

test("loads and validates a Spansh result by UUID", async (t) => {
  const jumps = [{ name: "HIP 90833", distance: 0, distance_to_destination: 7552, fuel_used: 0 }];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, `https://spansh.co.uk/api/results/${id}`);
    assert(options.signal instanceof AbortSignal);
    return new Response(JSON.stringify({ result: { jumps } }));
  });
  assert.deepEqual(await fetchItinerary(id), jumps);
});

test("rejects invalid UUIDs before fetching", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", () => { throw new Error("Unexpected request"); });
  for (const value of ["route.json", "../route", "https://spansh.co.uk/api/results/" + id, undefined]) {
    await assert.rejects(fetchItinerary(value), /Spansh result UUID/);
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test("reports failed, pending and malformed Spansh results with the UUID", async (t) => {
  const responses = [
    new Response("Not found", { status: 404 }),
    new Response(JSON.stringify({ status: "queued" })),
    new Response("invalid JSON"),
    new Response(JSON.stringify({ result: { jumps: [{ name: "Test", distance: "10" }] } })),
  ];
  t.mock.method(globalThis, "fetch", async () => responses.shift());
  for (let i = 0; i < 4; i++) await assert.rejects(fetchItinerary(id), new RegExp(`Could not load Spansh itinerary ${id}`));
});

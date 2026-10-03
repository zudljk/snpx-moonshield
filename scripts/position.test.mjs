import assert from "node:assert/strict";
import { test } from "node:test";
import { applyPositionObservation } from "../src/utils/position.mjs";

const carrier = { currentSystem: "A", currentSystemAddress: "123" };
const event = (eventId, observedAt, name = "B", systemAddress = "456") => ({ eventId, observedAt, name, systemAddress, source: "journal" });

test("duplicate, older and same-time observations never roll back the carrier", () => {
  const first = applyPositionObservation(carrier, event("one", "2026-10-03T12:00:00Z"));
  assert.equal(first.moved, true);
  assert.equal(first.carrier.previousSystem, "A");
  assert.equal(first.carrier.previousSystemAddress, "123");
  for (const observation of [event("one", "2026-10-03T12:01:00Z"), event("old", "2026-10-03T11:00:00Z", "A", "123"), event("same-time", "2026-10-03T12:00:00Z", "A", "123")]) {
    const ignored = applyPositionObservation(first.carrier, observation);
    assert.equal(ignored.accepted, false);
    assert.equal(ignored.carrier, first.carrier);
  }
  const confirmed = applyPositionObservation(first.carrier, event("two", "2026-10-03T12:01:00Z"));
  assert.equal(confirmed.accepted, true);
  assert.equal(confirmed.moved, false);
  assert.equal(confirmed.carrier.previousSystem, "A");
});

test("new positions clear stale addresses; unchanged names retain known addresses", () => {
  const same = applyPositionObservation(carrier, event("one", "2026-10-03T12:00:00Z", "A", null));
  assert.equal(same.carrier.currentSystemAddress, "123");
  const moved = applyPositionObservation(carrier, event("two", "2026-10-03T12:00:00Z", "C", null));
  assert.equal(moved.carrier.currentSystemAddress, undefined);
});

test("invalid observations fail before mutating state; legacy timestamps reject older events", () => {
  assert.throws(() => applyPositionObservation(carrier, event("one", "invalid")), /observation requires/);
  assert.throws(() => applyPositionObservation(carrier, event("", "2026-10-03T12:00:00Z")), /observation requires/);
  assert.equal(applyPositionObservation({ ...carrier, lastPositionSyncAt: "2026-10-03T12:00:00Z" }, event("old", "2026-10-02T12:00:00Z")).accepted, false);
});

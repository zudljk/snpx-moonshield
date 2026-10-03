import assert from "node:assert/strict";
import { test } from "node:test";
import { inaraCarrierUrl, inaraSystemUrl, normaliseGameId } from "../src/utils/identifiers.mjs";
import { findSystem } from "./spansh.mjs";

test("game IDs retain precision and reject rounded or invalid values", () => {
  assert.equal(normaliseGameId(3706829824), "3706829824");
  assert.equal(normaliseGameId("00042"), "42");
  assert.equal(normaliseGameId("18446744073709551615"), "18446744073709551615");
  for (const value of [9007199254740992, "18446744073709551616", 0, -1, 1.5, "", "1e3", "HHY-NTG", null, undefined, true]) {
    assert.throws(() => normaliseGameId(value), /Game ID/);
  }
});

test("Inara links use game addresses, with encoded names for unresolved systems", () => {
  assert.equal(inaraSystemUrl("Ignored", "9007199254740993"), "https://inara.cz/elite/starsystem/?search=9007199254740993");
  assert.equal(inaraSystemUrl("A & B"), "https://inara.cz/elite/starsystem/?search=A%20%26%20B");
  assert.equal(inaraCarrierUrl("HHY-NTG"), "https://inara.cz/elite/station/?search=HHY-NTG");
});

test("Spansh lookup retains large string IDs and rejects unsafe JSON numbers", async t => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ min_max: [{ name: "A", id64: "9007199254740993" }] })));
  assert.equal(await findSystem("A"), "9007199254740993");
  globalThis.fetch = async () => new Response('{"min_max":[{"name":"A","id64":9007199254740993}]}');
  await assert.rejects(findSystem("A"), /Game ID/);
});

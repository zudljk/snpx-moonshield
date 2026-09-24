import assert from "node:assert/strict";
import { test } from "node:test";
import { extractSearchSystem } from "./moonshield.mjs";

const systemPage = `
  <title>Eafots SC-M d7-38 - star system | Elite:Dangerous | INARA</title>
  <h1 class="header">Star system</h1>
  <a href="/elite/starsystem/4804616/" class="quickmenu selected">Overview</a>
`;

test("reads the actual system name from a direct Inara system page", () => {
  assert.deepEqual(extractSearchSystem(systemPage, " eafots sc-m d7-38 "), {
    id: 4804616,
    name: "Eafots SC-M d7-38",
  });
});

test("selects an exact search result among multiple systems and duplicate links", () => {
  const html = `
    <a href="/elite/starsystem/1/">Other system</a>
    <a href="/elite/starsystem/2/"><span>Target &amp; Name</span></a>
    <a href="/elite/starsystem/2/">Target &amp; Name</a>
  `;
  assert.deepEqual(extractSearchSystem(html, "Target & Name"), {
    id: 2, name: "Target & Name",
  });
});

test("rejects navigation text if the page title is missing or identifies another system", () => {
  for (const html of [systemPage.replace(/<title>.*?<\/title>/, ""), systemPage]) {
    assert.throws(() => extractSearchSystem(html, "Unknown system"), /Could not unambiguously confirm/);
  }
});

test("rejects ambiguous system IDs even when the title matches", () => {
  assert.throws(() => extractSearchSystem(
    systemPage + '<a href="/elite/starsystem/123/">Other</a>', "Eafots SC-M d7-38",
  ), /Could not unambiguously confirm/);
});

test("rejects duplicate names belonging to different system IDs", () => {
  assert.throws(() => extractSearchSystem(`
    <a href="/elite/starsystem/1/">Target</a>
    <a href="/elite/starsystem/2/">Target</a>
  `, "Target"), /Could not unambiguously confirm/);
});

test("rejects a page without system links", () => {
  assert.throws(() => extractSearchSystem("<title>Not found</title>", "Target"), /Could not find/);
});

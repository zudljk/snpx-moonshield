import assert from "node:assert/strict";
import { test } from "node:test";
import { requestDeployment } from "./request-deployment.mjs";

test("optional publication hook makes no request unless configured", async () => {
  const message = await requestDeployment(undefined, () => { throw new Error("Unexpected network request"); });
  assert.match(message, /No deploy hook/);
});

test("deployment requests use HTTPS POST without following redirects", async () => {
  const result = await requestDeployment("https://example.test/build?token=secret", async (url, options) => {
    assert.equal(url.hostname, "example.test");
    assert.equal(options.method, "POST");
    assert.equal(options.redirect, "error");
    assert(options.signal instanceof AbortSignal);
    return new Response(null, { status: 202 });
  });
  assert.match(result, /accepted/);
  for (const hook of ["invalid", "http://example.test"]) await assert.rejects(requestDeployment(hook), /HTTPS/);
});

test("failed deployment requests fail the run without exposing the secret URL", async () => {
  await assert.rejects(requestDeployment("https://example.test/secret", async () => {
    throw new Error("network failure at https://example.test/secret");
  }), error => !error.message.includes("secret") && error.message.includes("rerun"));
  await assert.rejects(requestDeployment("https://example.test/secret", async () => new Response("secret", { status: 503 })), /HTTP 503/);
});

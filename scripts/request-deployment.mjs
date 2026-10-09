import { appendFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

export async function requestDeployment(hook, fetcher = fetch) {
  if (!hook) return "No deploy hook configured. Publication relies on the hosting provider's Git integration.";
  let url;
  try { url = new URL(hook); } catch { throw new Error("Deploy hook must be a valid HTTPS URL."); }
  if (url.protocol !== "https:") throw new Error("Deploy hook must be a valid HTTPS URL.");
  let response;
  try {
    response = await fetcher(url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000) });
  } catch {
    // Hook URLs may contain credentials; never include the URL or fetch exception.
    throw new Error("Deploy hook request failed. Check the hosting provider and rerun this workflow.");
  }
  if (!response.ok) throw new Error(`Deploy hook returned HTTP ${response.status}. Rerun the workflow to retry publication.`);
  return "Hosting provider accepted the deployment request. Check the provider for deployment completion.";
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const message = await requestDeployment(process.env.MOONSHIELD_DEPLOY_HOOK);
    console.log(message);
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${message}\n`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

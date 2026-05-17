#!/usr/bin/env node

import { readFile, readdir, writeFile, mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const carrierPath = path.join(projectRoot, "src/data/carrier.json");
const departuresPath = path.join(projectRoot, "src/data/departures.json");
const logDir = path.join(projectRoot, "src/content/log");
const activeStatuses = new Set(["scheduled", "boarding", "delayed"]);

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  const args = parseArgs(argv);

  if (!command || args.help) {
    printHelp();
    return;
  }

  if (command === "sync-position") {
    await syncPosition(args);
    return;
  }

  if (command === "schedule-jump") {
    await scheduleJump(args);
    return;
  }

  if (command === "commit") {
    await commitStatusUpdate(args);
    return;
  }

  if (command === "generate-log") {
    await generateLogEntry(args);
    return;
  }

  throw new Error(`Unknown command "${command}".`);
}

async function syncPosition(args) {
  const carrier = await readJson(carrierPath);
  if (!Number.isInteger(carrier.stationId)) {
    throw new Error("carrier.json must contain an integer stationId.");
  }

  const html = await fetchHtml(`https://inara.cz/elite/station/${carrier.stationId}/`);
  const system = extractStationSystem(html);
  const nextCarrier = {
    ...carrier,
    currentSystem: system.name,
    currentSystemId: system.id,
    status: typeof args.status === "string" ? args.status : carrier.status,
    locationNote:
      typeof args["location-note"] === "string"
        ? args["location-note"]
        : `Holding position at ${system.name}.`,
    lastPositionSyncAt: new Date().toISOString(),
  };

  if (!args["dry-run"]) await writeJson(carrierPath, nextCarrier);
  console.log(
    [
      `${args["dry-run"] ? "Would update" : "Updated"} ${carrier.name}:`,
      `${carrier.currentSystem} -> ${nextCarrier.currentSystem}`,
      `(Inara system ${nextCarrier.currentSystemId})`,
    ].join(" "),
  );
}

async function scheduleJump(args) {
  const title = requireString(args.title, "--title");
  const destination = requireString(args.destination, "--destination");
  const departureTime = normaliseIsoDate(requireString(args.departure, "--departure"));
  const notes = typeof args.notes === "string" ? args.notes : "";

  const [carrier, departures, destinationHtml] = await Promise.all([
    readJson(carrierPath),
    readJson(departuresPath),
    fetchHtml(
      `https://inara.cz/elite/starsystem/?search=${encodeURIComponent(destination)}`,
    ),
  ]);

  if (!carrier.currentSystem || !Number.isInteger(carrier.currentSystemId)) {
    throw new Error("carrier.json must contain currentSystem and integer currentSystemId.");
  }
  if (!Array.isArray(departures)) {
    throw new Error("departures.json must contain an array.");
  }

  const destinationSystem = extractSearchSystem(destinationHtml, destination);
  const boardingDeadline = new Date(new Date(departureTime).getTime() - 10 * 60_000).toISOString();
  const updatedDepartures = departures.map((departure) => ({ ...departure }));
  const previousActive = [...updatedDepartures]
    .filter((departure) => activeStatuses.has(departure.status))
    .sort((left, right) => Date.parse(right.departureTime) - Date.parse(left.departureTime))[0];

  if (previousActive) previousActive.status = "completed";

  updatedDepartures.push({
    title,
    originSystem: carrier.currentSystem,
    originSystemId: carrier.currentSystemId,
    destinationSystem: destinationSystem.name,
    destinationSystemId: destinationSystem.id,
    departureTime,
    boardingDeadline,
    status: "boarding",
    notes,
  });

  if (!args["dry-run"]) await writeJson(departuresPath, updatedDepartures);

  console.log(`${args["dry-run"] ? "Would schedule" : "Scheduled"}: ${title}`);
  console.log(`${carrier.currentSystem} -> ${destinationSystem.name}`);
  console.log(`Departure: ${departureTime}`);
  console.log(`Boarding closes: ${boardingDeadline}`);
  if (previousActive) console.log(`Previous departure marked completed: ${previousActive.title}`);
}

async function commitStatusUpdate(args) {
  const message = `Carrier status update ${formatLocalMinute(new Date())}`;
  const commands = [
    ["add", "src/data/carrier.json", "src/data/departures.json", "src/content/log/*.md"],
    ["commit", "-m", message],
    ["push"],
  ];

  if (args["dry-run"]) {
    console.log("Would run:");
    for (const command of commands) console.log(`git ${quoteArgs(command)}`);
    return;
  }

  for (const command of commands) {
    await runGit(command);
  }
}

async function generateLogEntry(args) {
  const topic = requireString(args.topic, "--topic");
  const gameDate = typeof args.date === "string" ? normaliseGameDate(args.date) : currentGameDate();
  const requestedTitle = typeof args.title === "string" ? args.title : null;
  const existingLogs = await readRecentLogs(4);
  const generated = await requestGeneratedLog({
    topic,
    gameDate,
    requestedTitle,
    existingLogs,
  });

  const title = requestedTitle ?? requireString(generated.title, "generated title");
  const summary = requireString(generated.summary, "generated summary");
  const body = requireString(generated.body, "generated body");
  const tags = Array.isArray(generated.tags)
    ? generated.tags.filter((tag) => typeof tag === "string" && tag.length > 0)
    : [];
  const slug = `${gameDate}-${titleToSlug(title)}`;
  const filePath = path.join(logDir, `${slug}.md`);
  const markdown = renderLogMarkdown({
    title,
    gameDate,
    summary,
    tags,
    body,
  });

  if (args["dry-run"]) {
    console.log(`Would write src/content/log/${slug}.md`);
    console.log("");
    console.log(markdown);
    return;
  }

  await writeFile(filePath, markdown);
  console.log(`Created src/content/log/${slug}.md`);
}

function extractStationSystem(html) {
  const systems = extractSystemLinks(html);
  if (systems.length === 0) {
    throw new Error("Could not find a star-system link on the station page.");
  }
  return systems[0];
}

function extractSearchSystem(html, requestedName) {
  const systems = extractSystemLinks(html);
  if (systems.length === 0) {
    throw new Error("Could not find a star-system link on the system search page.");
  }

  const exactMatches = dedupeSystems(
    systems.filter((system) => system.name.toLowerCase() === requestedName.toLowerCase()),
  );
  if (exactMatches.length === 1) return exactMatches[0];

  const uniqueSystems = dedupeSystems(systems);
  if (uniqueSystems.length === 1) return uniqueSystems[0];

  throw new Error(
    `Ambiguous star-system result for "${requestedName}": ${uniqueSystems
      .map((system) => `${system.name} (${system.id})`)
      .join(", ")}.`,
  );
}

function extractSystemLinks(html) {
  return [...html.matchAll(/<a\b[^>]*href=["']\/(?:elite\/)?starsystem\/(\d+)\/?["'][^>]*>([\s\S]*?)<\/a>/gi)]
    .map((match) => ({
      id: Number(match[1]),
      name: decodeHtml(stripTags(match[2])).trim(),
    }))
    .filter((match) => Number.isInteger(match.id) && match.name);
}

function dedupeSystems(systems) {
  const seen = new Map();
  for (const system of systems) seen.set(`${system.id}:${system.name}`, system);
  return [...seen.values()];
}

function stripTags(value) {
  return value.replace(/<[^>]*>/g, "");
}

function decodeHtml(value) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#039;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

async function fetchHtml(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "moonshield-jump-control/0.1 (+https://inara.cz/)",
    },
  });
  if (!response.ok) {
    throw new Error(`Request failed for ${url}: ${response.status} ${response.statusText}`);
  }
  return response.text();
}

async function requestGeneratedLog({ topic, gameDate, requestedTitle, existingLogs }) {
  const tempDir = await mkdtemp(path.join(tmpdir(), "moonshield-log-"));
  const schemaPath = path.join(tempDir, "schema.json");
  const outputPath = path.join(tempDir, "response.json");

  try {
    await writeFile(schemaPath, JSON.stringify(logOutputSchema, null, 2));
    await runCodexExec({
      prompt: buildLogPrompt({ topic, gameDate, requestedTitle, existingLogs }),
      schemaPath,
      outputPath,
    });
    return JSON.parse(await readFile(outputPath, "utf8"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function buildLogPrompt({ topic, gameDate, requestedTitle, existingLogs }) {
  return `You write captain's log entries for the fleet carrier [SNPX] Moonshield in a restrained, literary command-log voice.

Create one new entry for in-game date ${gameDate}.
Topic: ${topic}
${requestedTitle ? `Use this exact title: ${requestedTitle}` : "Infer a concise title from the topic."}

Return JSON only with this shape:
{
  "title": "string",
  "summary": "single sentence",
  "tags": ["lowercase-tag"],
  "body": "three short Markdown paragraphs"
}

Style references:
${existingLogs.join("\n\n---\n\n")}

Constraints:
- Keep the prose in-universe.
- Keep the body concise: about 110 to 170 words.
- Do not include frontmatter.
- Prefer 2 to 4 tags.
- If a title was provided, return that exact title.`;
}

async function readRecentLogs(limit) {
  const files = (await readdir(logDir))
    .filter((file) => file.endsWith(".md"))
    .sort()
    .slice(-limit);
  return Promise.all(files.map((file) => readFile(path.join(logDir, file), "utf8")));
}

const logOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "summary", "tags", "body"],
  properties: {
    title: { type: "string" },
    summary: { type: "string" },
    tags: {
      type: "array",
      items: { type: "string" },
    },
    body: { type: "string" },
  },
};

function renderLogMarkdown({ title, gameDate, summary, tags, body }) {
  return `---
title: ${JSON.stringify(title)}
pubDate: ${gameDate}T12:00:00Z
summary: ${JSON.stringify(summary)}
${tags.length > 0 ? `tags:\n${tags.map((tag) => `  - ${tag}`).join("\n")}` : "tags: []"}
---

${body.trim()}
`;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function normaliseIsoDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid ISO date for --departure: "${value}".`);
  }
  return date.toISOString();
}

function normaliseGameDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new Error(`Invalid game date for --date: "${value}". Use YYYY-MM-DD.`);
  }
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`Invalid game date for --date: "${value}".`);
  }
  return value;
}

function currentGameDate() {
  const today = new Date();
  const gameYear = today.getFullYear() + 1288;
  const month = String(today.getMonth() + 1).padStart(2, "0");
  const day = String(today.getDate()).padStart(2, "0");
  return `${gameYear}-${month}-${day}`;
}

function requireString(value, flag) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing required option ${flag}.`);
  }
  return value;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument "${token}".`);

    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }

    args[key] = next;
    index += 1;
  }
  return args;
}

function printHelp() {
  console.log(`Moonshield jump control

Usage:
  npm run carrier -- sync-position [--status <text>] [--location-note <text>] [--dry-run]
  npm run carrier -- schedule-jump --title <title> --destination <system> --departure <iso-date> [--notes <text>] [--dry-run]
  npm run carrier -- commit [--dry-run]
  npm run carrier -- generate-log --topic <text> [--date <yyyy-mm-dd>] [--title <text>] [--dry-run]
`);
}

function formatLocalMinute(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

function quoteArgs(args) {
  return args
    .map((arg) => (/[\s"]/u.test(arg) ? JSON.stringify(arg) : arg))
    .join(" ");
}

function titleToSlug(value) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

async function runGit(args) {
  await new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: projectRoot,
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`git ${args[0]} failed with exit code ${code}.`));
    });
  });
}

async function runCodexExec({ prompt, schemaPath, outputPath }) {
  await new Promise((resolve, reject) => {
    const child = spawn(
      "codex",
      [
        "--ask-for-approval",
        "never",
        "exec",
        "--ephemeral",
        "--sandbox",
        "read-only",
        "--output-schema",
        schemaPath,
        "--output-last-message",
        outputPath,
        "-",
      ],
      {
        cwd: projectRoot,
        stdio: ["pipe", "inherit", "inherit"],
      },
    );

    child.stdin.end(prompt);
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`codex exec failed with exit code ${code}.`));
    });
  });
}

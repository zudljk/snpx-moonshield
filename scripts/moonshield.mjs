#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import path from "node:path";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const carrierPath = path.join(projectRoot, "src/data/carrier.json");
const departuresPath = path.join(projectRoot, "src/data/departures.json");
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
    ["add", "src/data/carrier.json", "src/data/departures.json"],
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

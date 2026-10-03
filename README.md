# [SNPX] Moonshield

Static Astro website for an in-universe Fleet Carrier portal inspired by Elite: Dangerous. The project uses Astro with TypeScript, Content Collections for Markdown-driven content and JSON files for structured operational data.

## Installation

```bash
npm install
```

## Local development

```bash
npm run dev
```

## Build preview

```bash
npm run build
npm run preview
```

## Content maintenance

- Crew profiles live in `src/content/crew/` as Markdown files with validated frontmatter.
- Captain's Log entries live in `src/content/log/`.
- Announcements live in `src/content/announcements/`.
- Carrier metadata lives in `src/data/carrier.json`.
- Service availability lives in `src/data/services.json`.
- Planned jumps and boarding windows live in `src/data/departures.json`.
- A departure’s optional `itinerary` is a Spansh job UUID. The corresponding result is stored in `src/data/itinerary/<uuid>.json`. Builds use only these local files. The page displays `name`, `distance`, `distance_to_destination` and `fuel_used` from `result.jumps`, with a copy button for each system name.

## Game identifiers and Inara links

Moonshield uses Elite's game identifiers, not Inara database IDs:

- `carrierId` is the Journal `CarrierID` / `MarketID` as a decimal string (`"3706829824"` for Moonshield). `callsign` remains `"HHY-NTG"` for display and carrier links.
- `currentSystemAddress`, `originSystemAddress` and `destinationSystemAddress` hold Journal `SystemAddress` / Spansh `id64` values as decimal strings. Names remain available for display. An unresolved address is omitted, never replaced with an Inara ID.
- Spansh route entries retain their supplied `id64` values and types, including numeric IDs. Conversion to decimal strings happens only when deriving Moonshield-owned identifiers; importing a route does not rewrite its IDs. Route occurrences remain distinct by their index; a system ID alone does not identify an occurrence.
- If body tracking is added, a body must be identified by both its system address and its system-local `BodyID`.

Inara links use its [documented search URLs](https://inara.cz/elite/inara-api-devguide/): `starsystem/?search=<SystemAddress>` (or a URL-encoded system name when the address is missing) and `station/?search=<callsign>`. No Inara-ID mapping is required. The old `stationId`, `currentSystemId`, `originSystemId` and `destinationSystemId` fields have been removed.

The initial migration takes the carrier ID from the supplied Journal and the current system and active departure addresses from the saved Spansh route. The older completed departure has no locally verified addresses and uses name-based links. Existing route progress and position timestamps are preserved.

`sync-position` still reads the current system name from Inara. It reuses a known address only if the system name is unchanged; otherwise it resolves an exact name match through Spansh. If resolution fails, it updates the name, clears the previous address and reports a warning. `schedule-jump` resolves its destination and any missing origin address through Spansh; failed or ambiguous lookups leave departures unchanged. When deriving Moonshield-owned identifiers, numeric IDs outside JavaScript's safe integer range are rejected; large IDs must arrive as decimal strings to avoid silently storing rounded values.

## Jump control CLI

The repository includes a small operational CLI for keeping carrier movement data current.

```bash
# Refresh carrier.json from Inara using the carrier callsign.
# If omitted, locationNote becomes "Holding position at <currentSystem>."
# If omitted, status keeps its current value.
npm run carrier -- sync-position \
  --status "Refueling" \
  --location-note "Holding position in orbit around Colonia."

# Add the next departure and mark the previous active one as completed.
npm run carrier -- schedule-jump \
  --title "Return to HIP 117029" \
  --destination "Colonia" \
  --departure "3312-04-26T09:00:00Z" \
  --notes "Please ensure your ship is ready for departure."

# Stage carrier/departure data, commit it and push it.
npm run carrier -- commit

# Generate a new captain's log entry through the Codex CLI.
# If omitted, --date defaults to today's real date shifted +1288 years.
# If omitted, --title is inferred from the topic.
npm run carrier -- generate-log \
  --topic "Arriving at HIP 117029 and preparing to support Stella Nebula Project"
```

Use `--dry-run` with any command to preview the change without writing files or running Git.

Add `--capacity-used 5208` to `schedule-jump` to calculate an itinerary automatically. The CLI resolves the current carrier system and destination through exact Spansh name matches, submits a fleet carrier route with `capacity=25000`, `mass=25000` and `calculate_starting_fuel=1`, then polls every two seconds for up to two minutes. `--capacity-used` accepts integers from 0 to 25000, including 0.

Alternatively, `--itinerary "<UUID>"` imports an existing Spansh job before it expires. These two options are mutually exclusive. Both save the result in `src/data/itinerary/<uuid>.json` before updating departures; the `commit` command includes these files. If Spansh lookup or calculation fails, departure data stays unchanged. With neither option, no itinerary is attached. `scheduled-jump` is an alias.

`--dry-run` previews the operation without submitting a Spansh calculation, downloading a route, or writing files. Spansh system-address lookups still run.

```bash
npm run carrier -- schedule-jump \
  --title "Formidine Rift expedition" \
  --destination "Eafots SC-M d7-38" \
  --departure "3312-09-21T15:30:00Z" \
  --capacity-used 5208
```

## Itinerary progress

`sync-position` updates only the itinerary of the latest active departure (`scheduled`, `boarding` or `delayed`). Completed and cancelled departures are untouched. Systems are compared by game address when both sides provide one (Spansh numeric `id64` and Moonshield string addresses are supported); otherwise comparison uses trimmed, case-insensitive names. Spansh IDs are never rewritten.

The carrier stores the last confirmed location in `currentSystem` / `currentSystemAddress`, the preceding distinct location in `previousSystem` / `previousSystemAddress`, and the latest observation's `eventId`, `observedAt` and `source` in `lastPositionObservation`. The shared observation handler rejects the latest event ID again and observations with an older or equal timestamp before changing either location or route progress. Repeated observations of the same system do not imply a jump.

Each route stores its zero-based cursor in `moonshieldProgress.currentIndex`, plus `status` (`confirmed` or `uncertain`) and an optional explanatory `message`. Existing routes migrate from their single `current` marker on the next sync. A route without a cursor needs an unambiguous previous location to establish its starting position; a repeated system alone is insufficient.

For each movement, the next leg relative to the cursor has priority. Otherwise, only a unique consecutive pair matching the previous and new systems in the remaining route can advance the cursor. Missing intermediate observations, multiple matching pairs or off-route movements preserve the cursor and visit flags and record an uncertainty message. The actual carrier location is still updated. An unchanged location does not clear an outstanding uncertainty. A later unambiguous movement can recover progress.

Only observed endpoints are newly marked `visited`. Earlier unconfirmed stops receive `skipped: true` and appear as **Not observed**, not as visited. Previously recorded visits are preserved. The itinerary page displays uncertainty and labels the highlighted stop **Last confirmed position** when the carrier's route position is unresolved. Run a build and deploy to publish updates. `sync-position --dry-run` previews changes without writing carrier or itinerary data.

The current Inara polling source uses the request start time and a generated observation ID: Inara does not supply a Journal event timestamp here. Consequently, the ordering guard cannot detect an outdated location on Inara itself. The observation handler is ready for source timestamps and stable event IDs from a future Journal integration. Likewise, an unobserved round trip returning to the same system cannot be inferred from equal endpoints. Historical `visited` flags are retained and are not retroactively verified.

## EDMC plugin

`edmc/Moonshield/` contains the Python plugin for receiving carrier location events on the gaming PC and dispatching them to GitHub. It includes a durable local queue, retry handling and EDMC settings. Build an installable ZIP with `python3 scripts/package-edmc.py`; the result is `artifacts/Moonshield-EDMC.zip`. No project checkout is needed on the gaming PC.

See the [plugin installation guide and event contract](edmc/Moonshield/README.md). Delivery is disabled initially: the receiving GitHub Actions workflow and deployment are the next step, not part of the plugin. Run its tests with `python3 -m unittest discover -s tests/edmc -v`.

## Planned improvements

- Investigate a future FCOC Discord publishing workflow for passenger trips. The inactive Fleet Carrier Management System accepted events from an EDMC plugin and forwarded carrier updates to a special Fleet Carrier Owner's Club channel. FCOC still appears to have the webhook path available for commanders who apply for the required role, which creates a carrier-specific channel. If Moonshield later supports longer passenger routes, review the FCMS source code on GitHub and consider adapting the relevant EDMC/plugin-to-webhook pieces with FCOC admin approval.

## Notes

- The site is fully static and uses no backend, database or authentication. The CLI fetches itinerary data from Spansh and saves it locally; builds and visitors do not contact Spansh.
- This is a fan-made project inspired by Elite: Dangerous and is not affiliated with Frontier Developments.

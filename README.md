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

## Jump control CLI

The repository includes a small operational CLI for keeping carrier movement data current.

```bash
# Refresh carrier.json from the configured Inara station page.
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

`--dry-run` previews the operation without submitting a Spansh calculation, downloading a route, or writing files. The Inara destination lookup still runs.

```bash
npm run carrier -- schedule-jump \
  --title "Formidine Rift expedition" \
  --destination "Eafots SC-M d7-38" \
  --departure "3312-09-21T15:30:00Z" \
  --capacity-used 5208
```

## Planned improvements

- Investigate a future FCOC Discord publishing workflow for passenger trips. The inactive Fleet Carrier Management System accepted events from an EDMC plugin and forwarded carrier updates to a special Fleet Carrier Owner's Club channel. FCOC still appears to have the webhook path available for commanders who apply for the required role, which creates a carrier-specific channel. If Moonshield later supports longer passenger routes, review the FCMS source code on GitHub and consider adapting the relevant EDMC/plugin-to-webhook pieces with FCOC admin approval.

## Notes

- The site is fully static and uses no backend, database or authentication. The CLI fetches itinerary data from Spansh and saves it locally; builds and visitors do not contact Spansh.
- This is a fan-made project inspired by Elite: Dangerous and is not affiliated with Frontier Developments.

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
```

Use `--dry-run` with any command to preview the change without writing files or running Git.

## Notes

- The site is fully static and uses no backend, database, authentication or external APIs.
- This is a fan-made project inspired by Elite: Dangerous and is not affiliated with Frontier Developments.

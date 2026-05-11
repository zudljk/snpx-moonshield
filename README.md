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

## Notes

- The site is fully static and uses no backend, database, authentication or external APIs.
- This is a fan-made project inspired by Elite: Dangerous and is not affiliated with Frontier Developments.

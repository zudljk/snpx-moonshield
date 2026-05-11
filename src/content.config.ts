import { glob } from "astro/loaders";
import { defineCollection, z } from "astro:content";

const crew = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/crew" }),
  schema: z.object({
    name: z.string(),
    role: z.string(),
    origin: z.string(),
    summary: z.string(),
    order: z.number().int().nonnegative()
  })
});

const log = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/log" }),
  schema: z.object({
    title: z.string(),
    pubDate: z.coerce.date(),
    summary: z.string(),
    tags: z.array(z.string()).default([])
  })
});

const announcements = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/announcements" }),
  schema: z.object({
    title: z.string(),
    pubDate: z.coerce.date(),
    priority: z.enum(["low", "normal", "high", "critical"]),
    expires: z.coerce.date(),
    summary: z.string()
  })
});

export const collections = {
  crew,
  log,
  announcements
};

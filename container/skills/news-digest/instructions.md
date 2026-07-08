# News Digest — Full Pipeline

## Overview

This skill produces and delivers a news digest (e.g. an AI/tech briefing) when the
scheduler wakes you. The heavy lifting of fetching feeds happens outside your turn:
a scheduled pre-task script (`/workspace/agent/digests/fetch.mjs <id>`) pulls RSS/Atom
sources, deduplicates against previously delivered items, and writes fresh items to a
`pending.json` file. Your job is the part that needs judgment — reading those pending
items, running any web searches, synthesizing a tight briefing that matches the feed's
editorial config, delivering it to the configured channel, and committing the
seen-state so nothing gets delivered twice.

You are invoked with a prompt like *"A news digest is ready… produce the ai-daily
digest."* The `<id>` (e.g. `ai-daily`) tells you which feed to process.

## Pipeline

Run these steps in order.

### 1. Read the feed config

Read `/workspace/agent/digests/config.json`. It contains a `digests` array; find the
object whose `id` matches the digest you were asked to produce. Key fields you will
use:

- `title` — the digest name.
- `focus` — editorial guidance: what to prioritize and what to skip.
- `tone` — the voice to write in.
- `length` — target size and structure (e.g. "8–12 bullets, then a Worth reading list").
- `sources` — includes any `search`-type sources you must run yourself (see step 3).
- `deliverTo` — the destination name to send the finished digest to.

### 2. Read the pending items

Read `/workspace/agent/digests/state/<id>.pending.json`. It contains:

- `items` — an array of `{ title, link, published, description, source, hash }`
  already deduplicated and capped to `maxItems`. These are the fresh RSS/Atom results.
- `searches` — an array of `{ query }` search sources copied from config.
- `urls` — any `url`-type sources to fetch directly (usually empty).

If the file is missing or `items` is empty **and** there are no `searches`, skip to
the error-handling section below.

### 3. Run the search sources

For each entry in the config's `sources` (or the pending file's `searches`) with
`type: "search"`, run its `query` through **WebSearch**. Pull out the genuinely new,
substantive results — new model releases, benchmarks, framework/tooling updates,
notable papers. Treat these as additional candidate items alongside the RSS items.
Discard obvious duplicates of what's already in `items`.

### 4. Synthesize the briefing

Combine the RSS items and search results into one briefing. Apply the feed's `focus`
to decide what makes the cut and what gets dropped, `tone` for voice, and `length`
for size and structure. Lead with the single most important item. Merge multiple
sources covering the same story into one bullet. Cut hype, contentless funding news,
and repetitive takes.

Internal synthesis frame to use:

> You are writing a `<title>` for the reader described in `<focus>`. Here are today's
> candidate items (from RSS + web search): `<items + search results>`. Write the
> briefing in this voice: `<tone>`. Target: `<length>`. Every bullet must earn its
> place — if it isn't something the reader would act on or find technically
> interesting, drop it. End with a short "Worth reading" list of 2–3 links.

### 5. Format for the destination

The default destination is Telegram, which does **not** render markdown headers.
Format rules:

- **No** `#`/`##` headers. Open with a one-line intro sentence if useful.
- Use `**bold**` for each item headline.
- Use `•` for bullets.
- One item per bullet: bold headline, then 1–2 sentences of context, then the link.
- Keep lines readable; don't produce giant walls of text.
- End with a `**Worth reading**` line followed by 2–3 bare links (title + URL).

### 6. Deliver

Send the finished digest to the feed's `deliverTo` value using `send_message`
(e.g. `send_message({ to: "telegram-mg-17807", ... })`).

### 7. Commit seen-state

After a successful send, prevent re-delivery:

1. Read `/workspace/agent/digests/state/<id>.seen.json` (shape: `{ "seen": [...] }`,
   a list of item hashes).
2. Append the `hash` of every item you actually included/delivered (the pending items
   carry a `hash` field; for search results you can hash the link the same way or just
   record the RSS hashes — the fetcher dedupes RSS, which is where repeats come from).
3. Write the file back.
4. Delete `/workspace/agent/digests/state/<id>.pending.json`.

Keep the seen list from growing unbounded — it's fine to trim it to, say, the most
recent few thousand hashes if it gets large.

## Error handling

- **Pending file missing or empty and no searches configured:** send a brief message
  to `deliverTo` — e.g. *"Nothing new for the AI daily brief today."* — then delete
  the pending file if present. Do not fabricate items.
- **All searches return nothing new and no RSS items:** same as above.
- **A search or fetch fails mid-run:** proceed with whatever you have; a partial
  digest beats no digest. Note nothing to the user unless everything failed.
- **Never** invent headlines, links, or dates. Every link must come from a real
  pending item or a real search result.

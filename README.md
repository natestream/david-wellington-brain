# David Wellington Brain

A free, cloud-hosted second brain for door-to-door window cleaning, used from the Claude app on a phone.

After each door, David tells Claude what happened, gets coaching right away, and the door is saved. At the end of the day he drops in his CRM PDF and his KPIs are saved as one clean row. Everything is reachable from any device signed in to his Claude account.

## Core principle: Claude thinks, the server stores

All synthesis happens in Claude: coaching, reading PDFs, extracting fields, summarizing. This server is a thin MCP layer that **stores, searches and counts**. The only AI call on the server is embeddings.

If a feature needs "intelligence", put it in the tool description so Claude does it before or after calling the tool, not in the server.

## Stack (Cloudflare free tier, no card)

| Piece | Service | Free tier |
|---|---|---|
| MCP server | Workers | 100k requests/day |
| Structured data | D1 | 5 GB, 100k rows written/day |
| Semantic search | Vectorize | 30M queried dimensions/month |
| Embeddings | Workers AI (`@cf/baai/bge-base-en-v1.5`, 768 dims) | 10k neurons/day |

## Data model

- **`doors`**: one row per door: outcome, objection type and text, response, amount, notes, coaching. This is the objections table.
- **`daily_kpis`**: one row per rep per day (`UNIQUE(rep, date)`): doors, contacts, pitches, quotes, closes, revenue, hours. Rates are calculated when read, never stored.
- **`notes`**: general second-brain content (replaces his local Obsidian vault).

Full column list: issue #3. KPI columns are placeholders until the CRM PDF fields are confirmed (#12).

## MCP tools

| Tool | What it does | Issue |
|---|---|---|
| `log_door` | Save a door, return similar past doors so Claude can coach from his history | #4 |
| `save_daily_kpis` | Upsert one day's CRM numbers, compare with doors logged that day | #5 |
| `get_kpis` | Totals and rates for a day or range | #6 |
| `objection_stats` | Top objections and which responses closed | #7 |
| `save_note` / `ask_brain` | General notes + semantic search across everything | #8 |

## Build order

1. **#2: Scaffold.** Worker, `/mcp` endpoint, `wrangler.jsonc` bindings (`DB`, `VECTORS`, `AI`), header auth.
2. **#3: Schema.** `migrations/0001_init.sql`.
3. **#4 → #8: Tools.** In that order. `log_door` first; it's the daily-use tool.
4. **#9: Import.** One-time load of his markdown files + backfill of this week's doors.
5. **#10: Deploy button + setup guide.**
6. **#11: Testing.** Full end-to-end on Nate's account before the demo.

Blocked on David: **#12** (CRM name, sample PDF, categories, reps, Claude plan).

## Suggested layout

```
src/
  index.ts          # Worker entry: auth check, route /mcp
  mcp.ts            # MCP server + tool registration
  tools/
    doors.ts        # log_door, objection_stats
    kpis.ts         # save_daily_kpis, get_kpis
    notes.ts        # save_note, ask_brain
  lib/
    embed.ts        # Workers AI embedding helper
    vectors.ts      # Vectorize upsert/query + D1 hydration
    dates.ts        # today() in America/Los_Angeles
migrations/
  0001_init.sql
scripts/
  import.ts         # one-time markdown import
wrangler.jsonc
```

## Conventions

- **Auth:** require the `x-brain-key` header matching the `BRAIN_KEY` secret. Return HTTP 401 otherwise. Never accept the key as a query param.
- **Dates:** `YYYY-MM-DD` in America/Los_Angeles. Default to today.
- **IDs:** `crypto.randomUUID()`.
- **Rep:** every row has `rep`, default `david`, so his sales team can join later without a migration.
- **No PDF storage:** extract the numbers, discard the file.
- **Tool descriptions are the product.** Write them for Claude: when to call the tool, what to extract first, and to keep coaching short (he's walking to the next door).
- **Stay in the free tier:** one embedding per write, one per search. No server-side LLM calls.

## Local development

```bash
npm install
npx wrangler d1 create david-brain            # first time only; paste the id into wrangler.jsonc
npx wrangler vectorize create david-brain-notes --dimensions=768 --metric=cosine
npx wrangler d1 migrations apply david-brain --local
echo 'BRAIN_KEY=dev-key' > .dev.vars
npx wrangler dev
```

Vectorize and Workers AI don't fully run locally; use remote bindings for them while testing.

Inspect the tools:

```bash
npx @modelcontextprotocol/inspector
# URL: http://localhost:8787/mcp   Header: x-brain-key: dev-key
```

## Deploy

```bash
npx wrangler d1 migrations apply david-brain --remote
npx wrangler secret put BRAIN_KEY
npx wrangler deploy
```

Then in Claude: **Settings → Connectors → Add custom connector**: URL `https://<worker>.workers.dev/mcp`, request header `x-brain-key: <BRAIN_KEY>`.

Claude Free allows one custom connector.

## Setup for David (Saturday)

<!-- Add the Deploy to Cloudflare button here once #10 is done (repo must be public). -->

1. Sign up at cloudflare.com (free, no card).
2. Click **Deploy to Cloudflare** (coming in #10).
3. Set the `BRAIN_KEY` secret in the Worker's settings.
4. Add the custom connector in Claude (see Deploy above).
5. Test: *"Log a door: no answer on Main St."*

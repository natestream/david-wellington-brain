# David Wellington Brain

A free, cloud-hosted second brain for door-to-door window cleaning, used from the Claude app on a phone.

After each door, David tells Claude what happened, gets coaching right away, and the door is saved. At the end of the day he drops in his CRM PDF and his KPIs are saved as one clean row. Everything is reachable from any device signed in to his Claude account.

## Setup for David (Saturday)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/natestream/david-wellington-brain)

1. Sign up at cloudflare.com (free, no card).
2. Click **Deploy to Cloudflare** above. It should create the Worker and the D1 database on his account and run the migration (`npm run deploy`). Verify this on Nate's account first (#11); the Cloudflare docs weren't reachable while this was built.
3. When it asks for `BRAIN_KEY`, paste a long random string (e.g. from `openssl rand -hex 32`). Save it in his password manager.
4. In Claude: **Settings → Connectors → Add custom connector**. URL `https://<worker>.workers.dev/mcp`, request header `x-brain-key: <BRAIN_KEY>`.
5. Test: *"Log a door: no answer on Main St."*

Claude Free allows one custom connector, so this has to be his one.

If the button doesn't create the Vectorize index (check **Storage & Databases → Vectorize** for `david-brain-notes`), run `npm run setup:vectorize` once from a laptop logged in to his account. It must be 768 dimensions, cosine.

The button needs this repo to be **public**. No secrets live in the code; `BRAIN_KEY` is only set on Cloudflare.

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

Budget check: a door is roughly 50 tokens to embed, so a 60-door day is about 20 neurons out of 10,000.

## Data model

`migrations/0001_init.sql`:

- **`doors`**: one row per door: `outcome`, `objection_type`, `objection_text`, `response`, `amount`, `area`, `notes`, `coaching`. This is the objections table.
- **`daily_kpis`**: one row per rep per day (`UNIQUE(rep, date)`): `doors_knocked`, `contacts`, `pitches`, `quotes`, `closes`, `revenue`, `hours`, plus `source`, `raw_summary` and `extra` (JSON for any other PDF numbers). Rates are calculated when read, never stored.
- **`notes`**: general second-brain content (replaces his local Obsidian vault). `tags` is a JSON array.

Every row has `rep` (default `david`), so his sales team can join later without a migration.

Vector IDs carry their kind (`door:<id>`, `note:<id>#<chunk>`), so search needs no Vectorize metadata index and no extra setup.

## MCP tools

| Tool | What it does | Issue |
|---|---|---|
| `log_door` | Save a door, return the 5 most similar past doors + history for that objection so Claude can coach from his own record | #4 |
| `save_daily_kpis` | Upsert one day's CRM numbers, compare with the doors logged that day ("CRM says 62 doors, 18 logged") | #5 |
| `get_kpis` | Totals and rates for a day or range, by day, Monday-start week, or none | #6 |
| `objection_stats` | Per objection: count, closes, close rate, and the 3 latest responses that closed | #7 |
| `save_note` / `ask_brain` | General notes + semantic search across notes and doors | #8 |

Rates: contact rate = contacts / doors, close rate = closes / pitches, revenue per door, avg ticket = revenue / closes, revenue per hour. A rate is `null` when its denominator is 0 or missing.

The tool descriptions in `src/tools/*.ts` are the product. They tell Claude when to call each tool, what to extract first, and to keep coaching short.

If an embedding fails (e.g. Workers AI quota), `log_door` and `save_note` still save the row and return a warning, so Claude never retries and duplicates it.

## When David's CRM answers come in (#12)

The KPI columns are placeholders. To change them:

1. Edit `KPI_FIELDS` in `src/tools/kpis.ts`. The tool schema, the SQL and the totals all read from it.
2. Add `migrations/0002_kpi_fields.sql` with `ALTER TABLE daily_kpis ADD COLUMN ...`.
3. Update `computeRates()` if a rate uses a renamed field, and the expected numbers in `test/kpis.test.ts`.

Until then, Claude puts any other PDF numbers in `extra`, so nothing is lost. If the CRM has an API, a later version can pull the numbers directly with `source: "crm"`.

Outcome and objection categories live in `OUTCOMES` / `OBJECTION_TYPES` in `src/tools/doors.ts` and in the `CHECK` constraints in the migration; change both together.

## Layout

```
src/
  index.ts          # Worker entry: auth check, routes /mcp and /admin/import
  mcp.ts            # MCP server (stateless Streamable HTTP) + tool registration
  admin.ts          # POST /admin/import for the one-time markdown import
  tools/
    doors.ts        # log_door, objection_stats
    kpis.ts         # save_daily_kpis, get_kpis (KPI_FIELDS lives here)
    notes.ts        # save_note, ask_brain
  lib/
    auth.ts         # x-brain-key check (constant-time), 401
    embed.ts        # Workers AI embedding helper
    vectors.ts      # Vectorize upsert/query + D1 hydration
    chunk.ts        # note chunking for embeddings
    dates.ts        # today() in America/Los_Angeles
migrations/
  0001_init.sql
scripts/
  import.ts         # one-time markdown import
test/               # vitest: real SQLite for D1, fakes for Vectorize + Workers AI
wrangler.jsonc
```

## Conventions

- **Auth:** require the `x-brain-key` header matching the `BRAIN_KEY` secret. HTTP 401 otherwise. The key is never accepted as a query param.
- **Dates:** `YYYY-MM-DD` in America/Los_Angeles. Default to today.
- **IDs:** `crypto.randomUUID()`. Imported notes use an id derived from the file path so re-imports replace instead of duplicating.
- **No PDF storage:** extract the numbers, discard the file.
- **Stay in the free tier:** one embedding call per write, one per search. No server-side LLM calls.

## Local development

Needs Node 22.5+.

```bash
npm install
npm run check                 # typecheck + tests (no Cloudflare account needed)
```

The tests run the real SQL against SQLite (the engine D1 uses) and go through the Worker's real `fetch` and MCP transport. Vectorize and Workers AI are replaced with in-memory fakes.

To run the Worker itself:

```bash
npx wrangler login
npm run setup:vectorize       # first time only
npm run db:migrate:local
cp .dev.vars.example .dev.vars  # then set BRAIN_KEY=dev-key
npm run dev
```

`wrangler.jsonc` marks Vectorize and Workers AI as `remote: true` because they don't run locally, so `wrangler dev` needs a logged-in account.

Inspect the tools:

```bash
npx @modelcontextprotocol/inspector
# URL: http://localhost:8787/mcp   Header: x-brain-key: dev-key
```

## Deploy by hand (instead of the button)

```bash
npx wrangler login
npm run setup:vectorize       # first time only
npx wrangler secret put BRAIN_KEY
npm run deploy                # wrangler deploy, then D1 migrations --remote
```

`database_id` is left out of `wrangler.jsonc` on purpose: `wrangler deploy` creates the D1 database on whichever account deploys it.

## Importing his markdown files (#9)

```bash
npm run import -- ~/path/to/vault --dry-run                       # lists files + free-tier estimate
BRAIN_KEY=... npm run import -- ~/path/to/vault --url https://<worker>.workers.dev
```

One note per `.md` file (title = file name, tags = its folders, e.g. `raw`). Hidden folders like `.obsidian`, non-markdown files and empty files are skipped. Long files are split into ~1,500-character chunks, because the embedding model reads at most 512 tokens. Safe to re-run.

This week's doors (Wed/Thu, before setup): paste his notes into Claude and say *"log each of these doors with the right date"*. Claude calls `log_door` once per door.

## Testing before the demo (#11)

Covered by `npm test` (41 tests): auth/401, tool listing, every tool's SQL, upsert-not-duplicate, rates and divide-by-zero, week grouping, similar-door search, chunking, import idempotency, embedding failures.

Still to do on a real Cloudflare account (can't be done from CI):

- [ ] Deploy to Nate's free account (try the button) and confirm D1 + Vectorize (768, cosine) exist and the migration ran
- [ ] Connect as a custom connector, then on a phone: log 5 fake doors with mixed objections, upload a sample CRM PDF, re-upload the same day, run `objection_stats` + `get_kpis` for the week
- [ ] Bad header → 401 against the deployed URL
- [ ] Check Workers AI neuron usage after a simulated 60-door day
- [ ] Wipe the test data; do the fresh deploy on David's account Saturday

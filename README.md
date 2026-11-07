# David Wellington Brain

A free, cloud-hosted second brain for door-to-door window cleaning, used from the Claude app on a phone.

After each door, David tells Claude what happened, gets coaching right away, and the door is saved. At the end of the day he drops in his Rotor CRM pin export, adds his hours and ARR sold, and his 6 KPIs are saved as one clean row per rep. Everything is reachable from any device signed in to his Claude account.

## Deploys: one repo, every account (#16)

This repo is the only copy of the code. GitHub Actions deploys it to each Cloudflare account, so David needs no GitHub account, and every fix reaches him with one merge.

On every merge to `main` (or **Actions → Deploy → Run workflow**), `.github/workflows/deploy.yml` runs:

1. **check**: typecheck + tests. Nothing deploys if they fail.
2. **staging** (Nate's account): deploys, runs the full `npm run smoke` against it, then deletes the test data.
3. **production** (David's account, one job per entry in `PROD_TARGETS`): deploys, then a read-only health check (`--health`: 401s + tools list, writes nothing). Runs only if staging passed.

Each deploy (`scripts/ci-deploy.sh`) creates the D1 database and the Vectorize index (768, cosine) if they're missing, applies new migrations, then deploys the Worker with `BRAIN_KEY` set. So a first deploy on a fresh account needs no clicks in Cloudflare, and re-deploys never touch data. Keep migrations additive (new tables/columns): they apply just before the new code goes live.

Each target is a GitHub **Environment** (**Settings → Environments**) with 3 secrets:

| Secret | What |
|---|---|
| `CLOUDFLARE_API_TOKEN` | API token on that person's Cloudflare account (how to make one below) |
| `CLOUDFLARE_ACCOUNT_ID` | Their account ID (dashboard → **Workers & Pages**, right-hand side) |
| `BRAIN_KEY` | The key the Claude connector sends. Long random string (`openssl rand -hex 32`), different per account |

The repo variable `PROD_TARGETS` (**Settings → Secrets and variables → Actions → Variables**) lists the production Environments, e.g. `["david"]`. Unset = staging only. A new client later = a new Environment + one entry (the server instructions name David, so make those configurable first).

To approve David's deploys by hand, add yourself as a **Required reviewer** on the `david` Environment.

### API token (one per account)

In the account's Cloudflare dashboard: **My Profile → API Tokens → Create Token → "Edit Cloudflare Workers" template**, then add the account permissions **D1: Edit** and **Vectorize: Edit**, and set **Account Resources** to that account. Copy the token (it's shown once) straight into the GitHub secret. Not yet verified against a real account: if the first deploy fails with an auth error, the log names the missing permission.

### One-time: staging on Nate's account (before Saturday)

1. Create the `staging` Environment with the 3 secrets above (token from Nate's account).
2. **Actions → Deploy → Run workflow**. The staging job should pass, including the smoke test.
3. If the log warns about no workers.dev URL: open **Workers & Pages** in the dashboard once so the account gets a workers.dev subdomain, then run it again.

## Setup for David (Saturday)

1. He signs up at cloudflare.com (free, no card) and opens **Workers & Pages** once (sets up his workers.dev subdomain).
2. He creates the API token (above) while you watch, and reads you his account ID.
3. You create the `david` Environment with his token, account ID and a fresh `BRAIN_KEY` (save it in his password manager), and set `PROD_TARGETS` to `["david"]`.
4. **Actions → Deploy → Run workflow**. When the production job is green, its log shows his URL.
5. In Claude: **Settings → Connectors → Add custom connector**. URL `https://<worker>.<his-subdomain>.workers.dev/mcp`, request header `x-brain-key: <BRAIN_KEY>`.
6. Test: *"Log a door: no answer on Main St."*

David is on Claude Free, which allows one custom connector. He has none yet, so this one fits.

No secrets live in the code. `BRAIN_KEY` and the tokens only live in GitHub Environments and on Cloudflare. He can revoke the token anytime from his Cloudflare profile; the Worker keeps running, only new deploys stop.

The [Deploy to Cloudflare button](https://deploy.workers.cloudflare.com/?url=https://github.com/natestream/david-wellington-brain) still works for a one-off copy, but it copies the repo into the deployer's GitHub, and that copy doesn't get updates from here. If it asks for the Vectorize **dimensions**, enter `768`, metric `cosine`.

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

- **`doors`**: one row per door: `outcome` (Rotor's pin types: `gave_pitch`, `go_back`, `never_knock`, `door_hanger`, `no_answer`, `not_interested`, `made_sale`), `objection_type`, `objection_text`, `response`, `amount` (ARR for a sale), `area`, `notes`, `coaching`. This is the objections table.
- **`daily_kpis`**: one row per rep per day (`UNIQUE(rep, date)`) holding only the KPI inputs: the 8 counts from the Rotor pin export (`total`, `gave_pitch`, `go_back`, `never_knock`, `door_hanger`, `no_answer`, `not_interested`, `made_sale`) plus `hours_knocked` and `arr_sold` entered by the rep, and `source`, `raw_summary`, `extra`. Subtotals and KPIs are calculated when read, never stored.
- **`notes`**: general second-brain content (replaces his local Obsidian vault). `tags` is a JSON array.

Every row has `rep` (default `david`). v1 is David only; the column is there so teammates can be added in a later version without a migration.

Vector IDs carry their kind (`door:<id>`, `note:<id>#<chunk>`), so search needs no Vectorize metadata index and no extra setup.

## MCP tools

| Tool | What it does | Issue |
|---|---|---|
| `log_door` | Save a door, return the 5 most similar past doors + history for that objection so Claude can coach from his own record | #4 |
| `save_daily_kpis` | Upsert one rep's day from the Rotor pin export + hours and ARR, return the 6 KPIs, compare with doors logged ("Rotor says 61 pins, 18 doors logged") | #5 |
| `get_kpis` | The 6 KPIs for a day or range, per rep or the whole team, by day, Monday-start week, or none | #6 |
| `objection_stats` | Per objection: count, closes, close rate, and the 3 latest responses that closed | #7 |
| `save_note` / `ask_brain` | General notes + semantic search across notes and doors | #8 |

### KPIs (from David's "Wellington Sales KPI Calculations")

| Subtotal | Formula |
|---|---|
| Adjusted Doors | Total − Go Back − Never Knock − Door Hanger |
| Answered | Adjusted Doors − No Answer |
| Pitches | Gave Pitch + Made Sale |
| Plans Sold | Made Sale |

| KPI | Formula |
|---|---|
| Doors per Hour | Adjusted Doors ÷ Hours Knocked |
| Answer Rate | Answered ÷ Adjusted Doors |
| Backyard Rate | Pitches ÷ Answered |
| Conversion Rate | Plans Sold ÷ Pitches |
| Revenue per Hour (annualized) | ARR Sold ÷ Hours Knocked |
| Average ARR per Plan (annualized) | ARR Sold ÷ Plans Sold |

ARR is always one year of revenue, even when the agreement runs longer. All of this lives in `computeKpis()` in `src/tools/kpis.ts`. For a date range or the whole team, the inputs are added up first and the KPIs are calculated from the totals, never averaged. A KPI is `null` when its denominator is 0 or missing (for example before hours are entered).

Saving the same rep and day again updates the row, and fields left out keep their saved value. So the flow is: drop in the export (pins saved), Claude asks for hours and ARR, then those get added to the same row.

The tool descriptions in `src/tools/*.ts` are the product. They tell Claude when to call each tool, what to extract first, and to keep coaching short.

If an embedding fails (e.g. Workers AI quota), `log_door` and `save_note` still save the row and return a warning, so Claude never retries and duplicates it.

## CRM: Rotor (#12)

David uses [Rotor](https://getrotor.com/), a CRM for window cleaning and exterior cleaning businesses built around selling recurring service plans door to door.

**v1 (this build):** he drops in the Rotor **"New Pins by Team Member"** export (CSV, PDF or screenshot; columns: Team Member, Total, Gave Pitch, Go Back, Never Knock, Door Hanger, No Answer, Not Interested, Made Sale). Claude saves **David's row only** and ignores teammates' rows (teammates are out of scope for v1). It then asks for hours knocked and ARR sold, which aren't on the export.

### v2: Rotor sync (optional, off by default)

With a Rotor API key set, the brain pulls David's day from Rotor itself, so he doesn't have to drop in the export. Without the key, nothing changes and the export flow above still works.

**What it pulls** (from the [Rotor OpenAPI](https://docs.api.getrotor.com/), v1.1.0):

| KPI input | Rotor source |
|---|---|
| The 8 pin counts | `GET /pins`: his pins created that LA day, counted by `pin_type.label` (`"Go Back"` → `go_back`, and so on). Pin types not in the guide count toward Total only, with a warning. |
| `hours_knocked` | `GET /timesheets`: his timesheets in the `sales` category that started that day (`duration_minutes`). Office/service time isn't counted. |
| `arr_sold` | `GET /service-plans`: plans he sold that day (`sold_by`), not cancelled. `sale_value` is the whole contract, so ARR per plan = (`sale_value` ÷ jobs) × visits per year from `service_frequency`, capped at `sale_value`. One-Time = full value. A `Custom` frequency or a missing job count leaves ARR blank and Claude asks. |

**How it runs:**

- A **nightly cron** at 05:30 UTC (9:30 pm PST / 10:30 pm PDT) saves that day automatically.
- A **`sync_rotor_day`** tool pulls a day on demand ("sync my day", or before "how did I do?"). It only appears when the secrets are set.
- Pin counts always come from Rotor. Hours and ARR **only fill blanks**, so numbers David entered himself are never overwritten.
- A day with nothing for him in Rotor saves nothing, so an export he already saved isn't wiped.
- About 3 requests per day out of the 1,000/day limit.

**Turn it on** (David is on Rotor Pro; the docs say API access "may come at additional cost depending on your plan", so check that the Integrations page offers API keys):

1. In Rotor: **Settings → Integrations → API Keys**. Create a key with only `pins:read`, `timesheets:read` and `service_plans:read`. It's shown once.
2. On the Worker: `npx wrangler secret put ROTOR_API_KEY` (the key) and `npx wrangler secret put ROTOR_REP_EMAIL` (David's Rotor login email). Or add both under the Worker's **Settings → Variables and Secrets** in the Cloudflare dashboard.
3. In Claude: *"Sync my day from Rotor."* Compare the result with that day's export once.

Why not Rotor's own MCP server (`https://mcp.getrotor.com/mcp`, which has `summarize_map_pin_activity` and timesheets)? Claude Free allows one custom connector, and that has to be the brain. Calling the REST API from the Worker gives the same data through the one connector.

**To verify on a real key** (couldn't be done from the build sandbox):

- [ ] `sync_rotor_day` for a past day matches that day's "New Pins by Team Member" export row exactly. If not, check whether the export counts pins by creator or by assignee, and whether a pin's type changes after it's created (the API returns the current type).
- [ ] Timesheet categories: confirm he clocks in as `sales` while knocking.
- [ ] ARR: compare a few plans' computed ARR with what he'd enter by hand.

**Still in the backlog:** teammates (save every rep's row, let reps log doors, compare reps). The server already supports `rep` on every tool.

Door outcomes use Rotor's pin types, so logged doors compare 1:1 with the export. Outcome and objection categories live in `OUTCOMES` / `OBJECTION_TYPES` in `src/tools/doors.ts` and in the `CHECK` constraints in the migration; change both together.

## Layout

```
src/
  index.ts          # Worker entry: auth check, routes /mcp and /admin/import
  mcp.ts            # MCP server (stateless Streamable HTTP) + tool registration
  admin.ts          # POST /admin/import for the one-time markdown import
  tools/
    doors.ts        # log_door, objection_stats
    kpis.ts         # save_daily_kpis, get_kpis (KPI_FIELDS + computeKpis live here)
    notes.ts        # save_note, ask_brain
    rotor.ts        # v2: sync_rotor_day + nightly sync (off without ROTOR_API_KEY)
  lib/
    auth.ts         # x-brain-key check (constant-time), 401
    embed.ts        # Workers AI embedding helper
    vectors.ts      # Vectorize upsert/query + D1 hydration
    chunk.ts        # note chunking for embeddings
    dates.ts        # today() and LA day ranges in America/Los_Angeles
    rotor.ts        # v2: read-only Rotor OpenAPI client
migrations/
  0001_init.sql
scripts/
  import.ts         # one-time markdown import
  smoke.ts          # live smoke test for the #11 checklist (--health: read-only)
  ci-deploy.sh      # one account's deploy: ensure D1 + Vectorize, migrate, deploy (#16)
.github/workflows/
  ci.yml            # PRs: typecheck + tests
  deploy.yml        # main: check → staging + smoke → production targets
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

## Deploy by hand (without CI)

```bash
npx wrangler login
npm run setup:vectorize       # first time only
npx wrangler secret put BRAIN_KEY
npm run deploy                # wrangler deploy, then D1 migrations --remote
```

`database_id` is left out of `wrangler.jsonc` on purpose: wrangler finds the D1 database by its name (`david-brain`) on whichever account deploys, and creates it on the first deploy. That's what lets one config deploy to every account.

## Importing his markdown files (#9)

```bash
npm run import -- ~/path/to/vault --dry-run                       # lists files + free-tier estimate
BRAIN_KEY=... npm run import -- ~/path/to/vault --url https://<worker>.workers.dev
```

One note per `.md` file (title = file name, tags = its folders, e.g. `raw`). Hidden folders like `.obsidian`, non-markdown files and empty files are skipped. Long files are split into ~1,500-character chunks, because the embedding model reads at most 512 tokens. Safe to re-run.

This week's doors (Wed/Thu, before setup): paste his notes into Claude and say *"log each of these doors with the right date"*. Claude calls `log_door` once per door.

## Testing before the demo (#11)

Covered by `npm test` (60 tests): auth/401, tool listing, every tool's SQL, upsert-not-duplicate, the 6 KPIs checked by hand against David's guide, divide-by-zero, week grouping, similar-door search, chunking, import idempotency, embedding failures, and the Rotor sync against documented API response shapes.

`npm run smoke` runs the same flow against a live Worker (the deployed URL or `wrangler dev`):

```bash
BRAIN_KEY=... npm run smoke -- --url https://<worker>.workers.dev              # 5 doors, all checks
BRAIN_KEY=... npm run smoke -- --url https://<worker>.workers.dev --doors 60   # simulated full day
```

It checks: 401 with no key, a wrong key, or the key in the query string; all 6 tools listed; 5 doors with mixed objections, with no search warning and similar past doors coming back; a sample Rotor export (61 pins) plus 5 h and $1,800 ARR, with all 6 KPIs checked against David's guide; a re-upload of the same day that still leaves 1 row; `objection_stats` and the weekly `get_kpis`; and `save_note` + `ask_brain`. Data goes in as rep `smoke-test` on a random past week, so runs don't mix with each other or with David. Run it on **Nate's** account only, because Vectorize search isn't filtered by rep. It prints the cleanup commands at the end.

Already run against local `wrangler dev` (D1 only): auth, tools, KPIs, upsert, stats and week grouping all pass. The search checks need real Workers AI + Vectorize, so they only pass against a real deploy.

In CI, the staging job runs the smoke test on every merge and cleans up after (#16).

Still to do on a real Cloudflare account:

- [ ] Set up the `staging` Environment and run the Deploy workflow: staging job green (this deploys, migrates and runs the smoke test). Confirm D1 + Vectorize (768, cosine) exist in Nate's dashboard
- [ ] Connect as a custom connector, then on a phone: log 5 fake doors with mixed objections, drop in a real Rotor pin export, give hours + ARR, re-upload the same day, run `objection_stats` + `get_kpis` for the week. This tests Claude's side (tool descriptions, PDF reading, coaching), which the script can't.
- [ ] `npm run smoke -- --doors 60`, then check Workers AI neurons in the dashboard (expect about 20 of 10,000)
- [ ] Saturday: `david` Environment + `PROD_TARGETS`, run the workflow, production job green

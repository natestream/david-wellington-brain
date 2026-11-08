# David Wellington Brain

A free, cloud-hosted second brain for door-to-door window cleaning, used from the Claude app on a phone.

After each door, David tells Claude what happened, gets coaching right away, and the door is saved. At the end of the day he drops in his Rotor CRM pin export, adds his hours and ARR sold, and his 6 KPIs are saved as one clean row per rep. Everything is reachable from any device signed in to his Claude account.

## Staging and production, both on Nate's Cloudflare account

David needs no Cloudflare, GitHub or Doppler account. Everything runs on Nate's account as two fully separate Workers:

| | Staging (Nate tests) | Production (David's brain) |
|---|---|---|
| Worker | `david-wellington-brain` | `david-brain` (wrangler `--env production`) |
| Connector URL | `https://david-wellington-brain.nathanstream203.workers.dev/mcp` | `https://david-brain.nathanstream203.workers.dev/mcp` |
| D1 / Vectorize / KV | `david-brain` / `david-brain-notes` / its own | `david-brain-prod` / `david-brain-notes-prod` / its own |
| Doppler | `staging` + `staging_ci` | `prod` + `prod_ci` |
| GitHub Environment | `staging` | `production` (Required reviewer: Nate) |
| Deploys | every merge to `main`, then the full smoke test | after staging passes **and Nate clicks Approve**; read-only health check |
| Reset | **Actions → Reset staging** (type `RESET`) | never |

Test changes on staging in Claude, then approve the waiting production deploy in the Actions run (**Review deployments → Approve**).

## David's setup: add the connector, sign in

1. Claude → **Settings → Connectors → Add custom connector**.
2. Name *Door Brain*, URL `https://david-brain.nathanstream203.workers.dev/mcp`. Nothing else.
3. **Connect** → *Continue with Google* → his Google account. Done.
4. Test: *"Log a door: no answer on Main St."*

Only Google accounts in `ALLOWED_EMAILS` get in, checked on every request, so adding or removing someone works within a minute, no deploy. Claude stays signed in while it's used (90 idle days). David is on Claude Free, which allows one custom connector; he has none yet, so this one fits.

## One-time: production (before Saturday)

1. **Google Cloud** (the same OAuth client as staging): **Clients →** your client **→ Authorized redirect URIs → add** `https://david-brain.nathanstream203.workers.dev/callback`.
2. **Doppler** `door-brain`:
   - config `prod`: a fresh `BRAIN_KEY` (`openssl rand -hex 32`), the same `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` as staging, `ALLOWED_EMAILS` = David's Gmail (plus Nate's if he wants in).
   - config `prod_ci`: the same `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` as `staging_ci`, and `prod`'s read-only service token as `WORKER_DOPPLER_TOKEN`.
3. **GitHub → Settings → Environments → New → `production`**: secret `DOPPLER_TOKEN` = `prod_ci`'s read-only service token; tick **Required reviewers** → Nate.
4. **GitHub → Settings → Secrets and variables → Actions → Variables**: `PROD_TARGETS` = `["production"]`.
5. **Actions → Deploy → Run workflow** → approve the production job. The first run creates David's empty database, index and sign-in store.

## Sign-in with Google (#25)

`src/oauth.ts` puts OAuth 2.1 (`@cloudflare/workers-oauth-provider`) in front of `/mcp`. Claude discovers it from the 401, registers itself (Client ID Metadata Document or DCR), shows one "Continue with Google" page (remembered 30 days per app), signs in at Google (`openid email`, PKCE) and gets a token.

Google setup, once: [Google Cloud Console](https://console.cloud.google.com/) → project → **Google Auth Platform → Branding** (Audience **External**, then **Publish app**: only `openid email`, so no Google review) → **Clients → Create client → Web application**, with one **Authorized redirect URI** per Worker: `https://<worker>.nathanstream203.workers.dev/callback`.

| Doppler key (in `staging` and `prod`) | Value |
|---|---|
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | the Google client (shared by both Workers) |
| `ALLOWED_EMAILS` | who may sign in, e.g. `david@gmail.com, nate@gmail.com` |
| `BRAIN_KEY` | script key (`x-api-key`), also signs the "remember this app" cookie |

Scripts (smoke test, import) use the `x-api-key: <BRAIN_KEY>` header instead of signing in.

## Deploys (#16)

`.github/workflows/deploy.yml`, on every merge to `main` (or **Actions → Deploy → Run workflow**):

1. **check**: typecheck + tests. Nothing deploys if they fail.
2. **staging**: deploys, runs the full `npm run smoke` against it, then deletes the test data.
3. **production** (one job per entry in `PROD_TARGETS`, each both a GitHub Environment and a wrangler env): waits for approval, deploys, then a read-only health check (`--health`: auth + sign-in discovery + tools list, writes nothing).

Each deploy (`scripts/ci-deploy.sh`, `WRANGLER_ENV` picks the Worker) creates the D1 database and Vectorize index (768, cosine) if they're missing, applies new migrations, then deploys with the Worker's `DOPPLER_TOKEN`. KV is created by the deploy itself. Re-deploys never touch data. Keep migrations additive (new tables/columns): they apply just before the new code goes live.

**Reset staging** (`.github/workflows/reset-staging.yml`, `scripts/reset-staging.ts`): deletes every row in `doors`, `daily_kpis`, `notes` and every vector in `david-brain-notes`. Keeps the schema, the index and the sign-in store, so Claude stays connected. Pinned to the `staging` Environment and the staging names; refuses without `RESET`.

### All keys live in Doppler (#21)

No sync. The deploy reads its keys from Doppler when it runs (`scripts/doppler-env.sh`), and the Worker reads its secrets from Doppler while it runs. **Changing a key in Doppler never needs a sync, and changing a Worker secret never needs a deploy.** GitHub holds only each Environment's `DOPPLER_TOKEN`.

| Config | Holds | Its read-only service token goes in |
|---|---|---|
| `staging` / `prod` | `BRAIN_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ALLOWED_EMAILS` | `staging_ci` / `prod_ci` as `WORKER_DOPPLER_TOKEN` |
| `staging_ci` / `prod_ci` | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `WORKER_DOPPLER_TOKEN` | GitHub Environment `staging` / `production` as `DOPPLER_TOKEN` |

Two tokens per Worker so the running server can read only its own secrets, never the Cloudflare credentials. Service tokens: open the config → **Access → Service Tokens → Generate**, read-only.

- The Worker keeps its secrets for 60 seconds, then asks Doppler again. If Doppler is down it keeps the last values; if it never got any, it refuses every request (503).
- **Change who can sign in:** edit `ALLOWED_EMAILS`. **Change the script key:** new `BRAIN_KEY` (Claude users stay signed in; the sign-in page asks once more). Live within about a minute, no deploy.
- **Change the Cloudflare token:** update it in `staging_ci` and `prod_ci`. The next deploy uses it.
- **Change a Worker's Doppler token:** update `WORKER_DOPPLER_TOKEN` in its `_ci` config, then run the deploy once.

### Cloudflare API token

**My Profile → API Tokens → Create Token → "Edit Cloudflare Workers" template**, plus account permissions **D1: Edit**, **Vectorize: Edit** and **Workers KV Storage: Edit**, **Account Resources** = Nate's account. Copy it into Doppler as `CLOUDFLARE_API_TOKEN` (both `_ci` configs).

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

**Rotor has a public API** ([docs](https://docs.api.getrotor.com/), [setup](https://rotor.stldocs.app/)), so a later version can pull the pin counts itself with `source: "crm"`. From the docs index (not yet verified against a real account):

- Base URL `https://api.getrotor.com/open-api/`, key in the `x-api-key` header plus a version header (`1.1.0`). `GET /open-api/auth/test` checks the key and lists its scopes.
- Key: **Rotor → Settings → Integrations → API**: name it, pick permissions, optional expiry. It's shown once.
- Endpoints: Leads, Customers (list, create/update), Service Plans, Serviced Jobs, **Pins** and **Pin Types**.
- Limit: 1,000 requests/day by default. The docs hint that access may need to be requested.

v2 idea: a `sync_rotor_day` tool that lists a day's pins, counts them per rep and pin type (the same numbers as the export), and saves them with `source: "crm"`. Hours and ARR would still come from the rep, unless service plans in the API carry the ARR.

**v2 backlog:**
- **Rotor API sync** (Nate is looking into the API): confirm the Pins response fields, then add `sync_rotor_day`. Needs David's Rotor plan to include API access and a read-only key, stored as a Worker secret `ROTOR_API_KEY` (never in the repo).
- **Teammates:** save every rep's row from the export (lowercase-hyphenated names, e.g. `jane-doe`), let reps log doors, and compare reps in `get_kpis`. The server already supports `rep` on every tool, so this is mostly tool descriptions plus a decision on whether reps get their own connector/key.

Door outcomes use Rotor's pin types, so logged doors compare 1:1 with the export. Outcome and objection categories live in `OUTCOMES` / `OBJECTION_TYPES` in `src/tools/doors.ts` and in the `CHECK` constraints in the migration; change both together.

## Layout

```
src/
  index.ts          # Worker entry: scripts (x-api-key) or Google sign-in, routes /mcp and /admin/import
  oauth.ts          # Google sign-in for Claude's connector: consent page, Google callback, email allowlist (#25)
  mcp.ts            # MCP server (stateless Streamable HTTP) + tool registration
  admin.ts          # POST /admin/import for the one-time markdown import
  tools/
    doors.ts        # log_door, objection_stats
    kpis.ts         # save_daily_kpis, get_kpis (KPI_FIELDS + computeKpis live here)
    notes.ts        # save_note, ask_brain
  lib/
    auth.ts         # x-api-key check for scripts (constant-time), 401
    keystore.ts     # secrets from Doppler at runtime (60s cache), env fallback (#21)
    embed.ts        # Workers AI embedding helper
    vectors.ts      # Vectorize upsert/query + D1 hydration
    chunk.ts        # note chunking for embeddings
    dates.ts        # today() in America/Los_Angeles
migrations/
  0001_init.sql
scripts/
  import.ts         # one-time markdown import
  smoke.ts          # live smoke test for the #11 checklist (--health: read-only)
  ci-deploy.sh      # one account's deploy: ensure D1 + Vectorize, migrate, deploy (#16)
.github/workflows/
  ci.yml            # PRs: typecheck + tests
  deploy.yml        # main: check → staging + smoke → production targets
test/               # vitest: real SQLite for D1, fakes for Vectorize, Workers AI, KV and Google
wrangler.jsonc
```

## Conventions

- **Auth:** Claude signs in with Google (OAuth 2.1, `@cloudflare/workers-oauth-provider`, tokens in KV `OAUTH_KV`); every MCP call re-checks the email against `ALLOWED_EMAILS`. Scripts send `x-api-key` matching `BRAIN_KEY`. Keys are never accepted in the URL.
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
# URL: http://localhost:8787/mcp   Header: x-api-key: dev-key
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

Covered by `npm test` (45 tests): auth/401, tool listing, every tool's SQL, upsert-not-duplicate, the 6 KPIs checked by hand against David's guide, divide-by-zero, week grouping, similar-door search, chunking, import idempotency, embedding failures.

`npm run smoke` runs the same flow against a live Worker (the deployed URL or `wrangler dev`):

```bash
BRAIN_KEY=... npm run smoke -- --url https://<worker>.workers.dev              # 5 doors, all checks
DOPPLER_TOKEN=... npm run smoke -- --url https://<worker>.workers.dev          # same, key read from Doppler
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

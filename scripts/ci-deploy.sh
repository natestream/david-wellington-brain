#!/usr/bin/env bash
# Deploy this Worker to one Cloudflare account (used by .github/workflows/deploy.yml).
#
# Needs: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, BRAIN_KEY.
# Safe to re-run: creates D1 + Vectorize only if they're missing, migrations only apply once,
# and the deploy replaces the previous version. Data is never touched.
#
# Order: resources → migrations → deploy, so new code never runs against an old schema.
# Keep migrations additive (new tables/columns) so the old code keeps working while they apply.
set -euo pipefail

: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}"
: "${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID}"
: "${BRAIN_KEY:?set BRAIN_KEY}"

DB_NAME="david-brain"
INDEX_NAME="david-brain-notes"
wrangler() { npx --no-install wrangler "$@"; }

echo "::group::D1 database ${DB_NAME}"
if wrangler d1 info "$DB_NAME" --json >/dev/null 2>&1; then
  echo "exists"
else
  wrangler d1 create "$DB_NAME" --no-update-config
fi
echo "::endgroup::"

echo "::group::Vectorize index ${INDEX_NAME}"
if wrangler vectorize get "$INDEX_NAME" >/dev/null 2>&1; then
  echo "exists"
else
  # Must match @cf/baai/bge-base-en-v1.5. Can't be changed after creation.
  wrangler vectorize create "$INDEX_NAME" --dimensions=768 --metric=cosine
fi
echo "::endgroup::"

echo "::group::D1 migrations"
wrangler d1 migrations apply DB --remote
echo "::endgroup::"

echo "::group::Deploy"
secrets="$(mktemp)"
log="$(mktemp)"
trap 'rm -f "$secrets" "$log"' EXIT
node -e 'process.stdout.write(JSON.stringify({ BRAIN_KEY: process.env.BRAIN_KEY }))' > "$secrets"
wrangler deploy --secrets-file "$secrets" 2>&1 | tee "$log"
echo "::endgroup::"

url="$(grep -oE 'https://[a-z0-9.-]+\.workers\.dev' "$log" | head -1 || true)"
if [[ -n "$url" ]]; then
  echo "Deployed to $url"
  [[ -n "${GITHUB_OUTPUT:-}" ]] && echo "url=$url" >> "$GITHUB_OUTPUT"
else
  echo "::warning::Deployed, but no workers.dev URL in the output. Is a workers.dev subdomain set up on this account (Workers & Pages in the dashboard)?"
fi

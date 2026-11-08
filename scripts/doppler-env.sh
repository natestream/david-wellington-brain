#!/usr/bin/env bash
# Load this target's secrets from Doppler into the GitHub Actions job (used by .github/workflows/deploy.yml).
#
# GitHub holds one secret per Environment: DOPPLER_TOKEN, a read-only service token for that
# target's CI config (e.g. `staging_ci`). Everything else comes from Doppler at run time, no sync:
#
#   CLOUDFLARE_API_TOKEN   deploys to that Cloudflare account
#   CLOUDFLARE_ACCOUNT_ID  that account
#   BRAIN_KEY              the connector key (the smoke test uses it)
#   WORKER_DOPPLER_TOKEN   read-only service token for the config that holds only BRAIN_KEY
#                          (e.g. `staging`); the deploy gives it to the Worker (#21)
#
# Each value is masked in the logs, then exported to the next steps via $GITHUB_ENV.
set -euo pipefail

: "${DOPPLER_TOKEN:?set the DOPPLER_TOKEN secret on this GitHub Environment}"
: "${GITHUB_ENV:?run this inside GitHub Actions}"

json="$(curl -fsS --retry 3 --max-time 15 \
  -H "Authorization: Bearer ${DOPPLER_TOKEN}" -H "Accept: application/json" \
  "https://api.doppler.com/v3/configs/config/secrets/download?format=json")" || {
  echo "::error::Doppler refused or couldn't be reached. Is DOPPLER_TOKEN a service token for this target's CI config?"
  exit 1
}

DOPPLER_JSON="$json" node --input-type=module -e '
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
const s = JSON.parse(process.env.DOPPLER_JSON);
const required = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "BRAIN_KEY", "WORKER_DOPPLER_TOKEN"];
const missing = required.filter((k) => typeof s[k] !== "string" || s[k].trim() === "");
if (missing.length) {
  console.log(`::error::Missing in Doppler: ${missing.join(", ")}`);
  process.exit(1);
}
for (const k of required) {
  const v = s[k].trim();
  for (const line of v.split("\n")) if (line) console.log(`::add-mask::${line}`);
  const eof = `EOF_${randomUUID()}`;
  appendFileSync(process.env.GITHUB_ENV, `${k}<<${eof}\n${v}\n${eof}\n`);
}
console.log(`Loaded from Doppler: ${required.join(", ")}`);
'

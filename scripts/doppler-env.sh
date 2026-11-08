#!/usr/bin/env bash
# Load this target's secrets from Doppler into the GitHub Actions job (used by .github/workflows/deploy.yml).
#
# GitHub holds one secret per Environment: DOPPLER_TOKEN, a read-only service token for that
# target's CI config (e.g. `staging_ci`). Everything else comes from Doppler at run time, no sync:
#
# From the CI config (e.g. `staging_ci`):
#   CLOUDFLARE_API_TOKEN   deploys to that Cloudflare account
#   CLOUDFLARE_ACCOUNT_ID  that account
#   WORKER_DOPPLER_TOKEN   read-only service token for the config that holds BRAIN_KEY
#                          (e.g. `staging`); the deploy gives it to the Worker (#21)
# Then, with WORKER_DOPPLER_TOKEN, exactly as the Worker does:
#   BRAIN_KEY              the connector key (the smoke test uses it). It lives only in `staging`,
#                          so the CI config needs no copy and doesn't have to inherit it.
#
# Each value is masked in the logs, then exported to the next steps via $GITHUB_ENV.
set -euo pipefail

: "${DOPPLER_TOKEN:?set the DOPPLER_TOKEN secret on this GitHub Environment}"
: "${GITHUB_ENV:?run this inside GitHub Actions}"

# DOPPLER_HOP: the name of a secret in the DOPPLER_TOKEN config that holds another config's
# read-only token (production: stg_ci's PRD_CI_DOPPLER_TOKEN → prd_ci). Load from that config instead.
if [[ -n "${DOPPLER_HOP:-}" ]]; then
  hop="$(curl -fsS --retry 3 --max-time 15 \
    -H "Authorization: Bearer ${DOPPLER_TOKEN}" -H "Accept: application/json" \
    "https://api.doppler.com/v3/configs/config/secrets/download?format=json" \
    | HOP_NAME="$DOPPLER_HOP" node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(String(JSON.parse(s)[process.env.HOP_NAME]??"").trim()))')" || hop=""
  if [[ -z "$hop" ]]; then
    echo "::error::${DOPPLER_HOP} is missing in the config DOPPLER_TOKEN belongs to (stg_ci). Add a read-only service token for the target's CI config there."
    exit 1
  fi
  echo "::add-mask::${hop}"
  DOPPLER_TOKEN="$hop"
  echo "Loading from the config ${DOPPLER_HOP} points at."
fi

json="$(curl -fsS --retry 3 --max-time 15 \
  -H "Authorization: Bearer ${DOPPLER_TOKEN}" -H "Accept: application/json" \
  "https://api.doppler.com/v3/configs/config/secrets/download?format=json")" || {
  echo "::error::Doppler refused or couldn't be reached. Is DOPPLER_TOKEN a service token for this target's CI config?"
  exit 1
}

DOPPLER_JSON="$json" node --input-type=module -e '
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const URL = "https://api.doppler.com/v3/configs/config/secrets/download?format=json";
const fail = (msg) => { console.log(`::error::${msg}`); process.exit(1); };
const str = (v) => (typeof v === "string" ? v.trim() : "");

const ci = JSON.parse(process.env.DOPPLER_JSON);
const fromCi = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "WORKER_DOPPLER_TOKEN"];
const missing = fromCi.filter((k) => !str(ci[k]));
if (missing.length) fail(`Missing in the CI config (the one DOPPLER_TOKEN belongs to): ${missing.join(", ")}`);
const out = Object.fromEntries(fromCi.map((k) => [k, str(ci[k])]));

// BRAIN_KEY: read with the Worker token, the same way the server reads it.
const res = await fetch(URL, { headers: { authorization: `Bearer ${out.WORKER_DOPPLER_TOKEN}`, accept: "application/json" } });
if (!res.ok) fail(`Doppler refused WORKER_DOPPLER_TOKEN (HTTP ${res.status}). It should be a service token for the config that holds BRAIN_KEY (e.g. staging).`);
out.BRAIN_KEY = str((await res.json()).BRAIN_KEY);
if (!out.BRAIN_KEY) fail("BRAIN_KEY is missing in the config WORKER_DOPPLER_TOKEN belongs to (e.g. staging).");

for (const [k, v] of Object.entries(out)) {
  for (const line of v.split("\n")) if (line) console.log(`::add-mask::${line}`);
  const eof = `EOF_${randomUUID()}`;
  appendFileSync(process.env.GITHUB_ENV, `${k}<<${eof}\n${v}\n${eof}\n`);
}
console.log(`Loaded from Doppler: ${Object.keys(out).join(", ")}`);
'

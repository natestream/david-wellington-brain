/**
 * Empty the STAGING brain so Nate can retest from scratch (Actions → "Reset staging").
 *
 * Deletes every row in doors, daily_kpis and notes, and every vector in the search index.
 * Keeps the schema (migrations), the index itself, and the sign-in store (OAUTH_KV), so
 * Claude stays connected.
 *
 * Only for staging. It refuses unless RESET_TARGET=staging and RESET_CONFIRM=RESET, and the
 * workflow that runs it is pinned to the `staging` GitHub Environment (Nate's Cloudflare account),
 * so it can never reach David's account.
 *
 * Needs CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID (from Doppler via scripts/doppler-env.sh).
 */
import { execFileSync } from "node:child_process";

export const TABLES = ["doors", "daily_kpis", "notes"] as const;
export const INDEX_NAME = "david-brain-notes";
const API = "https://api.cloudflare.com/client/v4";

type Fetch = typeof fetch;

/** Every vector id in the index, following the list cursor. */
export async function listVectorIds(account: string, token: string, f: Fetch = fetch): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const u = new URL(`${API}/accounts/${account}/vectorize/v2/indexes/${INDEX_NAME}/list`);
    u.searchParams.set("count", "1000");
    if (cursor) u.searchParams.set("cursor", cursor);
    const res = await f(u, { headers: { authorization: `Bearer ${token}` } });
    const body = (await res.json()) as {
      success?: boolean;
      errors?: unknown;
      result?: { vectors?: { id: string }[]; isTruncated?: boolean; nextCursor?: string | null };
    };
    if (!res.ok || !body.success) throw new Error(`Vectorize list failed: HTTP ${res.status} ${JSON.stringify(body.errors)}`);
    ids.push(...(body.result?.vectors ?? []).map((v) => v.id));
    cursor = body.result?.isTruncated ? (body.result.nextCursor ?? undefined) : undefined;
  } while (cursor);
  return ids;
}

/** Delete vectors by id, in batches. Vectorize applies deletes asynchronously (a few seconds). */
export async function deleteVectors(account: string, token: string, ids: string[], f: Fetch = fetch, batch = 500): Promise<number> {
  let n = 0;
  for (let i = 0; i < ids.length; i += batch) {
    const chunk = ids.slice(i, i + batch);
    const res = await f(`${API}/accounts/${account}/vectorize/v2/indexes/${INDEX_NAME}/delete_by_ids`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ ids: chunk }),
    });
    const body = (await res.json()) as { success?: boolean; errors?: unknown };
    if (!res.ok || !body.success) throw new Error(`Vectorize delete failed: HTTP ${res.status} ${JSON.stringify(body.errors)}`);
    n += chunk.length;
  }
  return n;
}

function d1(sql: string): unknown {
  const out = execFileSync("npx", ["--no-install", "wrangler", "d1", "execute", "DB", "--env=", "--remote", "--json", "--command", sql], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  return JSON.parse(out);
}

function counts(): Record<string, number> {
  const sql = TABLES.map((t) => `SELECT '${t}' AS t, COUNT(*) AS n FROM ${t}`).join(" UNION ALL ");
  const res = d1(sql) as { results: { t: string; n: number }[] }[];
  return Object.fromEntries((res[0]?.results ?? []).map((r) => [r.t, r.n]));
}

export function checkGuards(env: NodeJS.ProcessEnv): string | null {
  if (env.RESET_TARGET !== "staging") return "Refusing: RESET_TARGET must be 'staging'. This never runs on David's account.";
  if (env.RESET_CONFIRM !== "RESET") return "Refusing: type RESET in the confirm box to wipe staging.";
  if (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID) return "Missing CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID.";
  return null;
}

async function main() {
  const problem = checkGuards(process.env);
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
  const account = process.env.CLOUDFLARE_ACCOUNT_ID!;
  const token = process.env.CLOUDFLARE_API_TOKEN!;

  console.log("Before:", JSON.stringify(counts()));

  const ids = await listVectorIds(account, token);
  console.log(`Search index: ${ids.length} vectors`);
  if (ids.length) console.log(`Deleted ${await deleteVectors(account, token, ids)} vectors (applied within a few seconds)`);

  d1(TABLES.map((t) => `DELETE FROM ${t};`).join(" "));
  const after = counts();
  console.log("After:", JSON.stringify(after));
  if (Object.values(after).some((n) => n !== 0)) {
    console.error("Some rows are still there.");
    process.exit(1);
  }
  console.log("Staging is empty. Claude stays signed in; start testing.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

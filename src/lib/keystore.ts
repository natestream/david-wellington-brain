import type { Env } from "../env";

/**
 * Where the server gets the key it checks requests against.
 *
 * - `DOPPLER_TOKEN` set (deployed Workers): read `BRAIN_KEY` from Doppler at runtime, so changing it
 *   in Doppler takes effect within CACHE_MS, with no redeploy. `BRAIN_KEY` in the env is then ignored,
 *   so there is only one source of truth.
 * - No `DOPPLER_TOKEN` (tests, `wrangler dev`, older deploys): use `BRAIN_KEY` from the env.
 *
 * The token is a read-only Doppler service token scoped to one config (e.g. `staging`, `david`),
 * so it already knows its project and config.
 */
export const DOPPLER_URL = "https://api.doppler.com/v3/configs/config/secrets/download?format=json";
export const CACHE_MS = 60_000;
const TIMEOUT_MS = 3_000;

export type KeyResult =
  | { ok: true; key: string }
  | { ok: false; status: 500 | 503; error: string };

// Per isolate. Each Worker isolate fetches on its own; that's a handful of calls a minute at most.
let cached: { key: string; at: number } | null = null;
let inflight: Promise<string> | null = null;

export async function getBrainKey(env: Env, now = Date.now()): Promise<KeyResult> {
  if (!env.DOPPLER_TOKEN) {
    return env.BRAIN_KEY
      ? { ok: true, key: env.BRAIN_KEY }
      : { ok: false, status: 500, error: "Server not configured: set DOPPLER_TOKEN (or BRAIN_KEY)." };
  }

  if (cached && now - cached.at < CACHE_MS) return { ok: true, key: cached.key };

  try {
    // Share one Doppler call between requests that arrive together.
    inflight ??= fetchFromDoppler(env.DOPPLER_TOKEN).finally(() => (inflight = null));
    const key = await inflight;
    cached = { key, at: now };
    return { ok: true, key };
  } catch (e) {
    // Doppler down or misconfigured: keep using the last good key rather than locking everyone out.
    if (cached) {
      console.warn(`Doppler fetch failed, using cached key: ${(e as Error).message}`);
      return { ok: true, key: cached.key };
    }
    // Never let a request in without a checked key.
    console.error(`Doppler fetch failed, no cached key: ${(e as Error).message}`);
    return { ok: false, status: 503, error: "Can't reach the key store (Doppler). Try again in a minute." };
  }
}

async function fetchFromDoppler(token: string): Promise<string> {
  const res = await fetch(DOPPLER_URL, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Doppler HTTP ${res.status}`);
  const body = (await res.json()) as Record<string, unknown>;
  const key = body.BRAIN_KEY;
  if (typeof key !== "string" || key.trim() === "") throw new Error("BRAIN_KEY missing in the Doppler config");
  return key.trim();
}

/** Tests only: forget the cached key. */
export function resetKeyCache(): void {
  cached = null;
  inflight = null;
}

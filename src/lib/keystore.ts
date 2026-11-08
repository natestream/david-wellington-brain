import type { Env } from "../env";

/**
 * Where the server gets its secrets.
 *
 * - `DOPPLER_TOKEN` set (deployed Workers): read them from Doppler at runtime, so a change in Doppler
 *   takes effect within CACHE_MS, with no redeploy. Secrets in the env are then ignored, so there is
 *   only one source of truth.
 * - No `DOPPLER_TOKEN` (tests, `wrangler dev`): read them from the env.
 *
 * The token is a read-only Doppler service token scoped to one config (e.g. `staging`, `david`),
 * so it already knows its project and config.
 */
export const DOPPLER_URL = "https://api.doppler.com/v3/configs/config/secrets/download?format=json";
export const CACHE_MS = 60_000;
const TIMEOUT_MS = 3_000;

export interface BrainConfig {
  /** Key for scripts (`x-api-key`), and the secret that signs remembered consent. */
  BRAIN_KEY: string;
  /** Google sign-in for the Claude connector (#25). Missing = sign-in is off. */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Google accounts allowed in, comma or space separated. Empty = nobody. */
  ALLOWED_EMAILS?: string;
}

const NAMES = ["BRAIN_KEY", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "ALLOWED_EMAILS"] as const;

export type ConfigResult =
  | { ok: true; config: BrainConfig }
  | { ok: false; status: 500 | 503; error: string };

export type KeyResult = { ok: true; key: string } | { ok: false; status: 500 | 503; error: string };

// Per isolate. Each Worker isolate fetches on its own; that's a handful of calls a minute at most.
let cached: { config: BrainConfig; at: number } | null = null;
let inflight: Promise<BrainConfig> | null = null;

export async function getConfig(env: Env, now = Date.now()): Promise<ConfigResult> {
  if (!env.DOPPLER_TOKEN) {
    const config = pick(env as unknown as Record<string, unknown>);
    return config
      ? { ok: true, config }
      : { ok: false, status: 500, error: "Server not configured: set DOPPLER_TOKEN (or BRAIN_KEY)." };
  }

  if (cached && now - cached.at < CACHE_MS) return { ok: true, config: cached.config };

  try {
    // Share one Doppler call between requests that arrive together.
    inflight ??= fetchFromDoppler(env.DOPPLER_TOKEN).finally(() => (inflight = null));
    const config = await inflight;
    cached = { config, at: now };
    return { ok: true, config };
  } catch (e) {
    // Doppler down or misconfigured: keep using the last good values rather than locking everyone out.
    if (cached) {
      console.warn(`Doppler fetch failed, using cached secrets: ${(e as Error).message}`);
      return { ok: true, config: cached.config };
    }
    // Never let a request in without a checked key.
    console.error(`Doppler fetch failed, nothing cached: ${(e as Error).message}`);
    return { ok: false, status: 503, error: "Can't reach the key store (Doppler). Try again in a minute." };
  }
}

/** Just the script key (`x-api-key`). */
export async function getBrainKey(env: Env, now = Date.now()): Promise<KeyResult> {
  const r = await getConfig(env, now);
  return r.ok ? { ok: true, key: r.config.BRAIN_KEY } : r;
}

async function fetchFromDoppler(token: string): Promise<BrainConfig> {
  const res = await fetch(DOPPLER_URL, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Doppler HTTP ${res.status}`);
  const config = pick((await res.json()) as Record<string, unknown>);
  if (!config) throw new Error("BRAIN_KEY missing in the Doppler config");
  return config;
}

function pick(source: Record<string, unknown>): BrainConfig | null {
  const out: Record<string, string> = {};
  for (const name of NAMES) {
    const v = source[name];
    if (typeof v === "string" && v.trim() !== "") out[name] = v.trim();
  }
  return out.BRAIN_KEY ? (out as unknown as BrainConfig) : null;
}

/** Lowercased emails from ALLOWED_EMAILS. */
export function allowedEmails(config: BrainConfig): Set<string> {
  return new Set(
    (config.ALLOWED_EMAILS ?? "")
      .split(/[\s,;]+/)
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** Tests only: forget the cached secrets. */
export function resetKeyCache(): void {
  cached = null;
  inflight = null;
}

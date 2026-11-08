/**
 * Script auth: `x-api-key: <BRAIN_KEY>` (see keystore.ts), for the smoke test and the import.
 * Claude's connector signs in with Google instead (src/oauth.ts), so `Authorization: Bearer` is
 * an OAuth token here, never BRAIN_KEY. The key is never accepted in the URL (it would leak into logs).
 */
export async function isAuthorized(request: Request, secret: string | undefined): Promise<boolean> {
  if (!secret) return false;
  const provided = request.headers.get("x-api-key");
  const ok = provided ? await timingSafeEqualStrings(provided, secret) : false;
  if (!ok) await logAuthFailure(request, provided, secret);
  return ok;
}

/**
 * One log line per rejected request (Cloudflare → Workers & Pages → Logs), to tell "no key arrived"
 * from "wrong key". Never logs a key: only header names, lengths, and an 8-character SHA-256
 * fingerprint you can compare with `printf %s '<key>' | sha256sum | cut -c1-8`.
 */
async function logAuthFailure(request: Request, provided: string | null, secret: string): Promise<void> {
  const { pathname } = new URL(request.url);
  const info: Record<string, unknown> = {
    event: "auth_failed",
    reason: provided ? "wrong_key" : "no_key_header",
    method: request.method,
    path: pathname,
    header_names: [...request.headers.keys()].sort(),
    user_agent: request.headers.get("user-agent"),
    expected: { length: secret.length, sha256_8: await fingerprint(secret) },
  };
  if (provided) {
    info.sent = {
      length: provided.length,
      sha256_8: await fingerprint(provided),
      has_quotes: /^["']|["']$/.test(provided),
      has_spaces: /\s/.test(provided),
    };
  }
  console.warn(JSON.stringify(info));
}

async function fingerprint(value: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...d.slice(0, 4)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Compare SHA-256 digests in constant time so the comparison doesn't leak the key length or prefix. */
async function timingSafeEqualStrings(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const x = new Uint8Array(da);
  const y = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

/** A wrong or missing script key. Only scripts get here: Claude's 401s come from the OAuth layer. */
export function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "unauthorized", hint: "Send the x-api-key header." }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
}

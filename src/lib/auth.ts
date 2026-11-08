/**
 * Header auth: the BRAIN_KEY secret, sent as `x-api-key: <key>` (what Claude's connector sends)
 * or `Authorization: Bearer <key>`. The key is never accepted in the URL (it would leak into logs).
 */
export async function isAuthorized(request: Request, secret: string | undefined): Promise<boolean> {
  if (!secret) return false;
  const provided = request.headers.get("x-api-key") || bearer(request);
  if (!provided) return false;
  return timingSafeEqualStrings(provided, secret);
}

function bearer(request: Request): string | null {
  const m = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i);
  return m ? m[1]!.trim() : null;
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

/**
 * No `www-authenticate` header on purpose: under the MCP spec it tells Claude to start an OAuth
 * sign-in, which this server doesn't offer, so reconnecting the connector fails.
 */
export function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "unauthorized", hint: "Send the x-api-key header." }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
}

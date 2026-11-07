/**
 * Auth: the BRAIN_KEY secret, sent one of three ways.
 *
 * 1. `Authorization: Bearer <key>`: a standard header, so Claude's connector can send it
 *    without Anthropic approving a custom header name.
 * 2. `x-brain-key: <key>`: kept for scripts (smoke test, import).
 * 3. In the path, `/mcp/<key>`: for clients that can't send any header (e.g. the
 *    "Add custom connector" screen). Checked in index.ts via `pathKey`.
 *
 * The key is never accepted as a query parameter.
 */
export async function isAuthorized(
  request: Request,
  secret: string | undefined,
  pathKey?: string,
): Promise<boolean> {
  if (!secret) return false;
  const provided = pathKey || bearer(request) || request.headers.get("x-brain-key");
  if (!provided) return false;
  return timingSafeEqualStrings(provided, secret);
}

function bearer(request: Request): string | null {
  const h = request.headers.get("authorization");
  const m = h?.match(/^Bearer\s+(.+)$/i);
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

export function unauthorized(): Response {
  return new Response(
    JSON.stringify({
      error: "unauthorized",
      hint: "Send Authorization: Bearer <key>, or use the URL /mcp/<key>.",
    }),
    {
      status: 401,
      headers: { "content-type": "application/json", "www-authenticate": 'Bearer realm="brain"' },
    },
  );
}

import OAuthProvider, {
  AuthorizationError,
  CimdFetchError,
  authorizationErrorRedirect,
  type AuthRequest,
  type ConsentDescription,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import type { Env } from "./env";
import { allowedEmails, getConfig, type BrainConfig } from "./lib/keystore";
import { handleMcp } from "./mcp";

/**
 * Sign in with Google for the Claude connector (#25).
 *
 * In Claude: Add custom connector → paste `https://<worker>/mcp` → Connect → pick a Google account.
 * Claude registers itself (DCR or a Client ID Metadata Document), gets sent to /authorize here,
 * sees one "Continue with Google" page, signs in at Google, and comes back with a token.
 * Only emails in ALLOWED_EMAILS (Doppler) get in, checked again on every MCP request, so removing
 * someone from the list locks them out within a minute, without a deploy.
 */
export const SCOPE = "brain";
const GOOGLE_AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";

interface Props {
  email: string;
}

type Ctx = ExecutionContext & { props?: Props };

const mcpApi = {
  async fetch(request: Request, env: Env, ctx: Ctx): Promise<Response> {
    const email = ctx.props?.email?.toLowerCase();
    const cfg = await getConfig(env);
    if (!cfg.ok) return new Response(`${cfg.error}\n`, { status: cfg.status });
    if (!email || !allowedEmails(cfg.config).has(email)) {
      console.warn(JSON.stringify({ event: "mcp_forbidden", email }));
      return Response.json({ error: "forbidden", hint: "This Google account is no longer allowed." }, { status: 403 });
    }
    return handleMcp(request, env);
  },
};

const authRoutes = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const oauth = env.OAUTH_PROVIDER;
    try {
      if (url.pathname === "/authorize" && request.method === "GET") return await startAuthorize(request, env, oauth);
      if (url.pathname === "/authorize" && request.method === "POST") return await answerConsent(request, env, oauth);
      if (url.pathname === "/callback" && request.method === "GET") return await googleCallback(request, env, oauth);
      return new Response("Not found\n", { status: 404 });
    } catch (error) {
      if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
      if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
        const msg = error instanceof AuthorizationError ? error.description : "This app could not be verified.";
        return page("Sign-in didn't work", `<p>${esc(msg)}</p><p>Go back to Claude and try connecting again.</p>`, 400);
      }
      throw error;
    }
  },
};

// One provider per origin: its resource URL is this Worker's own address, which differs per account.
const providers = new Map<string, OAuthProvider<Env>>();

export function oauthProvider(origin: string): OAuthProvider<Env> {
  let p = providers.get(origin);
  if (!p) {
    p = new OAuthProvider<Env>({
      apiRoute: "/mcp",
      apiHandler: mcpApi as never,
      defaultHandler: authRoutes as never,
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/oauth/token",
      clientRegistrationEndpoint: "/oauth/register",
      clientIdMetadataDocumentEnabled: true,
      scopesSupported: [SCOPE],
      requiredScopes: [SCOPE],
      resourceMetadata: { resource: `${origin}/mcp`, authorization_servers: [origin] },
      // Stay signed in while the connector is used; sign in again after 90 idle days.
      refreshTokenIdleTTL: 90 * 86_400,
    });
    providers.set(origin, p);
  }
  return p;
}

async function googleConfig(env: Env): Promise<BrainConfig & { GOOGLE_CLIENT_ID: string; GOOGLE_CLIENT_SECRET: string }> {
  const cfg = await getConfig(env);
  if (!cfg.ok) throw new HttpError(cfg.status, cfg.error);
  const c = cfg.config;
  if (!c.GOOGLE_CLIENT_ID || !c.GOOGLE_CLIENT_SECRET) {
    throw new HttpError(500, "Google sign-in isn't set up: add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in Doppler.");
  }
  return c as BrainConfig & { GOOGLE_CLIENT_ID: string; GOOGLE_CLIENT_SECRET: string };
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// GET /authorize: Claude sends the user here. Ask once per app (remembered 30 days), then go to Google.
async function startAuthorize(request: Request, env: Env, oauth: OAuthHelpers): Promise<Response> {
  let cfg;
  try {
    cfg = await googleConfig(env);
  } catch (e) {
    if (e instanceof HttpError) return page("Sign-in isn't available", `<p>${esc(e.message)}</p>`, e.status);
    throw e;
  }
  const authRequest = await oauth.parseAuthRequest(request);
  if (await oauth.isConsentRemembered(request, authRequest, { secret: cfg.BRAIN_KEY })) {
    return toGoogle(request, oauth, authRequest, cfg.GOOGLE_CLIENT_ID, new Headers());
  }
  const details = await oauth.describeConsent(authRequest);
  const consent = await oauth.beginConsent(authRequest);
  consent.headers.set("content-type", "text/html; charset=utf-8");
  return new Response(consentPage(details, consent.handle), { headers: consent.headers });
}

// POST /authorize: "Continue with Google" or "Cancel".
async function answerConsent(request: Request, env: Env, oauth: OAuthHelpers): Promise<Response> {
  const form = await request.formData();
  const handle = String(form.get("handle") ?? "");
  if (form.get("decision") !== "approve") {
    const denied = await oauth.denyConsent(request, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }
  const cfg = await googleConfig(env);
  const approved = await oauth.approveConsent(request, handle, {
    scope: [SCOPE],
    remember: { secret: cfg.BRAIN_KEY },
  });
  return toGoogle(request, oauth, approved.request, cfg.GOOGLE_CLIENT_ID, approved.headers);
}

async function toGoogle(
  request: Request,
  oauth: OAuthHelpers,
  authRequest: AuthRequest,
  clientId: string,
  headers: Headers,
): Promise<Response> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const { state, headers: out } = await oauth.beginUpstream(authRequest, { data: { verifier }, headers });
  const u = new URL(GOOGLE_AUTHORIZE);
  u.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${new URL(request.url).origin}/callback`,
    response_type: "code",
    scope: "openid email",
    state,
    code_challenge: await s256(verifier),
    code_challenge_method: "S256",
    prompt: "select_account",
  }).toString();
  out.set("location", u.toString());
  return new Response(null, { status: 302, headers: out });
}

// GET /callback: back from Google. Check who it is, then hand Claude its code.
async function googleCallback(request: Request, env: Env, oauth: OAuthHelpers): Promise<Response> {
  const url = new URL(request.url);
  const { request: original, data, headers } = await oauth.finishUpstream<{ verifier: string }>(request);
  if (url.searchParams.get("error") || !url.searchParams.get("code")) {
    headers.set("location", authorizationErrorRedirect(original, "access_denied"));
    return new Response(null, { status: 302, headers });
  }
  const cfg = await googleConfig(env);

  const res = await fetch(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      code: url.searchParams.get("code")!,
      client_id: cfg.GOOGLE_CLIENT_ID,
      client_secret: cfg.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${url.origin}/callback`,
      grant_type: "authorization_code",
      code_verifier: data.verifier,
    }),
  });
  if (!res.ok) {
    console.error(`Google token exchange failed: HTTP ${res.status} ${await res.text()}`);
    return page("Sign-in didn't work", "<p>Google didn't accept the sign-in. Go back to Claude and try again.</p>", 502);
  }
  const email = verifiedEmail(((await res.json()) as { id_token?: string }).id_token, cfg.GOOGLE_CLIENT_ID);
  if (!email) {
    return page("Sign-in didn't work", "<p>Google didn't return a verified email for this account.</p>", 400);
  }
  if (!allowedEmails(cfg).has(email)) {
    console.warn(JSON.stringify({ event: "signin_not_allowed", email }));
    return page(
      "This account isn't on the list",
      `<p><strong>${esc(email)}</strong> isn't allowed to use this brain.</p><p>Ask the owner to add it, then connect again. Or try another Google account.</p>`,
      403,
    );
  }

  const { redirectTo } = await oauth.completeAuthorization({
    request: original,
    userId: email,
    metadata: { email },
    scope: [SCOPE],
    props: { email } satisfies Props,
  });
  headers.set("location", redirectTo);
  return new Response(null, { status: 302, headers });
}

/**
 * The ID token came straight from Google's token endpoint over TLS (not from the browser), so per
 * OpenID Connect Core 3.1.3.7 its signature needn't be checked; the claims still are.
 */
export function verifiedEmail(idToken: string | undefined, clientId: string, now = Date.now()): string | null {
  if (!idToken) return null;
  try {
    const claims = JSON.parse(new TextDecoder().decode(fromBase64url(idToken.split(".")[1] ?? ""))) as Record<string, unknown>;
    const issOk = claims.iss === "https://accounts.google.com" || claims.iss === "accounts.google.com";
    const audOk = claims.aud === clientId || (Array.isArray(claims.aud) && claims.aud.includes(clientId));
    const fresh = typeof claims.exp === "number" && claims.exp * 1000 > now;
    if (!issOk || !audOk || !fresh || claims.email_verified !== true || typeof claims.email !== "string") return null;
    return claims.email.toLowerCase();
  } catch {
    return null;
  }
}

function consentPage(d: ConsentDescription, handle: string): string {
  const who = d.clientDomain
    ? `<strong>${esc(d.clientName)}</strong> (${esc(d.clientDomain)})`
    : `<strong>${esc(d.clientName)}</strong>`;
  const local = d.redirectIsLoopback
    ? `<p class="warn">This sends access to an app on your computer. Continue only if you just started connecting from it.</p>`
    : "";
  return html(
    "Connect your brain",
    `<h1>Connect your brain</h1>
<p>${who} wants to use your door brain: log doors, save KPIs and notes, and search them.</p>
<p class="small">Access goes to <strong>${esc(d.redirectHost)}</strong>.</p>
${local}
<form method="post">
  <input type="hidden" name="handle" value="${esc(handle)}">
  <button name="decision" value="approve" class="primary">Continue with Google</button>
  <button name="decision" value="deny" class="secondary">Cancel</button>
</form>`,
  );
}

function page(title: string, body: string, status: number): Response {
  return new Response(html(title, `<h1>${esc(title)}</h1>${body}`), {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "x-frame-options": "DENY", "cache-control": "no-store" },
  });
}

function html(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { color-scheme: light dark; --bg: #f6f7f9; --card: #fff; --text: #1b1f24; --muted: #5b636e; --accent: #1a73e8; --line: #d8dde3; }
  @media (prefers-color-scheme: dark) { :root { --bg: #111418; --card: #1b1f24; --text: #e8eaed; --muted: #a3abb5; --accent: #8ab4f8; --line: #333a42; } }
  body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.5 system-ui, -apple-system, sans-serif; }
  main { max-width: 420px; margin: 12vh auto; padding: 28px 24px; background: var(--card); border: 1px solid var(--line); border-radius: 14px; }
  h1 { font-size: 22px; margin: 0 0 12px; }
  .small { color: var(--muted); font-size: 14px; }
  .warn { color: #b3261e; font-size: 14px; }
  form { display: grid; gap: 10px; margin-top: 20px; }
  button { font: inherit; padding: 12px; border-radius: 10px; cursor: pointer; }
  .primary { background: var(--accent); color: #fff; border: 0; font-weight: 600; }
  @media (prefers-color-scheme: dark) { .primary { color: #111418; } }
  .secondary { background: transparent; color: var(--text); border: 1px solid var(--line); }
</style></head><body><main>${body}</main></body></html>`;
}

const esc = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "="));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

async function s256(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

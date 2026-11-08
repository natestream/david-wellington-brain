import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { resetKeyCache } from "../src/lib/keystore";
import { GOOGLE_TOKEN, verifiedEmail } from "../src/oauth";
import { makeCtx, makeEnv, type TestEnv } from "./fakes";

const ORIGIN = "https://brain.example";
const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const GOOGLE_ID = "google-client-id.apps.googleusercontent.com";

function oauthEnv(allowed = "david@example.com, nate@example.com"): TestEnv {
  return {
    ...makeEnv("brain-key-at-least-32-characters-long-xx"),
    GOOGLE_CLIENT_ID: GOOGLE_ID,
    GOOGLE_CLIENT_SECRET: "google-secret",
    ALLOWED_EMAILS: allowed,
  };
}

/** A browser: keeps cookies between requests, like the sign-in popup Claude opens. */
class Browser {
  jar = new Map<string, string>();
  constructor(private env: TestEnv) {}
  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.jar.size) headers.set("cookie", [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "));
    const res = await worker.fetch(new Request(new URL(path, ORIGIN), { ...init, headers, redirect: "manual" }), this.env, makeCtx());
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(";");
      const [name, ...v] = pair!.split("=");
      const gone = attrs.some((a) => /max-age=0/i.test(a.trim()));
      if (gone) this.jar.delete(name!.trim());
      else this.jar.set(name!.trim(), v.join("="));
    }
    return res;
  }
}

function idToken(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "RS256" })}.${b64(claims)}.sig`;
}

/** Google's token endpoint answers with an ID token for `email`. Other fetches fail loudly. */
function fakeGoogle(email: string, extra: Record<string, unknown> = {}) {
  const calls: URLSearchParams[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url) !== GOOGLE_TOKEN) throw new Error(`unexpected fetch ${url}`);
      calls.push(new URLSearchParams(String(init?.body)));
      const exp = Math.floor(Date.now() / 1000) + 3600;
      return Response.json({
        access_token: "g",
        id_token: idToken({ iss: "https://accounts.google.com", aud: GOOGLE_ID, email, email_verified: true, exp, ...extra }),
      });
    }),
  );
  return calls;
}

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  return { verifier, challenge };
}

async function register(browser: Browser): Promise<string> {
  const reg = await browser.fetch("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Claude",
      redirect_uris: [CLAUDE_CALLBACK],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  expect(reg.status).toBe(201);
  return ((await reg.json()) as { client_id: string }).client_id;
}

/** Claude's side: register (once), then open /authorize in the browser. Returns the consent page. */
async function startSignIn(browser: Browser, existingClientId?: string, minimal = false) {
  const clientId = existingClientId ?? (await register(browser));
  const { verifier, challenge } = await pkce();
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: CLAUDE_CALLBACK,
    state: "claude-state",
    code_challenge: challenge,
    code_challenge_method: "S256",
    ...(minimal ? {} : { scope: "brain", resource: `${ORIGIN}/mcp` }),
  });
  const consent = await browser.fetch(`/authorize?${q}`);
  return { clientId, verifier, consent };
}

async function approve(browser: Browser, consent: Response) {
  const html = await consent.text();
  const handle = html.match(/name="handle" value="([^"]+)"/)![1]!;
  return browser.fetch("/authorize", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ handle, decision: "approve" }),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetKeyCache();
});

describe("Google sign-in for the Claude connector (#25)", () => {
  it("tells Claude where to sign in: 401 with resource metadata pointing at this server", async () => {
    const env = oauthEnv();
    const res = await worker.fetch(new Request(`${ORIGIN}/mcp`, { method: "POST", body: "{}" }), env, makeCtx());
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("resource_metadata=");
    const meta = await worker.fetch(new Request(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`), env, makeCtx());
    expect(meta.status).toBe(200);
    expect(await meta.json()).toMatchObject({ resource: `${ORIGIN}/mcp`, authorization_servers: [ORIGIN] });
    const as = await worker.fetch(new Request(`${ORIGIN}/.well-known/oauth-authorization-server`), env, makeCtx());
    expect(await as.json()).toMatchObject({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/authorize`,
      token_endpoint: `${ORIGIN}/oauth/token`,
      registration_endpoint: `${ORIGIN}/oauth/register`,
    });
  });

  it("full flow: register → consent → Google → token → tools work", async () => {
    const env = oauthEnv();
    const browser = new Browser(env);
    const googleCalls = fakeGoogle("David@Example.com");

    const { clientId, verifier, consent } = await startSignIn(browser);
    expect(consent.status).toBe(200);
    const page = await consent.clone().text();
    expect(page).toContain("Continue with Google");
    expect(page).toContain("claude.ai");
    expect(consent.headers.get("x-frame-options")).toBe("DENY");

    const toGoogle = await approve(browser, consent);
    expect(toGoogle.status).toBe(302);
    const g = new URL(toGoogle.headers.get("location")!);
    expect(g.origin + g.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(g.searchParams.get("client_id")).toBe(GOOGLE_ID);
    expect(g.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/callback`);
    expect(g.searchParams.get("scope")).toBe("openid email");
    expect(g.searchParams.get("code_challenge_method")).toBe("S256");

    const back = await browser.fetch(`/callback?code=google-code&state=${encodeURIComponent(g.searchParams.get("state")!)}`);
    expect(back.status).toBe(302);
    const toClaude = new URL(back.headers.get("location")!);
    expect(toClaude.origin + toClaude.pathname).toBe(CLAUDE_CALLBACK);
    expect(toClaude.searchParams.get("state")).toBe("claude-state");
    expect(googleCalls[0]!.get("code")).toBe("google-code");
    expect(googleCalls[0]!.get("code_verifier")).toBeTruthy();

    const tokenRes = await browser.fetch("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: toClaude.searchParams.get("code")!,
        redirect_uri: CLAUDE_CALLBACK,
        client_id: clientId,
        code_verifier: verifier,
        resource: `${ORIGIN}/mcp`,
      }),
    });
    expect(tokenRes.status).toBe(200);
    const tokens = (await tokenRes.json()) as { access_token: string; refresh_token?: string };
    expect(tokens.refresh_token).toBeTruthy(); // stays signed in

    const list = await worker.fetch(
      new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokens.access_token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
      env,
      makeCtx(),
    );
    expect(list.status).toBe(200);
    const body = (await list.json()) as { result: { tools: { name: string }[] } };
    expect(body.result.tools.map((t) => t.name)).toContain("log_door");

    // Taken off the list in Doppler → locked out on the next request, same token.
    env.ALLOWED_EMAILS = "nate@example.com";
    const after = await worker.fetch(
      new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${tokens.access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      }),
      env,
      makeCtx(),
    );
    expect(after.status).toBe(403);
  });

  it("works when the client sends no scope and no resource", async () => {
    const env = oauthEnv();
    const browser = new Browser(env);
    fakeGoogle("nate@example.com");
    const { clientId, verifier, consent } = await startSignIn(browser, undefined, true);
    expect(consent.status).toBe(200);
    const toGoogle = await approve(browser, consent);
    const state = new URL(toGoogle.headers.get("location")!).searchParams.get("state")!;
    const back = await browser.fetch(`/callback?code=c&state=${encodeURIComponent(state)}`);
    expect(back.status).toBe(302);
    const code = new URL(back.headers.get("location")!).searchParams.get("code")!;
    const tokenRes = await browser.fetch("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: CLAUDE_CALLBACK, client_id: clientId, code_verifier: verifier }),
    });
    expect(tokenRes.status).toBe(200);
    const { access_token } = (await tokenRes.json()) as { access_token: string };
    const list = await worker.fetch(
      new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
      env,
      makeCtx(),
    );
    expect(list.status).toBe(200);
  });

  it("a Google account that isn't on the list gets a clear page, and no code", async () => {
    const env = oauthEnv("david@example.com");
    const browser = new Browser(env);
    fakeGoogle("stranger@gmail.com");
    const { consent } = await startSignIn(browser);
    const toGoogle = await approve(browser, consent);
    const state = new URL(toGoogle.headers.get("location")!).searchParams.get("state")!;
    const back = await browser.fetch(`/callback?code=c&state=${encodeURIComponent(state)}`);
    expect(back.status).toBe(403);
    expect(await back.text()).toContain("stranger@gmail.com");
  });

  it("Cancel sends Claude access_denied", async () => {
    const env = oauthEnv();
    const browser = new Browser(env);
    const { consent } = await startSignIn(browser);
    const handle = (await consent.text()).match(/name="handle" value="([^"]+)"/)![1]!;
    const res = await browser.fetch("/authorize", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ handle, decision: "deny" }),
    });
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get("location")!);
    expect(to.origin + to.pathname).toBe(CLAUDE_CALLBACK);
    expect(to.searchParams.get("error")).toBe("access_denied");
  });

  it("remembers the approval: the next sign-in goes straight to Google", async () => {
    const env = oauthEnv();
    const browser = new Browser(env);
    const first = await startSignIn(browser);
    await approve(browser, first.consent);
    const second = await startSignIn(browser, first.clientId); // Claude reuses its registration
    expect(second.consent.status).toBe(302);
    expect(second.consent.headers.get("location")).toContain("accounts.google.com");
  });

  it("explains, instead of failing silently, when Google isn't set up in Doppler yet", async () => {
    const env = makeEnv(); // no GOOGLE_CLIENT_ID / SECRET
    const browser = new Browser(env);
    const { consent } = await startSignIn(browser);
    expect(consent.status).toBe(500);
    expect(await consent.text()).toContain("GOOGLE_CLIENT_ID");
  });
});

describe("verifiedEmail", () => {
  const exp = Math.floor(Date.now() / 1000) + 600;
  const base = { iss: "https://accounts.google.com", aud: GOOGLE_ID, email: "A@B.com", email_verified: true, exp };
  it("returns the lowercased email for a valid token", () => {
    expect(verifiedEmail(idToken(base), GOOGLE_ID)).toBe("a@b.com");
  });
  it.each([
    ["wrong audience", { aud: "someone-else" }],
    ["wrong issuer", { iss: "https://evil.example" }],
    ["unverified email", { email_verified: false }],
    ["expired", { exp: 1 }],
    ["no email", { email: undefined }],
  ])("rejects %s", (_label, change) => {
    expect(verifiedEmail(idToken({ ...base, ...change }), GOOGLE_ID)).toBeNull();
  });
  it("rejects garbage", () => {
    expect(verifiedEmail("not-a-jwt", GOOGLE_ID)).toBeNull();
    expect(verifiedEmail(undefined, GOOGLE_ID)).toBeNull();
  });
});

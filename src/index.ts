import { handleImport } from "./admin";
import type { Env } from "./env";
import { isAuthorized, unauthorized } from "./lib/auth";
import { getBrainKey } from "./lib/keystore";
import { handleMcp } from "./mcp";
import { oauthProvider } from "./oauth";

/**
 * Two ways in:
 * - Claude's connector: Google sign-in (OAuth, src/oauth.ts). /mcp needs the token it issues.
 * - Scripts (smoke test, import): the `x-api-key` header with BRAIN_KEY, on /mcp and /admin/import.
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/" && request.method === "GET") {
      return new Response(
        "David Wellington Brain is running.\nIn Claude: Settings → Connectors → Add custom connector → " +
          `${url.origin}/mcp → Connect, then sign in with Google.\n`,
        { headers: { "content-type": "text/plain; charset=utf-8" } },
      );
    }

    const scriptCall =
      url.pathname === "/admin/import" || (url.pathname === "/mcp" && request.headers.has("x-api-key"));
    if (scriptCall) {
      const brainKey = await getBrainKey(env);
      if (!brainKey.ok) return new Response(`${brainKey.error}\n`, { status: brainKey.status });
      if (!(await isAuthorized(request, brainKey.key))) return unauthorized();
      return url.pathname === "/mcp" ? handleMcp(request, env) : handleImport(request, env);
    }

    return oauthProvider(url.origin).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;

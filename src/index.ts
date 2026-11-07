import { handleImport } from "./admin";
import type { Env } from "./env";
import { isAuthorized, unauthorized } from "./lib/auth";
import { today } from "./lib/dates";
import { handleMcp } from "./mcp";
import { rotorEnabled, syncRotorDay } from "./tools/rotor";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === "/" && request.method === "GET") {
      return new Response("David Wellington Brain is running. MCP endpoint: /mcp\n", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    if (pathname === "/mcp" || pathname === "/admin/import") {
      if (!env.BRAIN_KEY) {
        return new Response("Server not configured: set the BRAIN_KEY secret.\n", { status: 500 });
      }
      if (!(await isAuthorized(request, env.BRAIN_KEY))) return unauthorized();
      return pathname === "/mcp" ? handleMcp(request, env) : handleImport(request, env);
    }

    return new Response("Not found\n", { status: 404 });
  },

  /**
   * Nightly Rotor sync (wrangler.jsonc "triggers"). Runs at 05:30 UTC, which is
   * 9:30 pm (PST) or 10:30 pm (PDT) in Los Angeles, and saves that LA day.
   * Does nothing until the ROTOR_API_KEY and ROTOR_REP_EMAIL secrets are set.
   */
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (!rotorEnabled(env)) return;
    const date = today(new Date(controller.scheduledTime));
    ctx.waitUntil(
      syncRotorDay(env, { date }).then(
        (r) => console.log(`Rotor sync ${date}: ${r.rotor.requests_used} requests`, r.warnings ?? []),
        (err) => console.error(`Rotor sync ${date} failed:`, err instanceof Error ? err.message : err),
      ),
    );
  },
} satisfies ExportedHandler<Env>;

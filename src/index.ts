import { handleImport } from "./admin";
import type { Env } from "./env";
import { isAuthorized, unauthorized } from "./lib/auth";
import { getBrainKey } from "./lib/keystore";
import { handleMcp } from "./mcp";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === "/" && request.method === "GET") {
      return new Response("David Wellington Brain is running. MCP endpoint: /mcp\n", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    if (pathname === "/mcp" || pathname === "/admin/import") {
      const brainKey = await getBrainKey(env);
      if (!brainKey.ok) return new Response(`${brainKey.error}\n`, { status: brainKey.status });
      if (!(await isAuthorized(request, brainKey.key))) return unauthorized();
      return pathname === "/mcp" ? handleMcp(request, env) : handleImport(request, env);
    }

    return new Response("Not found\n", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

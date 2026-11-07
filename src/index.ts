import { handleImport } from "./admin";
import type { Env } from "./env";
import { isAuthorized, unauthorized } from "./lib/auth";
import { handleMcp } from "./mcp";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === "/" && request.method === "GET") {
      return new Response("David Wellington Brain is running. MCP endpoint: /mcp\n", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    // /mcp/<key>: the key in the path, for connectors that can't send a header.
    const pathKeyMatch = pathname.match(/^\/mcp\/([^/]+)\/?$/);
    const isMcp = pathname === "/mcp" || pathKeyMatch !== null;

    if (isMcp || pathname === "/admin/import") {
      if (!env.BRAIN_KEY) {
        return new Response("Server not configured: set the BRAIN_KEY secret.\n", { status: 500 });
      }
      const pathKey = pathKeyMatch ? decodeURIComponent(pathKeyMatch[1]!) : undefined;
      if (!(await isAuthorized(request, env.BRAIN_KEY, pathKey))) return unauthorized();
      return isMcp ? handleMcp(request, env) : handleImport(request, env);
    }

    return new Response("Not found\n", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

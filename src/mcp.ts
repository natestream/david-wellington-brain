import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Env } from "./env";
import { registerDoorTools } from "./tools/doors";
import { registerKpiTools } from "./tools/kpis";
import { registerNoteTools } from "./tools/notes";

export const SERVER_INSTRUCTIONS = `This is David Wellington's second brain for his door-to-door window cleaning business. He uses it from his phone, usually between doors, so keep replies short.

- After each door he describes: call log_door (one call per door), then coach him in 1-2 sentences.
- When he drops in his end-of-day CRM report (Rotor, usually a PDF or screenshot): read it, call save_daily_kpis with the numbers.
- "How did I do?": get_kpis. "What objections / what works?": objection_stats.
- Anything else worth keeping: save_note. Questions about what he knows or has saved: ask_brain.

Dates are Los Angeles time. You do the thinking (coaching, reading PDFs, summarizing); the tools only store, search and count.`;

export function createServer(env: Env): McpServer {
  const server = new McpServer(
    { name: "david-wellington-brain", version: "0.1.0" },
    { instructions: SERVER_INSTRUCTIONS },
  );
  registerDoorTools(server, env);
  registerKpiTools(server, env);
  registerNoteTools(server, env);
  return server;
}

/**
 * Stateless Streamable HTTP: a fresh server and transport per request, JSON responses.
 * Nothing is kept in memory between requests, which is what a Worker wants.
 */
export async function handleMcp(request: Request, env: Env): Promise<Response> {
  const server = createServer(env);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    // Responses are JSON (not streamed), so the body is complete by now.
    void server.close();
  }
}

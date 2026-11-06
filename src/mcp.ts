import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Env } from "./env";
import { registerDoorTools } from "./tools/doors";
import { registerKpiTools } from "./tools/kpis";
import { registerNoteTools } from "./tools/notes";
import { registerRotorTools, rotorEnabled } from "./tools/rotor";

export const SERVER_INSTRUCTIONS = `This is David Wellington's second brain for his door-to-door window cleaning business. He uses it from his phone, usually between doors, so keep replies short.

- After each door he describes: call log_door (one call per door), then coach him in 1-2 sentences.
- When he drops in his Rotor pin export ("New Pins by Team Member"): call save_daily_kpis with his own row (ignore teammates' rows for now), and ask for hours knocked and ARR sold if he didn't give them.
- "How did I do?": get_kpis (his 6 KPIs). "What objections / what works?": objection_stats.
- Anything else worth keeping: save_note. Questions about what he knows or has saved: ask_brain.

Dates are Los Angeles time. You do the thinking (coaching, reading PDFs, summarizing); the tools only store, search and count.`;

export const ROTOR_INSTRUCTIONS = `Rotor sync is on: his day's pins, sales hours and plans sold sync from Rotor automatically every night, and sync_rotor_day pulls them on demand. He doesn't need to drop in the pin export; if he does, save_daily_kpis still works.`;

export function createServer(env: Env): McpServer {
  const server = new McpServer(
    { name: "david-wellington-brain", version: "0.2.0" },
    { instructions: rotorEnabled(env) ? `${SERVER_INSTRUCTIONS}\n\n${ROTOR_INSTRUCTIONS}` : SERVER_INSTRUCTIONS },
  );
  registerDoorTools(server, env);
  registerKpiTools(server, env);
  registerNoteTools(server, env);
  registerRotorTools(server, env);
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

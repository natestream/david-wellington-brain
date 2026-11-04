import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** Return a JSON payload as an MCP tool result. Claude reads the JSON and does the talking. */
export function ok(payload: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

export function fail(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

/** Run a tool body and turn thrown errors into a readable tool error instead of a 500. */
export async function guard(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(`Error: ${message}`);
  }
}

/** a / b, rounded, or null when b is 0 or either side is missing. */
export function rate(a: number | null | undefined, b: number | null | undefined, digits = 3): number | null {
  if (a == null || b == null || b === 0) return null;
  const f = 10 ** digits;
  return Math.round((a / b) * f) / f;
}

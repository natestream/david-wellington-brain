import worker from "../src/index";
import type { Env } from "../src/env";

let nextId = 1;

/** Send one JSON-RPC request to the Worker's /mcp endpoint, the way Claude's connector does. */
export async function rpc(env: Env, method: string, params: unknown = {}, headers: Record<string, string> = {}) {
  const res = await worker.fetch(
    new Request("https://brain.example/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "x-api-key": env.BRAIN_KEY ?? "",
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
    }),
    env,
  );
  return res;
}

/** Call a tool and return its parsed JSON payload. Throws if the tool returned an error. */
export async function callTool<T = any>(env: Env, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const res = await rpc(env, "tools/call", { name, arguments: args });
  if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as any;
  if (body.error) throw new Error(`RPC error: ${JSON.stringify(body.error)}`);
  const result = body.result;
  const text = result.content?.[0]?.text ?? "";
  if (result.isError) throw new Error(`Tool error: ${text}`);
  return JSON.parse(text) as T;
}

/** Call a tool expecting it to fail; returns the error text. */
export async function callToolError(env: Env, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const res = await rpc(env, "tools/call", { name, arguments: args });
  const body = (await res.json()) as any;
  if (body.error) return JSON.stringify(body.error);
  if (!body.result?.isError) throw new Error(`expected an error, got ${JSON.stringify(body.result)}`);
  return body.result.content?.[0]?.text ?? "";
}

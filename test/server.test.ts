import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { makeCtx, makeEnv } from "./fakes";
import { rpc } from "./mcp-client";

const TOOLS = ["ask_brain", "get_kpis", "log_door", "objection_stats", "save_daily_kpis", "save_note"];

describe("auth (#2)", () => {
  it("rejects a request with no header with a real 401", async () => {
    const env = makeEnv();
    const res = await rpc(env, "tools/list", {}, { "x-api-key": "" });
    expect(res.status).toBe(401);
  });

  it("rejects a wrong key", async () => {
    const env = makeEnv();
    const res = await rpc(env, "tools/list", {}, { "x-api-key": "nope" });
    expect(res.status).toBe(401);
    // A www-authenticate header would make Claude try OAuth, which this server doesn't offer.
    expect(res.headers.get("www-authenticate")).toBeNull();
  });

  it("never accepts the key as a query param", async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      new Request(`https://brain.example/mcp?key=${env.BRAIN_KEY}`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
      env,
      makeCtx(),
    );
    expect(res.status).toBe(401);
  });

  const listReq = (url: string, headers: Record<string, string> = {}) =>
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

  it("never accepts BRAIN_KEY as a Bearer token: Bearer means a Google sign-in token now (#25)", async () => {
    const env = makeEnv();
    const res = await worker.fetch(listReq("https://brain.example/mcp", { authorization: `Bearer ${env.BRAIN_KEY}` }), env, makeCtx());
    expect(res.status).toBe(401);
  });

  it("never accepts the key in the path", async () => {
    const env = makeEnv();
    const res = await worker.fetch(listReq(`https://brain.example/mcp/${env.BRAIN_KEY}`), env, makeCtx());
    expect(res.status).not.toBe(200);
  });

  it("logs why a request was refused, without logging any key", async () => {
    const env = makeEnv("the-real-key");
    const logs: string[] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation((m: string) => void logs.push(m));
    try {
      await rpc(env, "tools/list", {}, { "x-api-key": "" });
      await rpc(env, "tools/list", {}, { "x-api-key": '"wrong key"' });
    } finally {
      spy.mockRestore();
    }
    const [none, wrong] = logs.map((l) => JSON.parse(l));
    expect(none).toMatchObject({ event: "auth_failed", reason: "no_key_header", path: "/mcp" });
    expect(wrong).toMatchObject({ reason: "wrong_key", sent: { length: 11, has_quotes: true, has_spaces: true } });
    expect(wrong.expected.length).toBe(12);
    expect(wrong.sent.sha256_8).not.toBe(wrong.expected.sha256_8);
    expect(logs.join("")).not.toContain("the-real-key");
    expect(logs.join("")).not.toContain("wrong key");
  });

  it("protects /admin/import too", async () => {
    const env = makeEnv();
    const res = await worker.fetch(new Request("https://brain.example/admin/import", { method: "POST", body: "{}" }), env, makeCtx());
    expect(res.status).toBe(401);
  });

  it("refuses everything when BRAIN_KEY is not set", async () => {
    const env = makeEnv("");
    const res = await rpc(env, "tools/list", {}, { "x-api-key": "" });
    expect(res.status).toBe(500);
  });

  it("serves a plain health page at / and 404 elsewhere", async () => {
    const env = makeEnv();
    expect((await worker.fetch(new Request("https://brain.example/"), env, makeCtx())).status).toBe(200);
    expect((await worker.fetch(new Request("https://brain.example/nope"), env, makeCtx())).status).toBe(404);
  });
});

describe("MCP endpoint (#2)", () => {
  it("initializes and announces instructions", async () => {
    const env = makeEnv();
    const res = await rpc(env, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.result.serverInfo.name).toBe("david-wellington-brain");
    expect(body.result.instructions).toContain("log_door");
  });

  it("lists exactly the six tools, each with a description and input schema", async () => {
    const env = makeEnv();
    const res = await rpc(env, "tools/list");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    const tools = body.result.tools as any[];
    expect(tools.map((t) => t.name).sort()).toEqual(TOOLS);
    for (const t of tools) {
      expect(t.description.length).toBeGreaterThan(100);
      expect(t.inputSchema.type).toBe("object");
    }
    const logDoor = tools.find((t) => t.name === "log_door");
    expect(logDoor.inputSchema.required).toEqual(["outcome"]);
  });
});

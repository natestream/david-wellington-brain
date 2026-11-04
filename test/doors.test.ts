import { describe, expect, it } from "vitest";
import { today } from "../src/lib/dates";
import { makeEnv } from "./fakes";
import { callTool, callToolError } from "./mcp-client";

describe("log_door (#4)", () => {
  it("saves a door with defaults (rep david, today in LA)", async () => {
    const env = makeEnv();
    const out = await callTool(env, "log_door", { outcome: "no_answer", area: "Main St" });
    expect(out.saved).toBe(true);
    expect(out.rep).toBe("david");
    expect(out.date).toBe(today());
    expect(out.doors_logged_today).toBe(1);
    const row = await env.DB.prepare("SELECT * FROM doors WHERE id = ?").bind(out.id).first<any>();
    expect(row.area).toBe("Main St");
    expect(row.outcome).toBe("no_answer");
  });

  it("doesn't spend an embedding on a door where nothing was said", async () => {
    const env = makeEnv();
    const out = await callTool(env, "log_door", { outcome: "no_answer" });
    expect(env.AI.calls).toBe(0);
    expect(env.VECTORS.vectors.size).toBe(0);
    expect(out.similar_doors).toEqual([]);
  });

  it("uses one embedding per door and returns similar past doors with outcomes", async () => {
    const env = makeEnv();
    await callTool(env, "log_door", {
      outcome: "closed",
      objection_type: "price",
      objection_text: "too expensive for us right now",
      response: "offered a smaller first job, just the front windows",
      amount: 120,
      date: "2026-11-02",
    });
    await callTool(env, "log_door", {
      outcome: "not_interested",
      objection_type: "has_someone",
      objection_text: "we already have a guy who does our windows",
      response: "left a card",
      date: "2026-11-02",
    });
    const before = env.AI.calls;
    const out = await callTool(env, "log_door", {
      outcome: "quoted",
      objection_type: "price",
      objection_text: "that's too expensive",
      response: "offered a smaller first job",
      coaching: "Nice pivot to a smaller job.",
    });
    expect(env.AI.calls - before).toBe(1);
    expect(out.similar_doors.length).toBe(2);
    expect(out.similar_doors[0]).toMatchObject({ outcome: "closed", objection_type: "price", date: "2026-11-02" });
    expect(out.similar_doors[0].similarity).toBeGreaterThan(out.similar_doors[1].similarity);
    // The door just saved is never its own "similar door".
    expect(out.similar_doors.map((d: any) => d.outcome)).not.toContain("quoted");
    // History for this objection excludes the door just saved.
    expect(out.objection_history).toMatchObject({ objection_type: "price", count: 1, closed: 1, close_rate: 1 });
    expect(out.objection_history.responses_that_closed[0].response).toContain("smaller first job");
  });

  it("stores the coaching Claude wrote", async () => {
    const env = makeEnv();
    const out = await callTool(env, "log_door", { outcome: "pitched", notes: "nice house", coaching: "Ask for the close." });
    const row = await env.DB.prepare("SELECT coaching FROM doors WHERE id = ?").bind(out.id).first<any>();
    expect(row.coaching).toBe("Ask for the close.");
  });

  it("backfills a past date", async () => {
    const env = makeEnv();
    const out = await callTool(env, "log_door", { outcome: "callback", notes: "come back Friday", date: "2026-11-05" });
    expect(out.date).toBe("2026-11-05");
  });

  it("rejects an unknown outcome and a bad date", async () => {
    const env = makeEnv();
    expect(await callToolError(env, "log_door", { outcome: "maybe" })).toMatch(/outcome/i);
    expect(await callToolError(env, "log_door", { outcome: "closed", date: "2026-13-40" })).toMatch(/date/i);
  });

  it("keeps rows per rep", async () => {
    const env = makeEnv();
    const out = await callTool(env, "log_door", { outcome: "closed", rep: "jake", amount: 200 });
    expect(out.rep).toBe("jake");
  });
});

describe("objection_stats (#7)", () => {
  async function seed() {
    const env = makeEnv();
    const doors = [
      { outcome: "closed", objection_type: "price", response: "smaller first job", date: "2026-11-01", amount: 100 },
      { outcome: "closed", objection_type: "price", response: "bundle with screens", date: "2026-11-02", amount: 250 },
      { outcome: "not_interested", objection_type: "price", response: "left card", date: "2026-11-02" },
      { outcome: "closed", objection_type: "price", response: "first-time discount", date: "2026-11-03", amount: 150 },
      { outcome: "closed", objection_type: "price", response: "split into two visits", date: "2026-11-04", amount: 90 },
      { outcome: "not_interested", objection_type: "has_someone", response: "left card", date: "2026-11-03" },
      { outcome: "callback", objection_type: "spouse", response: "come back at 6", date: "2026-11-03" },
      { outcome: "closed", objection_type: "price", response: "jake's line", date: "2026-11-04", rep: "jake" },
      { outcome: "no_answer", date: "2026-11-04" },
    ];
    for (const d of doors) await callTool(env, "log_door", d);
    return env;
  }

  it("counts objections, close rate and the 3 most recent closing responses", async () => {
    const env = await seed();
    const out = await callTool(env, "objection_stats", { rep: "david" });
    expect(out.doors_with_objection).toBe(7);
    const price = out.objections[0];
    expect(price).toMatchObject({ objection_type: "price", count: 5, closed: 4, close_rate: 0.8, closed_revenue: 590 });
    expect(price.responses_that_closed.map((r: any) => r.response)).toEqual([
      "split into two visits",
      "first-time discount",
      "bundle with screens",
    ]);
    const hasSomeone = out.objections.find((o: any) => o.objection_type === "has_someone");
    expect(hasSomeone).toMatchObject({ count: 1, closed: 0, close_rate: 0, responses_that_closed: [] });
  });

  it("filters by date range and includes every rep by default", async () => {
    const env = await seed();
    const out = await callTool(env, "objection_stats", { from: "2026-11-04", to: "2026-11-04" });
    expect(out.rep).toBe("all");
    expect(out.objections).toEqual([
      expect.objectContaining({ objection_type: "price", count: 2, closed: 2 }),
    ]);
  });

  it("returns an empty list with no data", async () => {
    const env = makeEnv();
    const out = await callTool(env, "objection_stats", {});
    expect(out.objections).toEqual([]);
    expect(out.doors_with_objection).toBe(0);
  });
});

describe("log_door when embeddings are down", () => {
  it("still saves the door once and returns a warning instead of an error", async () => {
    const env = makeEnv();
    env.AI.run = async () => {
      throw new Error("Workers AI quota exceeded");
    };
    const out = await callTool(env, "log_door", { outcome: "closed", objection_type: "price", objection_text: "too much" });
    expect(out.saved).toBe(true);
    expect(out.similar_doors).toEqual([]);
    expect(out.search_warning).toMatch(/Do not log this door again/);
    const { results } = await env.DB.prepare("SELECT id FROM doors").all();
    expect(results.length).toBe(1);
  });
});

import { describe, expect, it } from "vitest";
import { makeEnv } from "./fakes";
import { callTool, callToolError } from "./mcp-client";

const DAY = {
  date: "2026-11-04",
  doors_knocked: 62,
  contacts: 31,
  pitches: 20,
  quotes: 9,
  closes: 5,
  revenue: 875,
  hours: 6.5,
  raw_summary: "Wednesday route, Huntington Beach.",
};

describe("save_daily_kpis (#5)", () => {
  it("saves one row with calculated rates", async () => {
    const env = makeEnv();
    const out = await callTool(env, "save_daily_kpis", DAY);
    expect(out.saved).toMatchObject({ rep: "david", date: "2026-11-04", doors_knocked: 62, source: "pdf" });
    expect(out.rates).toEqual({
      contact_rate: 0.5,
      close_rate: 0.25,
      revenue_per_door: 14.11,
      avg_ticket: 175,
      revenue_per_hour: 134.62,
    });
  });

  it("replaces the row when the same day is saved again (no duplicate)", async () => {
    const env = makeEnv();
    const first = await callTool(env, "save_daily_kpis", DAY);
    const second = await callTool(env, "save_daily_kpis", { ...DAY, closes: 6, revenue: 1000 });
    const { results } = await env.DB.prepare("SELECT * FROM daily_kpis").all<any>();
    expect(results.length).toBe(1);
    expect(results[0].closes).toBe(6);
    expect(second.saved.id).toBe(first.saved.id);
  });

  it("compares the CRM numbers with the doors logged that day", async () => {
    const env = makeEnv();
    await callTool(env, "log_door", { outcome: "closed", date: "2026-11-04", amount: 175 });
    await callTool(env, "log_door", { outcome: "no_answer", date: "2026-11-04" });
    await callTool(env, "log_door", { outcome: "quoted", date: "2026-11-04" });
    await callTool(env, "log_door", { outcome: "closed", date: "2026-11-03" });
    const out = await callTool(env, "save_daily_kpis", DAY);
    expect(out.logged_vs_crm.summary).toBe("CRM says 62 doors, 3 logged; CRM says 5 closes, 1 logged");
    expect(out.logged_vs_crm.logged).toEqual({ doors: 3, contacts: 2, pitches: 2, quotes: 2, closes: 1 });
    expect(out.logged_vs_crm.unlogged_doors).toBe(59);
  });

  it("keeps extra PDF fields as JSON until the columns are confirmed", async () => {
    const env = makeEnv();
    const out = await callTool(env, "save_daily_kpis", { ...DAY, extra: { cancellations: 1, territory: "HB-3" } });
    expect(out.saved.extra).toEqual({ cancellations: 1, territory: "HB-3" });
  });

  it("allows partial days and returns null rates instead of dividing by zero", async () => {
    const env = makeEnv();
    const out = await callTool(env, "save_daily_kpis", { date: "2026-11-04", doors_knocked: 0, closes: 0, revenue: 0 });
    expect(out.rates).toEqual({ contact_rate: null, close_rate: null, revenue_per_door: null, avg_ticket: null, revenue_per_hour: null });
  });

  it("rejects negative or fractional counts", async () => {
    const env = makeEnv();
    expect(await callToolError(env, "save_daily_kpis", { doors_knocked: -1 })).toMatch(/doors_knocked/);
    expect(await callToolError(env, "save_daily_kpis", { closes: 2.5 })).toMatch(/closes/);
  });
});

describe("get_kpis (#6)", () => {
  async function seedWeek() {
    const env = makeEnv();
    // Mon 2026-11-02 .. Wed 2026-11-04, plus the Sunday before (previous week).
    await callTool(env, "save_daily_kpis", { date: "2026-11-01", doors_knocked: 10, contacts: 5, pitches: 4, closes: 1, revenue: 100, hours: 2 });
    await callTool(env, "save_daily_kpis", { date: "2026-11-02", doors_knocked: 50, contacts: 25, pitches: 10, closes: 2, revenue: 300, hours: 5 });
    await callTool(env, "save_daily_kpis", { date: "2026-11-03", doors_knocked: 40, contacts: 20, pitches: 10, closes: 3, revenue: 450, hours: 5 });
    await callTool(env, "save_daily_kpis", { date: "2026-11-04", doors_knocked: 60, contacts: 30, pitches: 20, closes: 5, revenue: 850, hours: 6 });
    await callTool(env, "save_daily_kpis", { date: "2026-11-04", rep: "jake", doors_knocked: 40, contacts: 10, pitches: 5, closes: 1, revenue: 150, hours: 4 });
    return env;
  }

  it("returns a row per day plus totals and rates for a rep", async () => {
    const env = await seedWeek();
    const out = await callTool(env, "get_kpis", { from: "2026-11-02", to: "2026-11-04", rep: "david" });
    expect(out.rows.map((r: any) => r.period)).toEqual(["2026-11-02", "2026-11-03", "2026-11-04"]);
    expect(out.totals).toMatchObject({ days: 3, doors_knocked: 150, contacts: 75, pitches: 40, closes: 10, revenue: 1600, hours: 16 });
    expect(out.totals.rates).toEqual({
      contact_rate: 0.5,
      close_rate: 0.25,
      revenue_per_door: 10.67,
      avg_ticket: 160,
      revenue_per_hour: 100,
    });
  });

  it("adds up every rep when rep is left out", async () => {
    const env = await seedWeek();
    const out = await callTool(env, "get_kpis", { from: "2026-11-04", to: "2026-11-04" });
    expect(out.rep).toBe("all");
    expect(out.totals.doors_knocked).toBe(100);
  });

  it("groups by Monday-start week", async () => {
    const env = await seedWeek();
    const out = await callTool(env, "get_kpis", { from: "2026-11-01", to: "2026-11-04", rep: "david", group_by: "week" });
    expect(out.rows.map((r: any) => [r.period, r.days, r.doors_knocked])).toEqual([
      ["2026-10-26", 1, 10],
      ["2026-11-02", 3, 150],
    ]);
  });

  it("returns totals only with group_by none", async () => {
    const env = await seedWeek();
    const out = await callTool(env, "get_kpis", { from: "2026-11-01", to: "2026-11-04", group_by: "none" });
    expect(out.rows).toEqual([]);
    expect(out.totals.doors_knocked).toBe(200);
  });

  it("handles an empty range without dividing by zero", async () => {
    const env = makeEnv();
    const out = await callTool(env, "get_kpis", { from: "2026-01-01", to: "2026-01-07" });
    expect(out.rows).toEqual([]);
    expect(out.totals.days).toBe(0);
    expect(out.totals.rates.close_rate).toBeNull();
    expect(out.note).toMatch(/No KPI rows/);
  });

  it("rejects from after to", async () => {
    const env = makeEnv();
    expect(await callToolError(env, "get_kpis", { from: "2026-11-05", to: "2026-11-01" })).toMatch(/after/);
  });
});

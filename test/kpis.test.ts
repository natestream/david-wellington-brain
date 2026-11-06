import { describe, expect, it } from "vitest";
import { computeKpis } from "../src/tools/kpis";
import { makeEnv } from "./fakes";
import { callTool, callToolError } from "./mcp-client";

// Pin counts from a real Rotor "New Pins by Team Member" export row (David).
// hours_knocked and arr_sold are not on the export; these are example values.
const DAVID = {
  date: "2026-11-05",
  total: 61,
  gave_pitch: 10,
  go_back: 2,
  never_knock: 0,
  door_hanger: 0,
  no_answer: 33,
  not_interested: 14,
  made_sale: 2,
};
const DAVID_REP_INPUTS = { hours_knocked: 5, arr_sold: 1800 };

// A second rep's row from the same export (name left out on purpose).
const REP_B = {
  date: "2026-11-05",
  rep: "rep-b",
  total: 72,
  gave_pitch: 7,
  go_back: 0,
  never_knock: 0,
  door_hanger: 0,
  no_answer: 29,
  not_interested: 36,
  made_sale: 0,
  hours_knocked: 6,
  arr_sold: 0,
};

describe("computeKpis: David's KPI guide", () => {
  it("calculates the subtotals and all 6 KPIs exactly as the guide defines them", () => {
    expect(computeKpis({ ...DAVID, ...DAVID_REP_INPUTS })).toEqual({
      // Adjusted = 61 - 2 go back - 0 never knock - 0 door hanger; Answered = 59 - 33 no answer;
      // Pitches = 10 gave pitch + 2 made sale; Plans sold = 2.
      subtotals: { adjusted_doors: 59, answered: 26, pitches: 12, plans_sold: 2 },
      kpis: {
        doors_per_hour: 11.8, // 59 / 5
        answer_rate: 0.441, // 26 / 59
        backyard_rate: 0.462, // 12 / 26
        conversion_rate: 0.167, // 2 / 12
        revenue_per_hour: 360, // 1800 / 5
        avg_arr_per_plan: 900, // 1800 / 2
      },
    });
  });

  it("returns null instead of dividing by zero", () => {
    const { kpis } = computeKpis(REP_B);
    expect(kpis.conversion_rate).toBe(0); // 0 sales / 7 pitches
    expect(kpis.avg_arr_per_plan).toBeNull(); // 0 plans sold
    expect(computeKpis({ total: 0 }).kpis.answer_rate).toBeNull();
    expect(computeKpis({ ...DAVID }).kpis.doors_per_hour).toBeNull(); // no hours yet
  });
});

describe("save_daily_kpis (#5)", () => {
  it("saves one row with subtotals and KPIs", async () => {
    const env = makeEnv();
    const out = await callTool(env, "save_daily_kpis", { ...DAVID, ...DAVID_REP_INPUTS, raw_summary: "Thursday, two plans sold." });
    expect(out.saved).toMatchObject({ rep: "david", date: "2026-11-05", total: 61, made_sale: 2, hours_knocked: 5, source: "pdf" });
    expect(out.subtotals).toEqual({ adjusted_doors: 59, answered: 26, pitches: 12, plans_sold: 2 });
    expect(out.kpis.backyard_rate).toBe(0.462);
    expect(out.warnings).toBeUndefined();
  });

  it("saves the pins first, asks for hours + ARR, then fills them in without a second row", async () => {
    const env = makeEnv();
    const first = await callTool(env, "save_daily_kpis", DAVID);
    expect(first.kpis.doors_per_hour).toBeNull();
    expect(first.warnings.join(" ")).toMatch(/Missing hours_knocked and arr_sold/);

    const second = await callTool(env, "save_daily_kpis", { date: "2026-11-05", ...DAVID_REP_INPUTS });
    expect(second.saved.id).toBe(first.saved.id);
    expect(second.saved.total).toBe(61); // pins kept
    expect(second.kpis).toMatchObject({ doors_per_hour: 11.8, revenue_per_hour: 360, avg_arr_per_plan: 900 });
    expect(second.warnings).toBeUndefined();

    const { results } = await env.DB.prepare("SELECT * FROM daily_kpis").all();
    expect(results.length).toBe(1);
  });

  it("updates the row when the same day is uploaded again", async () => {
    const env = makeEnv();
    await callTool(env, "save_daily_kpis", { ...DAVID, ...DAVID_REP_INPUTS });
    const again = await callTool(env, "save_daily_kpis", { ...DAVID, total: 63, no_answer: 35 });
    expect(again.saved).toMatchObject({ total: 63, no_answer: 35, hours_knocked: 5 });
    const { results } = await env.DB.prepare("SELECT * FROM daily_kpis").all();
    expect(results.length).toBe(1);
  });

  it("keeps one row per rep from the same export", async () => {
    const env = makeEnv();
    await callTool(env, "save_daily_kpis", { ...DAVID, ...DAVID_REP_INPUTS });
    await callTool(env, "save_daily_kpis", REP_B);
    const { results } = await env.DB.prepare("SELECT rep FROM daily_kpis ORDER BY rep").all<any>();
    expect(results.map((r: any) => r.rep)).toEqual(["david", "rep-b"]);
  });

  it("warns when the pin types don't add up to Total", async () => {
    const env = makeEnv();
    const out = await callTool(env, "save_daily_kpis", { ...DAVID, ...DAVID_REP_INPUTS, total: 60 });
    expect(out.warnings).toEqual(["Pin types add up to 61, but Total is 60. Double-check the numbers."]);
  });

  it("compares the export with the doors logged that day, pin type by pin type", async () => {
    const env = makeEnv();
    await callTool(env, "log_door", { outcome: "made_sale", date: "2026-11-05", amount: 900 });
    await callTool(env, "log_door", { outcome: "no_answer", date: "2026-11-05" });
    await callTool(env, "log_door", { outcome: "gave_pitch", date: "2026-11-05" });
    await callTool(env, "log_door", { outcome: "made_sale", date: "2026-11-04" });
    const out = await callTool(env, "save_daily_kpis", { ...DAVID, ...DAVID_REP_INPUTS });
    expect(out.logged_vs_rotor.summary).toBe("Rotor says 61 pins, 3 doors logged; 2 sales in Rotor, 1 logged");
    expect(out.logged_vs_rotor.logged).toMatchObject({ total: 3, made_sale: 1, no_answer: 1, gave_pitch: 1, go_back: 0 });
    expect(out.logged_vs_rotor.unlogged_doors).toBe(58);
  });

  it("keeps extra numbers as JSON", async () => {
    const env = makeEnv();
    const out = await callTool(env, "save_daily_kpis", { ...DAVID, extra: { two_year_plans: 1 } });
    expect(out.saved.extra).toEqual({ two_year_plans: 1 });
  });

  it("rejects negative or fractional pin counts", async () => {
    const env = makeEnv();
    expect(await callToolError(env, "save_daily_kpis", { total: -1 })).toMatch(/total/);
    expect(await callToolError(env, "save_daily_kpis", { made_sale: 2.5 })).toMatch(/made_sale/);
  });
});

describe("get_kpis (#6)", () => {
  async function seed() {
    const env = makeEnv();
    // Sunday before (previous week), then Wed + Thu.
    await callTool(env, "save_daily_kpis", { date: "2026-11-01", total: 20, gave_pitch: 4, no_answer: 10, not_interested: 5, made_sale: 1, hours_knocked: 2, arr_sold: 800 });
    await callTool(env, "save_daily_kpis", { date: "2026-11-04", total: 50, gave_pitch: 8, go_back: 3, door_hanger: 2, no_answer: 25, not_interested: 11, made_sale: 1, hours_knocked: 4, arr_sold: 960 });
    await callTool(env, "save_daily_kpis", { ...DAVID, ...DAVID_REP_INPUTS });
    await callTool(env, "save_daily_kpis", REP_B);
    return env;
  }

  it("adds up the inputs first, then calculates the KPIs from the totals", async () => {
    const env = await seed();
    const out = await callTool(env, "get_kpis", { from: "2026-11-04", to: "2026-11-05", rep: "david" });
    expect(out.rows.map((r: any) => r.period)).toEqual(["2026-11-04", "2026-11-05"]);
    expect(out.totals).toMatchObject({ days: 2, total: 111, go_back: 5, door_hanger: 2, no_answer: 58, gave_pitch: 18, made_sale: 3, hours_knocked: 9, arr_sold: 2760 });
    // Adjusted = 111 - 5 - 0 - 2 = 104; Answered = 104 - 58 = 46; Pitches = 18 + 3 = 21; Plans = 3.
    expect(out.totals.subtotals).toEqual({ adjusted_doors: 104, answered: 46, pitches: 21, plans_sold: 3 });
    expect(out.totals.kpis).toEqual({
      doors_per_hour: 11.56,
      answer_rate: 0.442,
      backyard_rate: 0.457,
      conversion_rate: 0.143,
      revenue_per_hour: 306.67,
      avg_arr_per_plan: 920,
    });
  });

  it("combines the whole team when rep is left out", async () => {
    const env = await seed();
    const out = await callTool(env, "get_kpis", { from: "2026-11-05", to: "2026-11-05" });
    expect(out.rep).toBe("all");
    expect(out.totals.subtotals).toEqual({ adjusted_doors: 131, answered: 69, pitches: 19, plans_sold: 2 });
    expect(out.totals.kpis).toEqual({
      doors_per_hour: 11.91,
      answer_rate: 0.527,
      backyard_rate: 0.275,
      conversion_rate: 0.105,
      revenue_per_hour: 163.64,
      avg_arr_per_plan: 900,
    });
  });

  it("groups by Monday-start week", async () => {
    const env = await seed();
    const out = await callTool(env, "get_kpis", { from: "2026-11-01", to: "2026-11-05", rep: "david", group_by: "week" });
    expect(out.rows.map((r: any) => [r.period, r.days, r.total])).toEqual([
      ["2026-10-26", 1, 20],
      ["2026-11-02", 2, 111],
    ]);
  });

  it("returns totals only with group_by none", async () => {
    const env = await seed();
    const out = await callTool(env, "get_kpis", { from: "2026-11-01", to: "2026-11-05", group_by: "none" });
    expect(out.rows).toEqual([]);
    expect(out.totals.total).toBe(203);
  });

  it("handles an empty range without dividing by zero", async () => {
    const env = makeEnv();
    const out = await callTool(env, "get_kpis", { from: "2026-01-01", to: "2026-01-07" });
    expect(out.rows).toEqual([]);
    expect(out.totals.days).toBe(0);
    expect(out.totals.kpis.conversion_rate).toBeNull();
    expect(out.note).toMatch(/No KPI rows/);
  });

  it("rejects from after to", async () => {
    const env = makeEnv();
    expect(await callToolError(env, "get_kpis", { from: "2026-11-05", to: "2026-11-01" })).toMatch(/after/);
  });
});

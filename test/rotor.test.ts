import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { laDayRangeUtc } from "../src/lib/dates";
import type { RotorPin, RotorServicePlan, RotorTimesheet } from "../src/lib/rotor";
import { countPins, pinFieldForLabel, planArr, syncRotorDay } from "../src/tools/rotor";
import { makeEnv, type TestEnv } from "./fakes";
import { callTool, rpc } from "./mcp-client";

const DAVID = { user_id: "11111111-1111-4111-8111-111111111111", email: "david@example.com", name: "David" };
const TEAMMATE = { user_id: "22222222-2222-4222-8222-222222222222", email: "rep-b@example.com", name: "Rep B" };

// 2026-11-05 in Los Angeles (PST) is 08:00Z Nov 5 → 08:00Z Nov 6.
const DAY = "2026-11-05";

let n = 0;
function pin(by: typeof DAVID, label: string, createdAt: string): RotorPin {
  n++;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    created_at: createdAt,
    created_by: by,
    pin_type: { id: `type-${label}`, label, color: "#000000" },
    location: [33.66, -118],
  };
}

/** David's real export row for the day: 61 pins. */
const DAVID_COUNTS: Record<string, number> = {
  "Gave Pitch": 10,
  "Go Back": 2,
  "No Answer": 33,
  "Not Interested": 14,
  "Made Sale": 2,
};

function fixtures() {
  n = 0;
  const pins: RotorPin[] = [];
  let minute = 0;
  const at = () => new Date(Date.parse("2026-11-05T17:00:00Z") + minute++ * 60000).toISOString();
  for (const [label, count] of Object.entries(DAVID_COUNTS)) for (let i = 0; i < count; i++) pins.push(pin(DAVID, label, at()));
  for (let i = 0; i < 20; i++) pins.push(pin(TEAMMATE, "No Answer", at()));
  // Just after midnight LA on Nov 6 (belongs to the next day) and the evening before (previous day).
  pins.push(pin(DAVID, "Made Sale", "2026-11-06T08:30:00Z"));
  pins.push(pin(DAVID, "No Answer", "2026-11-05T07:59:00Z"));
  pins.sort((a, b) => b.created_at.localeCompare(a.created_at)); // API order: newest first

  const timesheets: RotorTimesheet[] = [
    { id: "1", created_at: "2026-11-05T16:00:00Z", user: DAVID, category: "sales", start: "2026-11-05T16:00:00Z", end: "2026-11-05T19:00:00Z", duration_minutes: 180 },
    { id: "2", created_at: "2026-11-05T20:00:00Z", user: DAVID, category: "sales", start: "2026-11-05T20:00:00Z", end: "2026-11-05T22:00:00Z", duration_minutes: 120 },
    { id: "3", created_at: "2026-11-05T15:00:00Z", user: DAVID, category: "office", start: "2026-11-05T15:00:00Z", end: "2026-11-05T15:30:00Z", duration_minutes: 30 },
    { id: "4", created_at: "2026-11-05T16:00:00Z", user: TEAMMATE, category: "sales", start: "2026-11-05T16:00:00Z", end: "2026-11-05T22:00:00Z", duration_minutes: 360 },
  ];

  const plan = (over: Partial<RotorServicePlan>): RotorServicePlan => ({
    id: `plan-${Math.random()}`,
    created_at: "2026-11-05T19:00:00Z",
    sold_by: DAVID,
    sale_value: 0,
    service_frequency: "Quarterly",
    start_date: "2026-11-20",
    active: true,
    cancelled: false,
    is_signed: true,
    num_scheduled_jobs: 1,
    num_pending_jobs: 0,
    customer: { id: "c", first_name: "Pat", last_name: "Lee", company_name: null },
    ...over,
  });
  const plans: RotorServicePlan[] = [
    // 2-year quarterly at $150/visit: sale_value is the whole contract ($1,200), ARR is one year ($600).
    plan({ sale_value: 1200, service_frequency: "Quarterly", num_scheduled_jobs: 1, num_pending_jobs: 7 }),
    // Semi-annual, 1 year: ARR is the full $400.
    plan({ sale_value: 400, service_frequency: "Semi-Annual", num_scheduled_jobs: 1, num_pending_jobs: 1, customer: { id: "d", first_name: "Sam", last_name: "Ortiz", company_name: null } }),
    plan({ sale_value: 999, cancelled: true }),
    plan({ sale_value: 500, sold_by: TEAMMATE }),
  ];
  return { pins, timesheets, plans };
}

interface Call {
  url: URL;
  headers: Record<string, string>;
}

function fakeRotor(data = fixtures(), opts: { pageSize?: number; status?: number } = {}) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    calls.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    if (opts.status) {
      return new Response(JSON.stringify({ status: "error", message: "Daily API key request limit of 1000 exceeded", reset_at: "2026-11-07T00:00:00Z" }), {
        status: opts.status,
      });
    }
    const page = Number(url.searchParams.get("page") ?? 1);
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), opts.pageSize ?? 1000);
    let rows: unknown[] = [];
    if (url.pathname.endsWith("/pins")) rows = data.pins;
    else if (url.pathname.endsWith("/timesheets")) {
      const s = Date.parse(url.searchParams.get("start_date")!);
      const e = Date.parse(url.searchParams.get("end_date")!);
      rows = data.timesheets.filter((t) => Date.parse(t.start) >= s && Date.parse(t.start) <= e);
    } else if (url.pathname.endsWith("/service-plans")) {
      const s = Date.parse(url.searchParams.get("created_at_range_start")!);
      const e = Date.parse(url.searchParams.get("created_at_range_end")!);
      rows = data.plans.filter((p) => Date.parse(p.created_at) >= s && Date.parse(p.created_at) <= e);
    } else return new Response("{}", { status: 404 });
    const slice = rows.slice((page - 1) * limit, page * limit);
    return Response.json({ status: "success", data: slice, pagination: { page, limit, total: rows.length, has_more: page * limit < rows.length } });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function rotorEnv(): TestEnv {
  const env = makeEnv();
  env.ROTOR_API_KEY = "rotor_key_secret";
  env.ROTOR_REP_EMAIL = "David@Example.com";
  return env;
}

describe("Rotor helpers", () => {
  it("maps Rotor pin labels to the KPI fields", () => {
    expect(pinFieldForLabel("Gave Pitch")).toBe("gave_pitch");
    expect(pinFieldForLabel("Go-Back")).toBe("go_back");
    expect(pinFieldForLabel("never knock")).toBe("never_knock");
    expect(pinFieldForLabel("Contacted")).toBeNull();
  });

  it("counts unmapped pin types in Total only", () => {
    const c = countPins([pin(DAVID, "Made Sale", DAY), pin(DAVID, "Contacted", DAY)]);
    expect(c.total).toBe(2);
    expect(c.counts.made_sale).toBe(1);
    expect(c.unmapped).toEqual({ Contacted: 1 });
  });

  it("works out ARR as one year of revenue", () => {
    const base = { id: "p", created_at: DAY, sold_by: DAVID, start_date: null, active: true, cancelled: false, is_signed: true, customer: null } as const;
    expect(planArr({ ...base, sale_value: 1200, service_frequency: "Quarterly", num_scheduled_jobs: 2, num_pending_jobs: 6 }).arr).toBe(600);
    expect(planArr({ ...base, sale_value: 300, service_frequency: "Quarterly", num_scheduled_jobs: 1, num_pending_jobs: 1 }).arr).toBe(300);
    expect(planArr({ ...base, sale_value: 250, service_frequency: "One-Time", num_scheduled_jobs: 1, num_pending_jobs: 0 }).arr).toBe(250);
    expect(planArr({ ...base, sale_value: 2400, service_frequency: "Monthly", num_scheduled_jobs: 3, num_pending_jobs: 21 }).arr).toBe(1200);
    expect(planArr({ ...base, sale_value: 500, service_frequency: "Custom", num_scheduled_jobs: 1, num_pending_jobs: 1 }).arr).toBeNull();
  });

  it("finds the UTC range of a Los Angeles day across DST", () => {
    expect(laDayRangeUtc("2026-11-05")).toEqual({ start: new Date("2026-11-05T08:00:00Z"), end: new Date("2026-11-06T08:00:00Z") });
    expect(laDayRangeUtc("2026-07-04")).toEqual({ start: new Date("2026-07-04T07:00:00Z"), end: new Date("2026-07-05T07:00:00Z") });
    // DST ends Nov 1 2026: a 25-hour day.
    expect(laDayRangeUtc("2026-11-01")).toEqual({ start: new Date("2026-11-01T07:00:00Z"), end: new Date("2026-11-02T08:00:00Z") });
  });
});

describe("sync_rotor_day (v2)", () => {
  it("is not listed until the Rotor secrets are set", async () => {
    const res = await rpc(makeEnv(), "tools/list");
    const names = ((await res.json()) as any).result.tools.map((t: any) => t.name);
    expect(names).not.toContain("sync_rotor_day");
    const res2 = await rpc(rotorEnv(), "tools/list");
    expect(((await res2.json()) as any).result.tools.map((t: any) => t.name)).toContain("sync_rotor_day");
  });

  it("reproduces David's export row, hours and ARR from the API", async () => {
    const env = rotorEnv();
    const { fetchImpl, calls } = fakeRotor();
    const out = await syncRotorDay(env, { date: DAY }, { fetchImpl });
    if (!("subtotals" in out)) throw new Error("expected a saved day");

    expect(out.saved).toMatchObject({
      rep: "david",
      date: DAY,
      source: "crm",
      total: 61,
      gave_pitch: 10,
      go_back: 2,
      never_knock: 0,
      door_hanger: 0,
      no_answer: 33,
      not_interested: 14,
      made_sale: 2,
      hours_knocked: 5, // 180 + 120 sales minutes; office time not counted
      arr_sold: 1000, // 600 + 400; cancelled and teammate plans left out
    });
    expect(out.subtotals).toEqual({ adjusted_doors: 59, answered: 26, pitches: 12, plans_sold: 2 });
    expect(out.kpis).toMatchObject({ doors_per_hour: 11.8, revenue_per_hour: 200, avg_arr_per_plan: 500 });
    expect(out.rotor.hours?.minutes_by_category).toEqual({ sales: 300, office: 30 });
    expect(out.rotor.plans_sold?.map((p) => [p.customer, p.arr])).toEqual([
      ["Pat Lee", 600],
      ["Sam Ortiz", 400],
    ]);
    expect(out.warnings).toBeUndefined();

    // One request per endpoint, with the documented headers.
    expect(out.rotor.requests_used).toBe(3);
    for (const c of calls) {
      expect(c.headers["x-api-key"]).toBe("rotor_key_secret");
      expect(c.headers["rotor-api-version"]).toBe("1.1.0");
      expect(c.url.origin + c.url.pathname).toMatch(/^https:\/\/api\.getrotor\.com\/open-api\//);
    }
    const ts = calls.find((c) => c.url.pathname.endsWith("/timesheets"))!;
    expect(ts.url.searchParams.get("start_date")).toBe("2026-11-05T08:00:00.000Z");
    expect(ts.url.searchParams.get("end_date")).toBe("2026-11-06T07:59:59.999Z");
  });

  it("pages back through pins until it passes the start of the day", async () => {
    const env = rotorEnv();
    const { fetchImpl, calls } = fakeRotor(fixtures(), { pageSize: 25 });
    const out = await syncRotorDay(env, { date: DAY }, { fetchImpl });
    expect(out.saved?.total).toBe(61);
    // 84 pins at 25 per page = 4 pages; it stops at the page that reaches the previous day.
    expect(calls.filter((c) => c.url.pathname.endsWith("/pins")).length).toBe(4);
  });

  it("never overwrites hours or ARR that David entered himself", async () => {
    const env = rotorEnv();
    await callTool(env, "save_daily_kpis", { date: DAY, hours_knocked: 5.5, arr_sold: 1800 });
    const { fetchImpl } = fakeRotor();
    const out = await syncRotorDay(env, { date: DAY }, { fetchImpl });
    expect(out.saved).toMatchObject({ total: 61, hours_knocked: 5.5, arr_sold: 1800, source: "crm" });
    const { results } = await env.DB.prepare("SELECT * FROM daily_kpis").all();
    expect(results.length).toBe(1);
  });

  it("saves nothing on a day with no Rotor activity, so a PDF save isn't wiped", async () => {
    const env = rotorEnv();
    await callTool(env, "save_daily_kpis", { date: "2026-11-03", total: 40, no_answer: 40 });
    const { fetchImpl } = fakeRotor();
    const out = await syncRotorDay(env, { date: "2026-11-03" }, { fetchImpl });
    expect(out.saved).toBeNull();
    expect(out.nothing_to_sync).toMatch(/Nothing was saved/);
    const row = await env.DB.prepare("SELECT total FROM daily_kpis WHERE date = ?").bind("2026-11-03").first<any>();
    expect(row.total).toBe(40);
  });

  it("says who dropped pins when the email matches nobody", async () => {
    const env = rotorEnv();
    env.ROTOR_REP_EMAIL = "typo@example.com";
    const { fetchImpl } = fakeRotor();
    const out = await syncRotorDay(env, { date: DAY }, { fetchImpl });
    expect(out.saved).toBeNull();
    const w = out.warnings?.[0] ?? "";
    expect(w).toMatch(/^No pins by typo@example.com on 2026-11-05, but the team dropped 81 .*Check ROTOR_REP_EMAIL\.$/);
    expect(w).toContain("David: 61");
    expect(w).toContain("Rep B: 20");
  });

  it("leaves ARR blank and asks when a plan's ARR can't be worked out", async () => {
    const env = rotorEnv();
    const data = fixtures();
    data.plans[1]!.service_frequency = "Custom";
    const { fetchImpl } = fakeRotor(data);
    const out = await syncRotorDay(env, { date: DAY }, { fetchImpl });
    expect(out.saved?.arr_sold).toBeNull();
    expect(out.warnings?.join(" ")).toMatch(/Couldn't work out ARR for 1 plan.*Custom.*Ask David/);
  });

  it("turns Rotor errors into a readable tool error", async () => {
    const env = rotorEnv();
    const { fetchImpl } = fakeRotor(fixtures(), { status: 429 });
    await expect(syncRotorDay(env, { date: DAY }, { fetchImpl })).rejects.toThrow(/Rotor API 429.*Daily limit reached; resets 2026-11-07T00:00:00Z/);
  });

  it("refuses to run without the secrets", async () => {
    await expect(syncRotorDay(makeEnv(), { date: DAY })).rejects.toThrow(/Rotor sync is off/);
  });
});

describe("nightly cron", () => {
  it("does nothing without the Rotor secrets", async () => {
    const env = makeEnv();
    const waited: Promise<unknown>[] = [];
    await worker.scheduled!({ scheduledTime: Date.parse("2026-11-06T05:30:00Z"), cron: "30 5 * * *", noRetry() {} } as ScheduledController, env, {
      waitUntil: (p: Promise<unknown>) => waited.push(p),
      passThroughOnException() {},
    } as unknown as ExecutionContext);
    expect(waited.length).toBe(0);
  });

  it("syncs the Los Angeles day that is ending (05:30 UTC = 9:30 pm PST the day before)", async () => {
    const env = rotorEnv();
    const { fetchImpl } = fakeRotor();
    const realFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      const waited: Promise<unknown>[] = [];
      await worker.scheduled!({ scheduledTime: Date.parse("2026-11-06T05:30:00Z"), cron: "30 5 * * *", noRetry() {} } as ScheduledController, env, {
        waitUntil: (p: Promise<unknown>) => waited.push(p),
        passThroughOnException() {},
      } as unknown as ExecutionContext);
      await Promise.all(waited);
    } finally {
      globalThis.fetch = realFetch;
    }
    const row = await env.DB.prepare("SELECT date, total, source FROM daily_kpis").first<any>();
    expect(row).toEqual({ date: DAY, total: 61, source: "crm" });
  });
});

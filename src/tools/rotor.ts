import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env } from "../env";
import { DATE_RE, isValidDate, laDayRangeUtc, today } from "../lib/dates";
import { guard, ok } from "../lib/result";
import { RotorClient, type RotorPin, type RotorServicePlan, type RotorTimesheet } from "../lib/rotor";
import { PIN_FIELDS, saveDailyKpis } from "./kpis";

/**
 * v2: pull one day of David's numbers straight from Rotor, so he doesn't have to
 * drop in the pin export. Only active when ROTOR_API_KEY and ROTOR_REP_EMAIL are set.
 *
 * - Pins → the 8 pin counts (same as the "New Pins by Team Member" export).
 * - Timesheets in the "sales" category → hours_knocked.
 * - Service plans he sold that day → arr_sold (one year of revenue per plan).
 *
 * Pins always come from Rotor. hours_knocked and arr_sold only fill blanks, so
 * numbers David entered himself are never overwritten.
 */

export function rotorEnabled(env: Env): boolean {
  return Boolean(env.ROTOR_API_KEY && env.ROTOR_REP_EMAIL);
}

type PinField = (typeof PIN_FIELDS)[number];

/** "Go Back", "Go-Back", "go back" → "go_back". */
export function pinFieldForLabel(label: string | null | undefined): PinField | null {
  const key = (label ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
  return (PIN_FIELDS as readonly string[]).includes(key) ? (key as PinField) : null;
}

export function countPins(pins: RotorPin[]) {
  const counts = Object.fromEntries(PIN_FIELDS.map((f) => [f, 0])) as Record<PinField, number>;
  const unmapped: Record<string, number> = {};
  for (const p of pins) {
    const field = pinFieldForLabel(p.pin_type?.label);
    if (field) counts[field]++;
    else {
      const label = p.pin_type?.label || "(no type)";
      unmapped[label] = (unmapped[label] ?? 0) + 1;
    }
  }
  return { total: pins.length, counts, unmapped };
}

/** Visits per year for Rotor's service_frequency values. null = can't tell. */
export const VISITS_PER_YEAR: Record<string, number> = {
  Annual: 1,
  "Semi-Annual": 2,
  "Tri-Annual": 3,
  Quarterly: 4,
  "Bi-Monthly": 6,
  Monthly: 12,
  "Bi-Weekly": 26,
  Weekly: 52,
};

/**
 * ARR for one plan: one year of revenue, even when the agreement runs longer.
 * Rotor's sale_value is the whole contract, so:
 *   price per visit = sale_value / (scheduled + pending jobs)
 *   ARR = min(sale_value, price per visit × visits per year)
 */
export function planArr(plan: RotorServicePlan): { arr: number | null; method: string } {
  const value = plan.sale_value;
  if (value == null) return { arr: null, method: "no sale_value" };
  const freq = plan.service_frequency ?? "";
  if (freq === "One-Time") return { arr: round2(value), method: "one-time: full sale value" };
  const perYear = VISITS_PER_YEAR[freq];
  const jobs = (plan.num_scheduled_jobs ?? 0) + (plan.num_pending_jobs ?? 0);
  if (!perYear) return { arr: null, method: `unknown frequency "${freq || "none"}"` };
  if (jobs <= 0) return { arr: null, method: "no job count" };
  const perVisit = value / jobs;
  const arr = Math.min(value, perVisit * perYear);
  return {
    arr: round2(arr),
    method: arr < value ? `${round2(perVisit)} per visit × ${perYear}/yr (contract is ${jobs} visits)` : `full sale value (${jobs} visits ≤ 1 year)`,
  };
}

export function sumSalesHours(timesheets: RotorTimesheet[], end: Date, now: Date = new Date()) {
  const byCategory: Record<string, number> = {};
  let active = false;
  for (const t of timesheets) {
    let minutes = t.duration_minutes;
    if (minutes == null) {
      // Still clocked in: count up to now (or the end of the day).
      active = true;
      minutes = Math.max(0, (Math.min(now.getTime(), end.getTime()) - Date.parse(t.start)) / 60000);
    }
    byCategory[t.category] = (byCategory[t.category] ?? 0) + minutes;
  }
  const sales = byCategory.sales;
  return {
    hours_knocked: sales != null ? round2(sales / 60) : null,
    minutes_by_category: Object.fromEntries(Object.entries(byCategory).map(([k, v]) => [k, Math.round(v)])),
    still_clocked_in: active,
  };
}

export interface SyncOptions {
  fetchImpl?: typeof fetch;
  now?: Date;
}

export async function syncRotorDay(env: Env, input: { date?: string }, opts: SyncOptions = {}) {
  if (!rotorEnabled(env)) {
    throw new Error("Rotor sync is off: set the ROTOR_API_KEY and ROTOR_REP_EMAIL secrets. Until then, drop in the pin export.");
  }
  const date = input.date ?? today(opts.now);
  if (!isValidDate(date)) throw new Error(`date must be YYYY-MM-DD, got "${date}"`);
  const email = env.ROTOR_REP_EMAIL!.trim().toLowerCase();
  const { start, end } = laDayRangeUtc(date);
  const endInclusive = new Date(end.getTime() - 1);
  const rotor = new RotorClient(env.ROTOR_API_KEY!, opts.fetchImpl);
  const mine = (u: { email?: string } | null | undefined) => (u?.email ?? "").trim().toLowerCase() === email;

  const [allPins, allTimesheets, allPlans] = await Promise.all([
    rotor.pinsBetween(start, end),
    rotor.timesheetsBetween(start, endInclusive),
    rotor.servicePlansCreatedBetween(start, endInclusive),
  ]);

  const warnings: string[] = [];

  const pins = allPins.filter((p) => mine(p.created_by));
  const pinCounts = countPins(pins);
  if (pins.length === 0 && allPins.length > 0) {
    const byName: Record<string, number> = {};
    for (const p of allPins) byName[p.created_by?.name ?? "?"] = (byName[p.created_by?.name ?? "?"] ?? 0) + 1;
    warnings.push(
      `No pins by ${email} on ${date}, but the team dropped ${allPins.length} (${Object.entries(byName)
        .map(([n, c]) => `${n}: ${c}`)
        .join(", ")}). Check ROTOR_REP_EMAIL.`,
    );
  }
  if (Object.keys(pinCounts.unmapped).length) {
    warnings.push(
      `Pin types not in the KPI guide were counted in Total only: ${Object.entries(pinCounts.unmapped)
        .map(([l, c]) => `${l} (${c})`)
        .join(", ")}.`,
    );
  }

  const hours = sumSalesHours(allTimesheets.filter((t) => mine(t.user)), end, opts.now);
  if (hours.still_clocked_in) warnings.push("Still clocked in on a timesheet, so hours are counted up to now.");
  if (hours.hours_knocked == null && Object.keys(hours.minutes_by_category).length) {
    warnings.push(`No "sales" timesheet that day (found: ${Object.keys(hours.minutes_by_category).join(", ")}), so hours_knocked was left blank.`);
  }

  const plans = allPlans
    .filter((p) => mine(p.sold_by) && !p.cancelled)
    .map((p) => ({
      id: p.id,
      customer: [p.customer?.first_name, p.customer?.last_name].filter(Boolean).join(" ") || p.customer?.company_name || null,
      service_frequency: p.service_frequency,
      sale_value: p.sale_value,
      signed: p.is_signed,
      ...planArr(p),
    }));
  const unknownArr = plans.filter((p) => p.arr == null);
  const arrSold = unknownArr.length ? null : round2(plans.reduce((s, p) => s + (p.arr ?? 0), 0));
  if (unknownArr.length) {
    warnings.push(`Couldn't work out ARR for ${unknownArr.length} plan(s) (${unknownArr.map((p) => p.method).join("; ")}), so arr_sold was left blank. Ask David.`);
  }
  if (plans.length !== pinCounts.counts.made_sale) {
    warnings.push(`${pinCounts.counts.made_sale} Made Sale pins but ${plans.length} service plans sold in Rotor that day.`);
  }

  // Nothing in Rotor for him that day (a day off, or the wrong email): save nothing,
  // so pins he already saved from an export are never wiped with zeros.
  if (pinCounts.total === 0 && hours.hours_knocked == null && plans.length === 0) {
    return {
      saved: null,
      nothing_to_sync: `No pins, sales timesheets or plans for ${email} in Rotor on ${date}. Nothing was saved.`,
      rotor: { date, requests_used: rotor.requests },
      warnings: warnings.length ? warnings : undefined,
    };
  }

  const saved = await saveDailyKpis(
    env,
    {
      date,
      rep: "david",
      total: pinCounts.total,
      ...pinCounts.counts,
      hours_knocked: hours.hours_knocked,
      arr_sold: arrSold,
      source: "crm",
      raw_summary: `Synced from Rotor: ${pinCounts.total} pins, ${hours.hours_knocked ?? "?"} sales hours, ${plans.length} plan(s) sold.`,
      extra: Object.keys(pinCounts.unmapped).length ? { unmapped_pin_types: JSON.stringify(pinCounts.unmapped) } : null,
    },
    { keepExisting: ["hours_knocked", "arr_sold"] },
  );

  // saveDailyKpis' own "missing hours/ARR" warning still applies; merge, without duplicates.
  const allWarnings = [...new Set([...warnings, ...(saved.warnings ?? [])])];
  return {
    ...saved,
    rotor: {
      date,
      pins_by_type: pinCounts.counts,
      unmapped_pin_types: pinCounts.unmapped,
      hours: hours,
      plans_sold: plans,
      requests_used: rotor.requests,
    },
    warnings: allWarnings.length ? allWarnings : undefined,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function registerRotorTools(server: McpServer, env: Env) {
  if (!rotorEnabled(env)) return;
  server.registerTool(
    "sync_rotor_day",
    {
      title: "Sync a day from Rotor",
      description: `Pull one day of David's numbers straight from his Rotor CRM and save them as that day's KPIs, so he doesn't have to drop in the pin export.

It reads his pins (the same counts as the "New Pins by Team Member" export), his "sales" timesheets (hours_knocked) and the service plans he sold (arr_sold, one year of revenue per plan). Pin counts always come from Rotor; hours and ARR only fill blanks, so numbers he entered himself are kept.

Use it when he asks how his day went, says "sync my day" or "pull my numbers", or at the end of a day before get_kpis. It also runs automatically every night. Pass date for an earlier day.

After calling: give the 6 KPIs in a short list (rates are fractions; say them as percentages). If warnings say hours or ARR are blank or uncertain, ask him for them and save with save_daily_kpis. If plans_sold lists plans, you can mention them by customer.`,
      inputSchema: {
        date: z.string().regex(DATE_RE, "YYYY-MM-DD").optional().describe("YYYY-MM-DD. Leave out for today (Los Angeles time)."),
      },
      annotations: { title: "Sync a day from Rotor", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => guard(async () => ok(await syncRotorDay(env, args))),
  );
}

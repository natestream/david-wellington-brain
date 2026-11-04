import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env } from "../env";
import { DATE_RE, isValidDate, nowIso, today } from "../lib/dates";
import { guard, ok, rate } from "../lib/result";

/**
 * The KPI columns. PLACEHOLDERS until David's CRM PDF fields are confirmed (issue #12).
 * To change them: edit this list, add a migration for the new columns, and update
 * computeRates() if a rate depends on a renamed field. Anything else on the PDF
 * goes into `extra` (JSON) in the meantime, so nothing is lost.
 */
export const KPI_FIELDS = {
  doors_knocked: { kind: "int", describe: "Doors knocked." },
  contacts: { kind: "int", describe: "Doors where someone answered / conversations." },
  pitches: { kind: "int", describe: "Full pitches given." },
  quotes: { kind: "int", describe: "Quotes / estimates given." },
  closes: { kind: "int", describe: "Jobs booked / sold." },
  revenue: { kind: "money", describe: "Total sold, in dollars." },
  hours: { kind: "num", describe: "Hours in the field." },
} as const;

export type KpiField = keyof typeof KPI_FIELDS;
export const KPI_FIELD_NAMES = Object.keys(KPI_FIELDS) as KpiField[];
export const KPI_SOURCES = ["pdf", "crm", "manual"] as const;

export type KpiValues = Partial<Record<KpiField, number | null>>;

export interface KpiRow extends Record<KpiField, number | null> {
  id: string;
  date: string;
  rep: string;
  source: (typeof KPI_SOURCES)[number];
  raw_summary: string | null;
  extra: string | null;
  updated_at: string;
}

export function computeRates(k: KpiValues) {
  return {
    contact_rate: rate(k.contacts, k.doors_knocked),
    close_rate: rate(k.closes, k.pitches),
    revenue_per_door: rate(k.revenue, k.doors_knocked, 2),
    avg_ticket: rate(k.revenue, k.closes, 2),
    revenue_per_hour: rate(k.revenue, k.hours, 2),
  };
}

export interface SaveKpisInput extends KpiValues {
  date?: string;
  rep?: string;
  source?: (typeof KPI_SOURCES)[number];
  raw_summary?: string | null;
  extra?: Record<string, string | number | boolean | null> | null;
}

export async function saveDailyKpis(env: Env, input: SaveKpisInput) {
  const date = input.date ?? today();
  if (!isValidDate(date)) throw new Error(`date must be YYYY-MM-DD, got "${date}"`);
  const rep = input.rep?.trim() || "david";
  const values = KPI_FIELD_NAMES.map((f) => input[f] ?? null);
  const extra = input.extra && Object.keys(input.extra).length ? JSON.stringify(input.extra) : null;

  const cols = KPI_FIELD_NAMES.join(", ");
  const qs = KPI_FIELD_NAMES.map(() => "?").join(", ");
  const updates = [...KPI_FIELD_NAMES, "source", "raw_summary", "extra", "updated_at"]
    .map((c) => `${c} = excluded.${c}`)
    .join(", ");

  // UNIQUE(rep, date): re-uploading a day replaces that day's numbers and keeps its id.
  await env.DB.prepare(
    `INSERT INTO daily_kpis (id, date, rep, ${cols}, source, raw_summary, extra, updated_at)
     VALUES (?, ?, ?, ${qs}, ?, ?, ?, ?)
     ON CONFLICT (rep, date) DO UPDATE SET ${updates}`,
  )
    .bind(crypto.randomUUID(), date, rep, ...values, input.source ?? "pdf", input.raw_summary?.trim() || null, extra, nowIso())
    .run();

  const saved = await env.DB.prepare(`SELECT * FROM daily_kpis WHERE rep = ? AND date = ?`).bind(rep, date).first<KpiRow>();
  if (!saved) throw new Error("KPI row was not saved");

  const logged = await env.DB.prepare(
    `SELECT COUNT(*) AS doors,
            SUM(CASE WHEN outcome != 'no_answer' THEN 1 ELSE 0 END) AS contacts,
            SUM(CASE WHEN outcome IN ('pitched', 'quoted', 'closed') THEN 1 ELSE 0 END) AS pitches,
            SUM(CASE WHEN outcome IN ('quoted', 'closed') THEN 1 ELSE 0 END) AS quotes,
            SUM(CASE WHEN outcome = 'closed' THEN 1 ELSE 0 END) AS closes
       FROM doors WHERE rep = ? AND date = ?`,
  )
    .bind(rep, date)
    .first<{ doors: number; contacts: number | null; pitches: number | null; quotes: number | null; closes: number | null }>();

  const loggedDoors = logged?.doors ?? 0;
  const loggedCloses = logged?.closes ?? 0;
  const parts: string[] = [];
  if (saved.doors_knocked != null) parts.push(`CRM says ${saved.doors_knocked} doors, ${loggedDoors} logged`);
  else parts.push(`${loggedDoors} doors logged`);
  if (saved.closes != null) parts.push(`CRM says ${saved.closes} closes, ${loggedCloses} logged`);

  return {
    saved: { ...saved, extra: saved.extra ? JSON.parse(saved.extra) : null },
    rates: computeRates(saved),
    logged_vs_crm: {
      summary: parts.join("; "),
      logged: {
        doors: loggedDoors,
        contacts: logged?.contacts ?? 0,
        pitches: logged?.pitches ?? 0,
        quotes: logged?.quotes ?? 0,
        closes: loggedCloses,
      },
      unlogged_doors: saved.doors_knocked != null ? Math.max(0, saved.doors_knocked - loggedDoors) : null,
    },
  };
}

export interface GetKpisInput {
  from?: string;
  to?: string;
  rep?: string;
  group_by?: "day" | "week" | "none";
}

export async function getKpis(env: Env, input: GetKpisInput) {
  const to = input.to ?? today();
  const from = input.from ?? to;
  for (const [name, v] of [
    ["from", from],
    ["to", to],
  ] as const) {
    if (!isValidDate(v)) throw new Error(`${name} must be YYYY-MM-DD, got "${v}"`);
  }
  if (from > to) throw new Error(`from (${from}) is after to (${to})`);
  const groupBy = input.group_by ?? "day";

  const where = ["date >= ?", "date <= ?"];
  const params: unknown[] = [from, to];
  if (input.rep) {
    where.push("rep = ?");
    params.push(input.rep);
  }

  // Week = Monday-start. SQLite: step back 6 days, then forward to the next Monday.
  const period = groupBy === "week" ? "date(date, '-6 days', 'weekday 1')" : groupBy === "day" ? "date" : "'total'";
  const sums = KPI_FIELD_NAMES.map((f) => `SUM(${f}) AS ${f}`).join(", ");

  const { results } = await env.DB.prepare(
    `SELECT ${period} AS period, COUNT(DISTINCT date) AS days, ${sums}
       FROM daily_kpis
      WHERE ${where.join(" AND ")}
      GROUP BY period
      ORDER BY period`,
  )
    .bind(...params)
    .all<{ period: string; days: number } & KpiValues>();

  const rows = (results ?? []).map((r) => ({ ...r, rates: computeRates(r) }));

  const totals: KpiValues & { days: number } = { days: 0 };
  for (const r of rows) {
    totals.days += r.days;
    for (const f of KPI_FIELD_NAMES) {
      const v = r[f];
      if (v != null) totals[f] = round2((totals[f] ?? 0) + v);
    }
  }

  return {
    from,
    to,
    rep: input.rep ?? "all",
    group_by: groupBy,
    rows: groupBy === "none" ? [] : rows,
    totals: { ...totals, rates: computeRates(totals) },
    note: rows.length === 0 ? "No KPI rows in this range. KPIs come from save_daily_kpis (the end-of-day CRM PDF)." : undefined,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

const dateField = z.string().regex(DATE_RE, "YYYY-MM-DD");

function kpiShape() {
  const shape: Record<string, z.ZodType> = {};
  for (const [name, def] of Object.entries(KPI_FIELDS)) {
    const base = def.kind === "int" ? z.number().int().nonnegative() : z.number().nonnegative();
    shape[name] = base.nullish().describe(def.describe);
  }
  return shape as Record<KpiField, z.ZodOptional<z.ZodNullable<z.ZodNumber>>>;
}

export function registerKpiTools(server: McpServer, env: Env) {
  server.registerTool(
    "save_daily_kpis",
    {
      title: "Save daily KPIs",
      description: `Save one day's numbers from David's CRM (usually the end-of-day PDF he drops into the chat). One row per rep per day; saving the same day again replaces it.

Before calling: read the PDF yourself and pull out the numbers. Map them to the fields below. Leave a field out if the PDF doesn't show it; never guess. Put any other numbers on the PDF into extra (e.g. {"cancellations": 1}). Write a 1-2 sentence raw_summary of the PDF. The PDF itself is not stored.

After calling: confirm in one or two lines: the key numbers and rates (rates are fractions; say them as percentages). If logged_vs_crm shows a gap (e.g. "CRM says 62 doors, 18 logged"), mention it briefly and without nagging.`,
      inputSchema: {
        date: dateField.optional().describe("The day the numbers are for, YYYY-MM-DD. Take it from the PDF; leave out for today (Los Angeles time)."),
        rep: z.string().optional().describe("Whose numbers. Leave out for David."),
        ...kpiShape(),
        source: z.enum(KPI_SOURCES).optional().describe("pdf (default): from a PDF. crm: pulled from the CRM directly. manual: he typed them."),
        raw_summary: z.string().nullish().describe("Your 1-2 sentence summary of the PDF."),
        extra: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
          .nullish()
          .describe("Any other fields on the PDF that don't fit the columns above."),
      },
      annotations: { title: "Save daily KPIs", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => guard(async () => ok(await saveDailyKpis(env, args as SaveKpisInput))),
  );

  server.registerTool(
    "get_kpis",
    {
      title: "Get KPIs",
      description: `Totals and rates from David's saved daily KPIs for a day or a date range. Pure math, no guessing.

Use for "how did I do today/this week/this month?", comparing weeks, or spotting trends. Rates: contact_rate = contacts / doors_knocked, close_rate = closes / pitches, revenue_per_door, avg_ticket = revenue / closes, revenue_per_hour. A rate is null when its denominator is 0 or missing. Rates are fractions; say them as percentages. Keep the answer short and lead with what changed.

Today's date is in Los Angeles time. For "this week" pass from = Monday of this week.`,
      inputSchema: {
        from: dateField.optional().describe("Start YYYY-MM-DD (inclusive). Defaults to the same as to."),
        to: dateField.optional().describe("End YYYY-MM-DD (inclusive). Defaults to today."),
        rep: z.string().optional().describe("Only this rep. Leave out to add up everyone."),
        group_by: z.enum(["day", "week", "none"]).optional().describe("day (default): a row per day. week: a row per Monday-start week. none: totals only."),
      },
      annotations: { title: "Get KPIs", readOnlyHint: true, openWorldHint: false },
    },
    async (args) => guard(async () => ok(await getKpis(env, args))),
  );
}

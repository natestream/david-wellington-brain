import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env } from "../env";
import { DATE_RE, isValidDate, nowIso, today } from "../lib/dates";
import { embedOne } from "../lib/embed";
import { guard, ok, rate } from "../lib/result";
import { doorVectorId, hydrate, queryVectors, upsertVectors } from "../lib/vectors";

export const OUTCOMES = ["no_answer", "not_interested", "pitched", "quoted", "closed", "callback"] as const;
export const OBJECTION_TYPES = ["price", "has_someone", "spouse", "timing", "diy", "not_needed", "other"] as const;

export type Outcome = (typeof OUTCOMES)[number];
export type ObjectionType = (typeof OBJECTION_TYPES)[number];

export interface DoorRow {
  id: string;
  created_at: string;
  date: string;
  rep: string;
  area: string | null;
  outcome: Outcome;
  objection_type: ObjectionType | null;
  objection_text: string | null;
  response: string | null;
  amount: number | null;
  notes: string | null;
  coaching: string | null;
}

export interface LogDoorInput {
  outcome: Outcome;
  objection_type?: ObjectionType | null;
  objection_text?: string | null;
  response?: string | null;
  amount?: number | null;
  area?: string | null;
  notes?: string | null;
  coaching?: string | null;
  rep?: string;
  date?: string;
}

const SIMILAR_LIMIT = 5;

/** The text that gets embedded for a door: what was said and what happened. */
export function doorEmbeddingText(d: Pick<DoorRow, "objection_text" | "response" | "notes">): string {
  return [d.objection_text, d.response, d.notes]
    .map((s) => s?.trim())
    .filter(Boolean)
    .join("\n");
}

export async function logDoor(env: Env, input: LogDoorInput) {
  const date = input.date ?? today();
  if (!isValidDate(date)) throw new Error(`date must be YYYY-MM-DD, got "${date}"`);

  const row: DoorRow = {
    id: crypto.randomUUID(),
    created_at: nowIso(),
    date,
    rep: clean(input.rep) ?? "david",
    area: clean(input.area),
    outcome: input.outcome,
    objection_type: input.objection_type ?? null,
    objection_text: clean(input.objection_text),
    response: clean(input.response),
    amount: input.amount ?? null,
    notes: clean(input.notes),
    coaching: clean(input.coaching),
  };

  await env.DB.prepare(
    `INSERT INTO doors (id, created_at, date, rep, area, outcome, objection_type, objection_text, response, amount, notes, coaching)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      row.id,
      row.created_at,
      row.date,
      row.rep,
      row.area,
      row.outcome,
      row.objection_type,
      row.objection_text,
      row.response,
      row.amount,
      row.notes,
      row.coaching,
    )
    .run();

  // One embedding per door. A door with nothing said (e.g. no answer) has nothing
  // to learn from, so it is stored in D1 only and costs no AI call.
  // If embedding or search fails, the door is still saved: never make Claude retry
  // (that would log the door twice). The warning tells it search is unavailable.
  let similar_doors: SimilarDoor[] = [];
  let search_warning: string | undefined;
  const text = doorEmbeddingText(row);
  if (text) {
    try {
      const vector = await embedOne(env, text);
      await upsertVectors(env, [
        {
          id: doorVectorId(row.id),
          values: vector,
          metadata: {
            kind: "door",
            id: row.id,
            outcome: row.outcome,
            objection_type: row.objection_type ?? "",
            date: row.date,
            rep: row.rep,
          },
        },
      ]);
      // Reuse the same vector to find similar past doors (no second embedding).
      similar_doors = await findSimilarDoors(env, vector, row.id);
    } catch (err) {
      search_warning = `Door saved, but similar-door search failed: ${err instanceof Error ? err.message : String(err)}. Do not log this door again.`;
    }
  }

  const objection_history = row.objection_type
    ? ((await objectionStats(env, { rep: row.rep, objection_type: row.objection_type, exclude_id: row.id })).objections[0] ??
      null)
    : null;

  const logged_today = await env.DB.prepare(`SELECT COUNT(*) AS n FROM doors WHERE rep = ? AND date = ?`)
    .bind(row.rep, row.date)
    .first<{ n: number }>();

  return {
    saved: true,
    id: row.id,
    date: row.date,
    rep: row.rep,
    doors_logged_today: logged_today?.n ?? 1,
    similar_doors,
    objection_history,
    ...(search_warning ? { search_warning } : {}),
  };
}

export interface SimilarDoor {
  date: string;
  outcome: Outcome;
  objection_type: ObjectionType | null;
  objection_text: string | null;
  response: string | null;
  amount: number | null;
  area: string | null;
  similarity: number;
}

async function findSimilarDoors(env: Env, vector: number[], selfId: string): Promise<SimilarDoor[]> {
  const matches = await queryVectors(env, vector, { kind: "door", limit: SIMILAR_LIMIT, excludeIds: [selfId] });
  const rows = await hydrate<DoorRow>(
    env,
    "doors",
    matches.map((m) => m.id),
  );
  return matches.flatMap((m) => {
    const d = rows.get(m.id);
    if (!d) return [];
    return [
      {
        date: d.date,
        outcome: d.outcome,
        objection_type: d.objection_type,
        objection_text: d.objection_text,
        response: d.response,
        amount: d.amount,
        area: d.area,
        similarity: m.score,
      },
    ];
  });
}

export interface ObjectionStatsInput {
  from?: string;
  to?: string;
  rep?: string;
  objection_type?: ObjectionType;
  /** Leave one door out (used by log_door so the door just saved isn't counted as history). */
  exclude_id?: string;
}

export async function objectionStats(env: Env, input: ObjectionStatsInput) {
  const where: string[] = ["objection_type IS NOT NULL"];
  const params: unknown[] = [];
  if (input.from) {
    if (!isValidDate(input.from)) throw new Error(`from must be YYYY-MM-DD, got "${input.from}"`);
    where.push("date >= ?");
    params.push(input.from);
  }
  if (input.to) {
    if (!isValidDate(input.to)) throw new Error(`to must be YYYY-MM-DD, got "${input.to}"`);
    where.push("date <= ?");
    params.push(input.to);
  }
  if (input.rep) {
    where.push("rep = ?");
    params.push(input.rep);
  }
  if (input.objection_type) {
    where.push("objection_type = ?");
    params.push(input.objection_type);
  }
  if (input.exclude_id) {
    where.push("id != ?");
    params.push(input.exclude_id);
  }
  const whereSql = where.join(" AND ");

  const { results: counts } = await env.DB.prepare(
    `SELECT objection_type,
            COUNT(*) AS count,
            SUM(CASE WHEN outcome = 'closed' THEN 1 ELSE 0 END) AS closed,
            SUM(CASE WHEN outcome = 'closed' THEN COALESCE(amount, 0) ELSE 0 END) AS closed_revenue
       FROM doors
      WHERE ${whereSql}
      GROUP BY objection_type
      ORDER BY count DESC, objection_type`,
  )
    .bind(...params)
    .all<{ objection_type: ObjectionType; count: number; closed: number; closed_revenue: number }>();

  const { results: wins } = await env.DB.prepare(
    `SELECT objection_type, date, objection_text, response, amount FROM (
       SELECT objection_type, date, objection_text, response, amount,
              ROW_NUMBER() OVER (PARTITION BY objection_type ORDER BY date DESC, created_at DESC) AS rn
         FROM doors
        WHERE ${whereSql} AND outcome = 'closed' AND response IS NOT NULL AND response != ''
     ) WHERE rn <= 3
     ORDER BY objection_type, rn`,
  )
    .bind(...params)
    .all<{ objection_type: ObjectionType; date: string; objection_text: string | null; response: string; amount: number | null }>();

  const winsByType = new Map<string, { date: string; objection_text: string | null; response: string; amount: number | null }[]>();
  for (const w of wins ?? []) {
    const list = winsByType.get(w.objection_type) ?? [];
    list.push({ date: w.date, objection_text: w.objection_text, response: w.response, amount: w.amount });
    winsByType.set(w.objection_type, list);
  }

  const objections = (counts ?? []).map((c) => ({
    objection_type: c.objection_type,
    count: c.count,
    closed: c.closed,
    close_rate: rate(c.closed, c.count),
    closed_revenue: c.closed_revenue,
    responses_that_closed: winsByType.get(c.objection_type) ?? [],
  }));

  const total = objections.reduce((n, o) => n + o.count, 0);
  return {
    from: input.from ?? null,
    to: input.to ?? null,
    rep: input.rep ?? "all",
    doors_with_objection: total,
    objections,
  };
}

function clean(s: string | null | undefined): string | null {
  const t = s?.trim();
  return t ? t : null;
}

const dateField = z.string().regex(DATE_RE, "YYYY-MM-DD");

export function registerDoorTools(server: McpServer, env: Env) {
  server.registerTool(
    "log_door",
    {
      title: "Log a door",
      description: `Save one door David just knocked (door-to-door window cleaning) and get similar past doors back so you can coach him from his own history.

Call this every time David describes a door, even a short one like "no answer". One call per door. If he describes several doors in one message (or pastes notes from earlier in the week), call it once per door and pass the right date.

Before calling:
1. Pull the fields out of his message. outcome is required. Map what the homeowner said to the closest objection_type; keep their words in objection_text and what David said back in response, in his own words.
2. Write your coaching for this door and pass it in coaching. Keep it to 1-2 short sentences: one thing that went well or one thing to try at the next door.

After calling: give the coaching in the chat. Keep the whole reply short; he is walking to the next door. If similar_doors or objection_history show a pattern (for example "the last 4 times you heard 'too expensive', offering a smaller first job closed 3"), add one line about it. Don't list the raw data back to him.`,
      inputSchema: {
        outcome: z
          .enum(OUTCOMES)
          .describe(
            "What happened. no_answer: nobody came to the door. not_interested: talked but no pitch. pitched: gave the pitch, no quote. quoted: gave a price. closed: booked the job. callback: asked to come back or call later.",
          ),
        objection_type: z
          .enum(OBJECTION_TYPES)
          .nullish()
          .describe(
            "Main objection, if any. price: too expensive. has_someone: already has a window cleaner. spouse: needs to ask partner. timing: not now / bad time. diy: does it themselves. not_needed: windows are fine. other: anything else.",
          ),
        objection_text: z.string().nullish().describe("What the homeowner said, in David's words."),
        response: z.string().nullish().describe("What David said back."),
        amount: z.number().nonnegative().nullish().describe("Quote or close amount in dollars, if any."),
        area: z.string().nullish().describe("Street or neighborhood, if he mentioned it."),
        notes: z.string().nullish().describe("Anything else worth remembering about this door (house details, follow-up, mood)."),
        coaching: z.string().nullish().describe("Your 1-2 sentence coaching for this door."),
        rep: z.string().optional().describe("Who knocked the door. Leave out for David."),
        date: dateField.optional().describe("YYYY-MM-DD. Leave out for today (Los Angeles time). Set it when backfilling earlier doors."),
      },
      annotations: { title: "Log a door", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => guard(async () => ok(await logDoor(env, args))),
  );

  server.registerTool(
    "objection_stats",
    {
      title: "Objection stats",
      description: `Which objections keep coming up and what actually closes after them. Pure counts from David's logged doors.

Use when he asks things like "what objections am I getting most?", "how do I handle price?", "what's working this week?", or when building training material on objections.

Returns, per objection_type: count, closed, close_rate (closed / count, 0-1), closed_revenue, and the 3 most recent responses that led to a close. Turn it into a short, practical answer: the top 1-3 objections and the line that works best for each. Rates are fractions; say them as percentages.`,
      inputSchema: {
        from: dateField.optional().describe("Start date YYYY-MM-DD (inclusive). Leave out for all time."),
        to: dateField.optional().describe("End date YYYY-MM-DD (inclusive). Leave out for up to today."),
        rep: z.string().optional().describe("Only this rep. Leave out for everyone."),
        objection_type: z.enum(OBJECTION_TYPES).optional().describe("Only this objection."),
      },
      annotations: { title: "Objection stats", readOnlyHint: true, openWorldHint: false },
    },
    async (args) => guard(async () => ok(await objectionStats(env, args))),
  );
}

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env } from "../env";
import { chunkText } from "../lib/chunk";
import { nowIso } from "../lib/dates";
import { embed, embedOne } from "../lib/embed";
import { guard, ok } from "../lib/result";
import { hydrate, noteExcerpt, noteVectorId, queryVectors, upsertVectors } from "../lib/vectors";
import type { DoorRow } from "./doors";

export interface NoteRow {
  id: string;
  created_at: string;
  title: string;
  body: string;
  tags: string;
  source: "chat" | "import";
}

export interface NoteInput {
  /** Set for imports so re-running the import replaces notes instead of duplicating them. */
  id?: string;
  title: string;
  body: string;
  tags?: string[];
  source?: "chat" | "import";
}

/**
 * Store notes in D1 and embed every chunk in one Workers AI call.
 * Used by save_note (one note) and by the import route (a batch).
 */
export async function storeNotes(env: Env, notes: NoteInput[], opts: { tolerateIndexFailure?: boolean } = {}) {
  const created = nowIso();
  const rows: NoteRow[] = notes.map((n) => {
    const title = n.title.trim();
    const body = n.body.trim();
    if (!title) throw new Error("title is required");
    if (!body) throw new Error(`note "${title}" has an empty body`);
    return {
      id: n.id ?? crypto.randomUUID(),
      created_at: created,
      title,
      body,
      tags: JSON.stringify(normalizeTags(n.tags)),
      source: n.source ?? "chat",
    };
  });

  const stmt = env.DB.prepare(
    `INSERT INTO notes (id, created_at, title, body, tags, source) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET title = excluded.title, body = excluded.body, tags = excluded.tags, source = excluded.source`,
  );
  await env.DB.batch(rows.map((r) => stmt.bind(r.id, r.created_at, r.title, r.body, r.tags, r.source)));

  // If indexing fails the note is still saved in D1 (save_note must not be retried,
  // that would duplicate it). The import route re-throws instead: it is safe to re-run.
  let index_warning: string | undefined;
  try {
    // The title goes in front of every chunk so a chunk still knows what it is about.
    const pieces = rows.flatMap((r) => chunkText(r.body).map((text, i) => ({ row: r, i, text: `${r.title}\n\n${text}` })));
    const vectors = await embed(
      env,
      pieces.map((p) => p.text),
    );
    await upsertVectors(
      env,
      pieces.map((p, k) => ({
        id: noteVectorId(p.row.id, p.i),
        values: vectors[k]!,
        metadata: { kind: "note", id: p.row.id, chunk: p.i, source: p.row.source },
      })),
    );
  } catch (err) {
    if (!opts.tolerateIndexFailure) throw err;
    index_warning = `Note saved, but it could not be indexed for search: ${err instanceof Error ? err.message : String(err)}. Do not save it again.`;
  }

  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    chunks: chunkText(r.body).length,
    ...(index_warning ? { index_warning } : {}),
  }));
}

export async function saveNote(env: Env, input: { title: string; body: string; tags?: string[] }) {
  const [saved] = await storeNotes(env, [{ ...input, source: "chat" }], { tolerateIndexFailure: true });
  return { saved: true, ...saved! };
}

const BODY_CAP = 6000;

type SearchResult =
  | { kind: "door"; similarity: number; door: DoorRow }
  | {
      kind: "note";
      similarity: number;
      note: {
        id: string;
        title: string;
        tags: string[];
        source: NoteRow["source"];
        created_at: string;
        matched_excerpt: string;
        body: string;
        body_truncated: boolean;
      };
    };

export async function askBrain(env: Env, input: { query: string; kind?: "door" | "note" | "all"; limit?: number }) {
  const query = input.query.trim();
  if (!query) throw new Error("query is required");
  const limit = Math.min(Math.max(input.limit ?? 8, 1), 25);
  const vector = await embedOne(env, query);
  const matches = await queryVectors(env, vector, { kind: input.kind ?? "all", limit });

  const doors = await hydrate<DoorRow>(
    env,
    "doors",
    matches.filter((m) => m.kind === "door").map((m) => m.id),
  );
  const notes = await hydrate<NoteRow>(
    env,
    "notes",
    matches.filter((m) => m.kind === "note").map((m) => m.id),
  );

  const results = matches.flatMap((m): SearchResult[] => {
    if (m.kind === "door") {
      const d = doors.get(m.id);
      return d ? [{ kind: "door", similarity: m.score, door: d }] : [];
    }
    const n = notes.get(m.id);
    if (!n) return [];
    const truncated = n.body.length > BODY_CAP;
    return [
      {
        kind: "note",
        similarity: m.score,
        note: {
          id: n.id,
          title: n.title,
          tags: safeTags(n.tags),
          source: n.source,
          created_at: n.created_at,
          matched_excerpt: noteExcerpt(n.body, m.chunk),
          body: truncated ? `${n.body.slice(0, BODY_CAP)}…` : n.body,
          body_truncated: truncated,
        },
      },
    ];
  });

  return { query, kind: input.kind ?? "all", count: results.length, results };
}

function normalizeTags(tags: string[] | undefined): string[] {
  return [...new Set((tags ?? []).map((t) => t.trim().replace(/^#/, "").toLowerCase()).filter(Boolean))];
}

function safeTags(tags: string): string[] {
  try {
    const parsed = JSON.parse(tags);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function registerNoteTools(server: McpServer, env: Env) {
  server.registerTool(
    "save_note",
    {
      title: "Save a note",
      description: `Save anything David wants to remember that isn't a single door: ideas, scripts and pitch lines, lessons, goals, plans, customer or team notes, training material. This replaces his old notes folder.

Call it when he says "remember this", "save this", "note that", or shares something clearly worth keeping. Clean the text up into a clear note first (keep his wording and every name and number), give it a short title, and add a few lowercase tags. One idea per note; if he gives you several, save several notes.

Doors go to log_door, end-of-day numbers to save_daily_kpis, not here. After saving, confirm in one short line.`,
      inputSchema: {
        title: z.string().min(1).describe("Short title, e.g. 'Price objection: smaller first job'."),
        body: z.string().min(1).describe("The note, in clean markdown."),
        tags: z.array(z.string()).optional().describe("A few lowercase tags, e.g. ['objections', 'price']."),
      },
      annotations: { title: "Save a note", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => guard(async () => ok(await saveNote(env, args))),
  );

  server.registerTool(
    "ask_brain",
    {
      title: "Search the brain",
      description: `Search everything David has saved (notes, imported files and logged doors) by meaning, and get the full rows back.

Use it before answering any question about what he knows, has done, or has said: "what did I write about X?", "what works on people who already have a window cleaner?", "make a sales training slideshow from everything I know about objections". Use several searches with different wording for big asks. For counts and rates use get_kpis or objection_stats instead; this tool finds content, it doesn't count.

You do the answering: combine the results, cite note titles or door dates, and say so if nothing relevant came back rather than guessing.`,
      inputSchema: {
        query: z.string().min(1).describe("What to look for, in plain words."),
        kind: z.enum(["door", "note", "all"]).optional().describe("door: only logged doors. note: only notes. all (default): both."),
        limit: z.number().int().min(1).max(25).optional().describe("How many results (default 8)."),
      },
      annotations: { title: "Search the brain", readOnlyHint: true, openWorldHint: false },
    },
    async (args) => guard(async () => ok(await askBrain(env, args))),
  );
}

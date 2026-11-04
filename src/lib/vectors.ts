import type { Env } from "../env";
import { chunkText } from "./chunk";

/**
 * Vector IDs carry their kind, so search never depends on Vectorize metadata
 * indexes (which would need an extra setup step on David's account):
 *   door:<uuid>
 *   note:<uuid>#<chunk index>
 */
export type Kind = "door" | "note";

export function doorVectorId(id: string): string {
  return `door:${id}`;
}

export function noteVectorId(id: string, chunk: number): string {
  return `note:${id}#${chunk}`;
}

export interface ParsedVectorId {
  kind: Kind;
  id: string;
  chunk: number;
}

export function parseVectorId(vectorId: string): ParsedVectorId | null {
  const m = /^(door|note):([^#]+)(?:#(\d+))?$/.exec(vectorId);
  if (!m) return null;
  return { kind: m[1] as Kind, id: m[2]!, chunk: m[3] ? Number(m[3]) : 0 };
}

export async function upsertVectors(
  env: Env,
  vectors: { id: string; values: number[]; metadata?: Record<string, string | number | boolean> }[],
): Promise<void> {
  if (vectors.length === 0) return;
  // Vectorize accepts up to 1000 vectors per call from a Worker.
  for (let i = 0; i < vectors.length; i += 1000) {
    await env.VECTORS.upsert(vectors.slice(i, i + 1000));
  }
}

/** Vectorize allows topK up to 100 when values and metadata are not returned. */
const MAX_TOP_K = 100;

export interface Match {
  kind: Kind;
  id: string;
  chunk: number;
  score: number;
}

/**
 * Query Vectorize and return matches of the wanted kind, best first.
 * Notes are de-duplicated (several chunks of one note count once, keeping the best chunk).
 */
export async function queryVectors(
  env: Env,
  vector: number[],
  opts: { kind: Kind | "all"; limit: number; excludeIds?: string[] },
): Promise<Match[]> {
  // Over-fetch so filtering by kind and de-duplicating chunks still leaves enough results.
  const topK = Math.min(MAX_TOP_K, Math.max(opts.limit * 4, 20));
  const res = await env.VECTORS.query(vector, { topK, returnValues: false, returnMetadata: "none" });
  const exclude = new Set(opts.excludeIds ?? []);
  const seen = new Set<string>();
  const out: Match[] = [];
  for (const m of res.matches ?? []) {
    const parsed = parseVectorId(m.id);
    if (!parsed) continue;
    if (opts.kind !== "all" && parsed.kind !== opts.kind) continue;
    const key = `${parsed.kind}:${parsed.id}`;
    if (exclude.has(parsed.id) || seen.has(key)) continue;
    seen.add(key);
    out.push({ ...parsed, score: round(m.score) });
    if (out.length >= opts.limit) break;
  }
  return out;
}

/** Load full rows from D1 for a list of IDs, keeping the input order. */
export async function hydrate<T extends { id: string }>(
  env: Env,
  table: "doors" | "notes",
  ids: string[],
): Promise<Map<string, T>> {
  const map = new Map<string, T>();
  if (ids.length === 0) return map;
  const placeholders = ids.map(() => "?").join(",");
  const { results } = await env.DB.prepare(`SELECT * FROM ${table} WHERE id IN (${placeholders})`)
    .bind(...ids)
    .all<T>();
  for (const row of results ?? []) map.set(row.id, row);
  return map;
}

/** The text of one chunk of a note, recomputed from the body. */
export function noteExcerpt(body: string, chunk: number): string {
  const chunks = chunkText(body);
  return chunks[chunk] ?? chunks[0] ?? "";
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

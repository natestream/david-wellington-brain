/**
 * Test doubles for the Cloudflare bindings, so the real SQL and tool logic run in plain Node:
 * - D1 → node:sqlite (real SQLite, same engine D1 uses) with the real migration applied
 * - Vectorize → in-memory cosine search
 * - Workers AI → deterministic bag-of-words embedding (similar words → similar vectors)
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Env } from "../src/env";
import { EMBEDDING_DIMS } from "../src/lib/embed";

type Value = string | number | null;

class FakeStatement {
  constructor(
    private db: DatabaseSync,
    private sql: string,
    private params: Value[] = [],
  ) {}
  bind(...params: unknown[]) {
    return new FakeStatement(
      this.db,
      this.sql,
      params.map((p) => (p === undefined ? null : (p as Value))),
    );
  }
  async run() {
    const info = this.db.prepare(this.sql).run(...this.params);
    return { success: true, meta: { changes: Number(info.changes) }, results: [] };
  }
  async all<T>() {
    const rows = this.db.prepare(this.sql).all(...this.params) as T[];
    return { success: true, meta: {}, results: rows.map((r) => ({ ...r })) };
  }
  async first<T>(col?: string) {
    const row = this.db.prepare(this.sql).get(...this.params) as Record<string, unknown> | undefined;
    if (!row) return null;
    return (col ? row[col] : { ...row }) as T;
  }
}

export class FakeD1 {
  db = new DatabaseSync(":memory:");
  constructor() {
    const dir = join(import.meta.dirname, "..", "migrations");
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
      this.db.exec(readFileSync(join(dir, f), "utf8"));
    }
  }
  prepare(sql: string) {
    return new FakeStatement(this.db, sql);
  }
  async batch(stmts: FakeStatement[]) {
    this.db.exec("BEGIN");
    try {
      const out = [];
      for (const s of stmts) out.push(await s.run());
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
}

export class FakeVectorize {
  vectors = new Map<string, { values: number[]; metadata?: Record<string, unknown> }>();
  queries = 0;
  async upsert(vs: { id: string; values: number[]; metadata?: Record<string, unknown> }[]) {
    for (const v of vs) {
      if (v.values.length !== EMBEDDING_DIMS) throw new Error(`wrong dims ${v.values.length}`);
      if (new TextEncoder().encode(v.id).length > 64) throw new Error(`vector id too long: ${v.id}`);
      this.vectors.set(v.id, { values: v.values, metadata: v.metadata });
    }
    return { mutationId: "m", count: vs.length, ids: vs.map((v) => v.id) };
  }
  async query(vector: number[], opts: { topK: number; returnMetadata?: string; returnValues?: boolean }) {
    this.queries++;
    if (opts.topK > 100) throw new Error("topK too large");
    if (opts.returnMetadata === "all" && opts.topK > 20) throw new Error("topK too large with metadata");
    const matches = [...this.vectors.entries()]
      .map(([id, v]) => ({ id, score: cosine(vector, v.values) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, opts.topK);
    return { count: matches.length, matches };
  }
}

export class FakeAI {
  calls = 0;
  texts = 0;
  async run(model: string, input: { text: string[] }) {
    if (model !== "@cf/baai/bge-base-en-v1.5") throw new Error(`unexpected model ${model}`);
    if (input.text.length > 100) throw new Error("batch too large");
    this.calls++;
    this.texts += input.text.length;
    return { shape: [input.text.length, EMBEDDING_DIMS], data: input.text.map(fakeEmbedding) };
  }
}

export function fakeEmbedding(text: string): number[] {
  const v = new Array<number>(EMBEDDING_DIMS).fill(0);
  for (const word of text.toLowerCase().match(/[a-z0-9']+/g) ?? []) {
    let h = 2166136261;
    for (let i = 0; i < word.length; i++) h = Math.imul(h ^ word.charCodeAt(i), 16777619);
    v[Math.abs(h) % EMBEDDING_DIMS]! += 1;
  }
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** In-memory Workers KV: get (text/json), put (expirationTtl, metadata), delete, list (prefix, metadata). */
export class FakeKV {
  store = new Map<string, { value: string; expires?: number; metadata?: unknown }>();
  private live(key: string) {
    const e = this.store.get(key);
    if (e?.expires && e.expires <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return e;
  }
  async get(key: string, opts?: "text" | "json" | { type?: string }) {
    const e = this.live(key);
    if (!e) return null;
    const type = typeof opts === "string" ? opts : opts?.type;
    return type === "json" ? JSON.parse(e.value) : e.value;
  }
  async getWithMetadata(key: string, opts?: "text" | "json" | { type?: string }) {
    const e = this.live(key);
    return { value: e ? await this.get(key, opts) : null, metadata: e?.metadata ?? null };
  }
  async put(key: string, value: string, opts?: { expirationTtl?: number; expiration?: number; metadata?: unknown }) {
    const expires = opts?.expirationTtl
      ? Date.now() + opts.expirationTtl * 1000
      : opts?.expiration
        ? opts.expiration * 1000
        : undefined;
    this.store.set(key, { value: String(value), expires, metadata: opts?.metadata });
  }
  async delete(key: string) {
    this.store.delete(key);
  }
  async list(opts?: { prefix?: string; limit?: number; cursor?: string }) {
    const names = [...this.store.keys()].filter((k) => k.startsWith(opts?.prefix ?? "") && this.live(k)).sort();
    const start = opts?.cursor ? Number(opts.cursor) : 0;
    const limit = opts?.limit ?? 1000;
    const page = names.slice(start, start + limit);
    const done = start + limit >= names.length;
    return {
      keys: page.map((name) => ({ name, metadata: this.store.get(name)?.metadata })),
      list_complete: done,
      cursor: done ? undefined : String(start + limit),
    };
  }
}

export interface TestEnv extends Env {
  DB: FakeD1 & D1Database;
  VECTORS: FakeVectorize & VectorizeIndex;
  AI: FakeAI & Ai;
  OAUTH_KV: FakeKV & KVNamespace;
}

export function makeEnv(key = "test-key"): TestEnv {
  return {
    DB: new FakeD1() as TestEnv["DB"],
    VECTORS: new FakeVectorize() as unknown as TestEnv["VECTORS"],
    AI: new FakeAI() as unknown as TestEnv["AI"],
    OAUTH_KV: new FakeKV() as unknown as TestEnv["OAUTH_KV"],
    BRAIN_KEY: key,
  } as TestEnv; // OAUTH_PROVIDER is set by the OAuth library per request
}

/** A minimal ExecutionContext for worker.fetch in tests. */
export function makeCtx(): ExecutionContext {
  const pending: Promise<unknown>[] = [];
  return {
    waitUntil: (p: Promise<unknown>) => void pending.push(p),
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext;
}

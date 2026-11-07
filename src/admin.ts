import { z } from "zod";
import type { Env } from "./env";
import { storeNotes } from "./tools/notes";

/**
 * POST /admin/import: used once by scripts/import.ts to load David's markdown files.
 * Same x-api-key auth as /mcp, so it adds no access the MCP tools don't already give.
 *
 * Each note's id is derived from its file path, so re-running the import replaces
 * notes instead of duplicating them.
 */
export const MAX_IMPORT_BATCH = 25;

const ImportBody = z.object({
  notes: z
    .array(
      z.object({
        path: z.string().min(1),
        title: z.string().min(1),
        body: z.string().min(1),
        tags: z.array(z.string()).optional(),
      }),
    )
    .min(1)
    .max(MAX_IMPORT_BATCH),
});

export async function handleImport(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return json({ error: "use POST" }, 405);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "body must be JSON" }, 400);
  }
  const parsed = ImportBody.safeParse(body);
  if (!parsed.success) return json({ error: "invalid body", issues: parsed.error.issues }, 400);

  const notes = await Promise.all(
    parsed.data.notes.map(async (n) => ({
      id: await idFromPath(n.path),
      title: n.title,
      body: n.body,
      tags: n.tags,
      source: "import" as const,
    })),
  );
  const saved = await storeNotes(env, notes);
  return json({ imported: saved.length, chunks: saved.reduce((s, n) => s + n.chunks, 0), notes: saved });
}

/** A stable UUID-shaped id from a file path (first 16 bytes of SHA-256). */
export async function idFromPath(path: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`import:${path}`)));
  const hex = [...digest.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

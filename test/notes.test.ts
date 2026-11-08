import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { idFromPath } from "../src/admin";
import { CHUNK_CHARS, chunkText } from "../src/lib/chunk";
import { addDays, isValidDate, today } from "../src/lib/dates";
import { makeEnv, type TestEnv } from "./fakes";
import { callTool } from "./mcp-client";

describe("save_note + ask_brain (#8)", () => {
  it("saves a note with clean tags and one embedding call", async () => {
    const env = makeEnv();
    const out = await callTool(env, "save_note", {
      title: "Price objection: smaller first job",
      body: "When they say it's too expensive, offer just the front windows first.",
      tags: ["Objections", "#price", "objections"],
    });
    expect(out).toMatchObject({ saved: true, chunks: 1 });
    expect(env.AI.calls).toBe(1);
    const row = await env.DB.prepare("SELECT * FROM notes WHERE id = ?").bind(out.id).first<any>();
    expect(JSON.parse(row.tags)).toEqual(["objections", "price"]);
    expect(row.source).toBe("chat");
  });

  it("finds notes and doors by meaning and hydrates full rows", async () => {
    const env = makeEnv();
    await callTool(env, "save_note", { title: "Goals", body: "Hit 100 doors a day by December. Buy a second ladder." });
    await callTool(env, "save_note", { title: "Price objection", body: "Too expensive? Offer a smaller first job, front windows only." });
    await callTool(env, "log_door", { outcome: "made_sale", objection_type: "price", objection_text: "too expensive", response: "smaller first job" });

    const all = await callTool(env, "ask_brain", { query: "what do I say when it's too expensive" });
    expect(all.results[0].kind === "note" ? all.results[0].note.title : all.results[0].door.response).toMatch(/Price objection|smaller first job/);
    const kinds = all.results.map((r: any) => r.kind).sort();
    expect(kinds).toContain("door");
    expect(kinds).toContain("note");

    const notesOnly = await callTool(env, "ask_brain", { query: "too expensive", kind: "note" });
    expect(notesOnly.results.every((r: any) => r.kind === "note")).toBe(true);
    const doorsOnly = await callTool(env, "ask_brain", { query: "too expensive", kind: "door" });
    expect(doorsOnly.results.length).toBe(1);
    expect(doorsOnly.results[0].door.outcome).toBe("made_sale");
  });

  it("respects the limit", async () => {
    const env = makeEnv();
    for (let i = 0; i < 5; i++) await callTool(env, "save_note", { title: `Ladder note ${i}`, body: `ladder safety tip number ${i}` });
    const out = await callTool(env, "ask_brain", { query: "ladder", limit: 2 });
    expect(out.count).toBe(2);
  });

  it("chunks long notes, returns the note once with the matching excerpt", async () => {
    const env = makeEnv();
    const filler = Array.from({ length: 12 }, (_, i) => `Paragraph ${i} about routes and scheduling and weather.`.repeat(5)).join("\n\n");
    const body = `${filler}\n\nSquirrels chewed the screen on the corner house, bring spare screen mesh.`;
    const out = await callTool(env, "save_note", { title: "Field log", body });
    expect(out.chunks).toBeGreaterThan(1);
    expect(env.AI.calls).toBe(1); // all chunks in one call

    const res = await callTool(env, "ask_brain", { query: "squirrels chewed the screen mesh" });
    expect(res.results.length).toBe(1);
    expect(res.results[0].note.matched_excerpt).toContain("Squirrels");
  });
});

describe("chunkText", () => {
  it("keeps short text whole and splits long text under the size", () => {
    expect(chunkText("short")).toEqual(["short"]);
    const long = Array.from({ length: 30 }, (_, i) => `para ${i} `.repeat(20)).join("\n\n");
    const chunks = chunkText(long);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(CHUNK_CHARS);
    expect(chunkText("x".repeat(CHUNK_CHARS * 2 + 5)).length).toBe(3);
  });
});

describe("dates", () => {
  it("uses Los Angeles time for today", () => {
    // 2026-11-05 06:30 UTC is still Nov 4 in LA.
    expect(today(new Date("2026-11-05T06:30:00Z"))).toBe("2026-11-04");
    expect(today(new Date("2026-11-05T09:00:00Z"))).toBe("2026-11-05");
  });
  it("validates and shifts dates", () => {
    expect(isValidDate("2026-02-29")).toBe(false);
    expect(isValidDate("2028-02-29")).toBe(true);
    expect(addDays("2026-11-01", -6)).toBe("2026-10-26");
  });
});

describe("/admin/import (#9)", () => {
  async function importBatch(env: TestEnv, notes: unknown[]) {
    return worker.fetch(
      new Request("https://brain.example/admin/import", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": env.BRAIN_KEY ?? "" },
        body: JSON.stringify({ notes }),
      }),
      env,
    );
  }

  it("imports notes with source=import and is idempotent on re-run", async () => {
    const env = makeEnv();
    const batch = [
      { path: "Pitch.md", title: "Pitch", body: "Hi, I'm David with the window cleaning crew.", tags: [] },
      { path: "raw/Day 1.md", title: "Day 1", body: "First day out. 40 doors.", tags: ["raw"] },
    ];
    const res = await importBatch(env, batch);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ imported: 2, chunks: 2 });
    await importBatch(env, [{ ...batch[0], body: "Updated pitch." }, batch[1]]);

    const { results } = await env.DB.prepare("SELECT * FROM notes ORDER BY title").all<any>();
    expect(results.length).toBe(2);
    expect(results.every((r: any) => r.source === "import")).toBe(true);
    expect(results.find((r: any) => r.title === "Pitch").body).toBe("Updated pitch.");
    expect(results.find((r: any) => r.title === "Pitch").id).toBe(await idFromPath("Pitch.md"));
    expect(env.VECTORS.vectors.size).toBe(2);

    const search = await callTool(env, "ask_brain", { query: "updated pitch", kind: "note" });
    expect(search.results[0].note.title).toBe("Pitch");
  });

  it("rejects bad bodies and oversize batches", async () => {
    const env = makeEnv();
    expect((await importBatch(env, [])).status).toBe(400);
    const tooMany = Array.from({ length: 26 }, (_, i) => ({ path: `${i}.md`, title: `${i}`, body: "x" }));
    expect((await importBatch(env, tooMany)).status).toBe(400);
  });
});

describe("save_note when embeddings are down", () => {
  it("still saves the note once and warns", async () => {
    const env = makeEnv();
    env.AI.run = async () => {
      throw new Error("Workers AI quota exceeded");
    };
    const out = await callTool(env, "save_note", { title: "Idea", body: "Offer gutter add-on." });
    expect(out.saved).toBe(true);
    expect(out.index_warning).toMatch(/Do not save it again/);
    const { results } = await env.DB.prepare("SELECT id FROM notes").all();
    expect(results.length).toBe(1);
  });
});

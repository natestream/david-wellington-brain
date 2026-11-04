/**
 * One-time import of David's markdown notes (his Obsidian vault, including raw/) into the brain.
 *
 * Usage:
 *   BRAIN_KEY=... npm run import -- <folder> --url https://<worker>.workers.dev [--dry-run]
 *
 * - One note per .md file: title = file name, body = file content, source = import,
 *   tags = the folders it sits in (e.g. raw/2026-11-03.md → ["raw"]).
 * - Skips hidden folders (.obsidian, .trash, .git), non-markdown files and empty files.
 * - Long files are split into chunks on the server (one vector per chunk).
 * - Safe to re-run: each note's id comes from its path, so a re-run replaces, never duplicates.
 * - Sends 25 files per request to POST /admin/import with the x-brain-key header.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { chunkText } from "../src/lib/chunk";

const BATCH = 25;
/** Workers AI free tier: 10,000 neurons/day. bge-base-en-v1.5 costs about 6,100 neurons per million tokens. */
const NEURONS_PER_TOKEN = 6100 / 1_000_000;
const DAILY_NEURONS = 10_000;

interface FileNote {
  path: string;
  title: string;
  body: string;
  tags: string[];
}

function parseArgs(argv: string[]) {
  const args = { folder: "", url: process.env.BRAIN_URL ?? "", dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--url") args.url = argv[++i] ?? "";
    else if (a === "--dry-run") args.dryRun = true;
    else if (!a.startsWith("--")) args.folder = a;
  }
  return args;
}

function walk(root: string, dir = root, out: FileNote[] = []): FileNote[] {
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith(".")) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(root, full, out);
      continue;
    }
    if (!name.toLowerCase().endsWith(".md")) continue;
    const body = readFileSync(full, "utf8").trim();
    if (!body) continue;
    const rel = relative(root, full).split(sep).join("/");
    const folders = rel.split("/").slice(0, -1);
    out.push({
      path: rel,
      title: name.replace(/\.md$/i, ""),
      body,
      tags: folders.map((f) => f.toLowerCase().replace(/\s+/g, "-")),
    });
  }
  return out;
}

async function post(url: string, key: string, notes: FileNote[]): Promise<{ imported: number; chunks: number }> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${url.replace(/\/+$/, "")}/admin/import`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-brain-key": key },
      body: JSON.stringify({ notes }),
    });
    if (res.ok) return (await res.json()) as { imported: number; chunks: number };
    const text = await res.text();
    if (res.status === 401) throw new Error("401 unauthorized: check BRAIN_KEY");
    if (attempt >= 3) throw new Error(`HTTP ${res.status}: ${text}`);
    console.warn(`  retrying after HTTP ${res.status}…`);
    await new Promise((r) => setTimeout(r, 2000 * attempt));
  }
}

async function main() {
  const { folder, url, dryRun } = parseArgs(process.argv.slice(2));
  if (!folder) {
    console.error("Usage: BRAIN_KEY=... npm run import -- <folder> --url https://<worker>.workers.dev [--dry-run]");
    process.exit(1);
  }
  const notes = walk(folder);
  const chunks = notes.reduce((n, f) => n + chunkText(f.body).length, 0);
  const tokens = Math.ceil(notes.reduce((n, f) => n + f.title.length + f.body.length, 0) / 4);
  const neurons = Math.ceil(tokens * NEURONS_PER_TOKEN);

  console.log(`Found ${notes.length} markdown files (${chunks} chunks, ~${tokens.toLocaleString()} tokens).`);
  console.log(`Estimated Workers AI use: ~${neurons.toLocaleString()} neurons (free tier: ${DAILY_NEURONS.toLocaleString()}/day).`);
  if (neurons > DAILY_NEURONS * 0.8) {
    console.warn("That's close to or over one day's free tier. Split the folder and import part of it tomorrow.");
  }
  if (dryRun) {
    for (const n of notes) console.log(`  ${n.path}  [${n.tags.join(", ")}]`);
    console.log("Dry run: nothing sent.");
    return;
  }

  const key = process.env.BRAIN_KEY;
  if (!url || !key) {
    console.error("Set BRAIN_KEY in the environment and pass --url https://<worker>.workers.dev");
    process.exit(1);
  }

  let imported = 0;
  let sentChunks = 0;
  for (let i = 0; i < notes.length; i += BATCH) {
    const batch = notes.slice(i, i + BATCH);
    const res = await post(url, key, batch);
    imported += res.imported;
    sentChunks += res.chunks;
    console.log(`  ${imported}/${notes.length} imported`);
  }
  console.log(`Done: ${imported} notes, ${sentChunks} chunks embedded.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

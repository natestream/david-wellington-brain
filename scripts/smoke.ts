/**
 * Smoke test against a running Worker (wrangler dev or a real deploy), for the #11 checklist.
 *
 * Usage:
 *   BRAIN_KEY=... npm run smoke -- --url https://<worker>.workers.dev
 *   BRAIN_KEY=... npm run smoke -- --url https://<worker>.workers.dev --doors 60   # simulated full day
 *   BRAIN_KEY=... npm run smoke -- --url https://<worker>.workers.dev --health     # steps 1-2 only, writes nothing
 *   --cleanup-file <path>: also write the cleanup commands to a shell script (CI runs it after)
 *
 * What it checks (the same steps as the phone test, minus Claude):
 *   1. GET / answers; /mcp without the key or with a wrong key → 401
 *   2. tools/list shows all 6 tools
 *   3. log_door: 5 doors with mixed objections (or --doors N); similar_doors comes back once
 *      there is history, and there is no search_warning (= Workers AI + Vectorize work)
 *   4. save_daily_kpis: a sample Rotor pin export, then hours + ARR; KPIs match David's guide
 *   5. Re-saving the same day replaces the row (still 1 day, not 2)
 *   6. objection_stats and get_kpis for the week
 *   7. save_note + ask_brain find the note
 *
 * Everything is written as rep "smoke-test" on a random past week, so it never
 * mixes with David's numbers. Run it on Nate's account, not David's: Vectorize search is not
 * filtered by rep, so test doors could show up in his "similar doors". It prints the cleanup
 * commands at the end.
 */
import { writeFileSync } from "node:fs";

const REP = "smoke-test";
// Each run uses its own random past week (a Monday in 2015-2024), so re-runs never see each other's data.
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const MONDAY = addDays("2015-01-05", 7 * Math.floor(Math.random() * 520));
const DAY = addDays(MONDAY, 1);
const SUNDAY = addDays(MONDAY, 6);
const TOOLS = ["log_door", "objection_stats", "save_daily_kpis", "get_kpis", "save_note", "ask_brain"];

function parseArgs(argv: string[]) {
  const args = { url: process.env.BRAIN_URL ?? "", doors: 5, health: false, cleanupFile: "" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--url") args.url = argv[++i] ?? "";
    else if (argv[i] === "--doors") args.doors = Number(argv[++i]);
    else if (argv[i] === "--health") args.health = true;
    else if (argv[i] === "--cleanup-file") args.cleanupFile = argv[++i] ?? "";
  }
  return args;
}

const { url, doors: doorCount, health, cleanupFile } = parseArgs(process.argv.slice(2));
const key = process.env.BRAIN_KEY ?? "";
if (!url || !key || !Number.isInteger(doorCount) || doorCount < 1) {
  console.error("Usage: BRAIN_KEY=... npm run smoke -- --url https://<worker>.workers.dev [--doors 60] [--health] [--cleanup-file path]");
  process.exit(2);
}
const base = url.replace(/\/+$/, "");

let failures = 0;
let warnings = 0;
const pass = (msg: string) => console.log(`  PASS  ${msg}`);
const fail = (msg: string) => (failures++, console.log(`  FAIL  ${msg}`));
const warn = (msg: string) => (warnings++, console.log(`  WARN  ${msg}`));
const check = (cond: boolean, msg: string) => (cond ? pass(msg) : fail(msg));
const near = (a: unknown, b: number) => typeof a === "number" && Math.abs(a - b) < 0.001;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let rpcId = 1;
async function rpc(method: string, params: unknown, headerKey: string | null = key) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (headerKey !== null) headers["x-brain-key"] = headerKey;
  return fetch(`${base}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
  });
}

async function tool<T = any>(name: string, args: Record<string, unknown>): Promise<T> {
  const res = await rpc("tools/call", { name, arguments: args });
  if (res.status !== 200) throw new Error(`${name}: HTTP ${res.status} ${await res.text()}`);
  const body = (await res.json()) as any;
  if (body.error) throw new Error(`${name}: ${JSON.stringify(body.error)}`);
  const text = body.result?.content?.[0]?.text ?? "";
  if (body.result?.isError) throw new Error(`${name}: ${text}`);
  return JSON.parse(text) as T;
}

// Mixed objections, cycled for --doors > 5. Two "price" doors so objection history kicks in.
const SAMPLE_DOORS = [
  { outcome: "gave_pitch", objection_type: "price", objection_text: "Too expensive, we just paid for gutters", response: "Offered a smaller first job, front windows only", area: "Elm St" },
  { outcome: "made_sale", objection_type: "price", objection_text: "That's more than I expected", response: "Broke it down per month and offered the first clean at half off", amount: 600, area: "Elm St" },
  { outcome: "go_back", objection_type: "spouse", objection_text: "I need to ask my wife", response: "Asked when she's home, coming back Thursday", area: "Oak Ave" },
  { outcome: "not_interested", objection_type: "has_someone", objection_text: "We already have a window guy", response: "Left a card in case they switch", area: "Oak Ave" },
  { outcome: "no_answer", area: "Pine Ct", notes: "Dog barking, try evenings" },
];

async function main() {
  console.log(`Smoke test against ${base} (rep "${REP}", week of ${MONDAY})\n`);

  console.log("1. Health + auth");
  const home = await fetch(`${base}/`);
  check(home.status === 200, `GET / → ${home.status}`);
  for (const [label, k] of [["no key", null], ["wrong key", "wrong-key"]] as const) {
    const res = await rpc("tools/list", {}, k);
    check(res.status === 401, `${label} → ${res.status} (want 401)`);
  }
  const qs = await fetch(`${base}/mcp?x-brain-key=${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method: "tools/list", params: {} }),
  });
  check(qs.status === 401, `key in query string → ${qs.status} (want 401)`);
  const listBody = JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method: "tools/list", params: {} });
  const baseHeaders = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  const viaBearer = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { ...baseHeaders, authorization: `Bearer ${key}` },
    body: listBody,
  });
  check(viaBearer.status === 200, `Authorization: Bearer → ${viaBearer.status} (want 200)`);
  const viaPath = await fetch(`${base}/mcp/${encodeURIComponent(key)}`, { method: "POST", headers: baseHeaders, body: listBody });
  check(viaPath.status === 200, `key in path /mcp/<key> → ${viaPath.status} (want 200)`);

  console.log("\n2. Tools");
  const list = (await (await rpc("tools/list", {})).json()) as any;
  const names: string[] = (list.result?.tools ?? []).map((t: any) => t.name);
  check(TOOLS.every((t) => names.includes(t)), `tools/list: ${names.join(", ")}`);

  if (health) {
    console.log(`\n${failures === 0 ? "HEALTH CHECK PASSED" : `${failures} FAILED`} (--health: nothing was written)`);
    process.exit(failures === 0 ? 0 : 1);
  }

  console.log(`\n3. log_door × ${doorCount}`);
  let searchWarnings = 0;
  let withSimilar = 0;
  for (let i = 0; i < doorCount; i++) {
    const door = SAMPLE_DOORS[i % SAMPLE_DOORS.length]!;
    const r = await tool("log_door", { ...door, rep: REP, date: DAY, coaching: "Smoke test door." });
    doorIds.push(r.id);
    if (r.search_warning) {
      searchWarnings++;
      if (searchWarnings === 1) fail(`search_warning on door ${i + 1}: ${r.search_warning}`);
    }
    if (r.similar_doors?.length) withSimilar++;
    if (doorCount <= 5) {
      console.log(`        door ${i + 1} (${door.outcome}${door.objection_type ? `, ${door.objection_type}` : ""}): ` +
        `${r.similar_doors?.length ?? 0} similar, objection history ${r.objection_history ? `${r.objection_history.count} before` : "none"}`);
    }
    // Vectorize inserts take a few seconds to become searchable; space the doors out a little.
    await sleep(doorCount <= 5 ? 4000 : 500);
  }
  check(doorIds.length === doorCount, `${doorIds.length} doors saved`);
  if (searchWarnings === 0) pass("no search warnings (Workers AI + Vectorize OK)");
  if (withSimilar > 0) pass(`${withSimilar} of ${doorCount} doors came back with similar past doors`);
  else warn("no door came back with similar_doors. Vectorize can take a minute to index new vectors; run again and check door 1's history shows up");

  console.log("\n4. save_daily_kpis (sample Rotor export, then hours + ARR)");
  // Sample export: adjusted = 61-4-2-5 = 50, answered = 50-25 = 25, pitches = 12+3 = 15, plans = 3.
  const pins = { total: 61, gave_pitch: 12, go_back: 4, never_knock: 2, door_hanger: 5, no_answer: 25, not_interested: 10, made_sale: 3 };
  const first = await tool("save_daily_kpis", { ...pins, rep: REP, date: DAY, source: "pdf", raw_summary: "smoke test export" });
  check(first.warnings?.some((w: string) => w.includes("hours_knocked")) ?? false, "asks for hours + ARR when they're missing");
  const full = await tool("save_daily_kpis", { rep: REP, date: DAY, hours_knocked: 5, arr_sold: 1800 });
  const k = full.kpis;
  const expect: Record<string, number> = {
    doors_per_hour: 10, answer_rate: 0.5, backyard_rate: 0.6, conversion_rate: 0.2, revenue_per_hour: 360, avg_arr_per_plan: 600,
  };
  for (const [name, want] of Object.entries(expect)) check(near(k?.[name], want), `${name} = ${k?.[name]} (want ${want})`);
  check(full.saved?.total === 61, "pin counts kept when only hours + ARR were sent");
  console.log(`        ${full.logged_vs_rotor?.summary}`);

  console.log("\n5. Re-upload the same day");
  await tool("save_daily_kpis", { ...pins, rep: REP, date: DAY, source: "pdf" });
  const day = await tool("get_kpis", { rep: REP, from: DAY, to: DAY, group_by: "none" });
  check(day.totals?.days === 1, `still 1 row for ${DAY} (got ${day.totals?.days})`);
  check(near(day.totals?.kpis?.revenue_per_hour, 360), "hours + ARR survived the re-upload");

  console.log("\n6. objection_stats + get_kpis for the week");
  const stats = await tool("objection_stats", { rep: REP, from: MONDAY, to: SUNDAY });
  const price = stats.objections?.find((o: any) => o.objection_type === "price");
  const pricePerCycle = SAMPLE_DOORS.filter((d) => d.objection_type === "price").length;
  const wantPrice = Math.floor(doorCount / SAMPLE_DOORS.length) * pricePerCycle + Math.min(doorCount % SAMPLE_DOORS.length, pricePerCycle);
  check(price?.count === wantPrice, `price objections: ${price?.count} (want ${wantPrice}), sale rate ${price?.sale_rate}`);
  const week = await tool("get_kpis", { rep: REP, from: MONDAY, to: SUNDAY, group_by: "week" });
  check(week.rows?.length === 1 && week.rows[0]?.period === MONDAY, `1 week row starting ${week.rows?.[0]?.period ?? "?"} (want ${MONDAY})`);

  console.log("\n7. save_note + ask_brain");
  const note = await tool("save_note", {
    title: "Smoke test: gutter objection",
    body: "When they say they just paid for gutters, offer front windows only as a smaller first job.",
    tags: ["smoke-test"],
  });
  noteId = note.id;
  check(note.saved === true, `note saved (${note.id})`);
  if (note.index_warning) fail(`note warning: ${note.index_warning}`);
  await sleep(5000);
  try {
    const found = await tool("ask_brain", { query: "what do I say when they just paid for gutters", kind: "note" });
    if (found.results?.some((r: any) => r.note?.id === note.id)) pass("ask_brain found the note");
    else warn("ask_brain didn't find the note yet (Vectorize indexing delay?); try again in a minute");
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} FAILED`}${warnings ? `, ${warnings} warning(s)` : ""}`);
  printCleanup();
  process.exit(failures === 0 ? 0 : 1);
}

// Test data this run wrote, so it can be cleaned up even if a later step crashed.
const doorIds: string[] = [];
let noteId: string | null = null;

function cleanupCommands(): string[] {
  const vectorIds = [...doorIds.map((id) => `door:${id}`), ...(noteId ? [`note:${noteId}#0`] : [])];
  return [
    // Deletes every smoke-test run's rows, not just this one's.
    `npx wrangler d1 execute DB --remote --command "DELETE FROM doors WHERE rep='${REP}'; DELETE FROM daily_kpis WHERE rep='${REP}'; DELETE FROM notes WHERE tags LIKE '%\\"smoke-test\\"%';"`,
    ...(vectorIds.length ? [`npx wrangler vectorize delete-vectors david-brain-notes --ids ${vectorIds.join(" ")}`] : []),
  ];
}

function printCleanup() {
  const cmds = cleanupCommands();
  console.log(`\nCleanup (run from this repo, logged in to the same account):\n${cmds.map((c) => `  ${c}`).join("\n")}`);
  if (cleanupFile) writeFileSync(cleanupFile, `#!/usr/bin/env bash\nset -euo pipefail\n${cmds.join("\n")}\n`);
}

main().catch((err) => {
  console.error(`\nFAIL  ${err instanceof Error ? err.message : String(err)}`);
  printCleanup();
  process.exit(1);
});

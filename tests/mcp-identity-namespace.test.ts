import { strict as assert } from "node:assert";
import { beforeEach, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import worker from "../src/index";
import { createMemory } from "../src/db/memories";
import { getYesterdayDateLabel } from "../src/memory/dreamDates";
import { formatDateLabel } from "../src/utils/time";

// identity MCP namespace binding: memory_boot / memory_list / memory_ingest must
// read and write only the namespace fixed by /mcp/:identity. A forged namespace
// argument cannot cross spaces. The global /mcp path keeps its legacy behavior.

(crypto.subtle as any).timingSafeEqual = (a: Uint8Array, b: Uint8Array) => timingSafeEqual(a, b);

let sqlite: DatabaseSync;
let db: any;
let env: any;
let ctx: any;
let pending: Promise<unknown>[];
const TZ = "Asia/Singapore";

const identity = (namespace: string, keys = ["CHATBOX_API_KEY", "MEMORY_MCP_API_KEY"]): any => ({
  slug: namespace, namespace, keys, models: [namespace]
});

function setConfig(identities: any[]) {
  env.GATEWAY_CONFIG = JSON.stringify({
    version: 3,
    upstream: { address: "https://upstream.test/ai/v1" },
    identities
  });
}

beforeEach(() => {
  sqlite?.close(); sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync("migrations").filter((f: string) => f.endsWith(".sql")).sort()) {
    try { sqlite.exec(readFileSync(`migrations/${file}`, "utf8")); }
    catch (error) { if (!String(error).includes("fts5")) throw error; }
  }
  db = { prepare(sql: string) {
    const statement = sqlite.prepare(sql); let args: any[] = [];
    const api = { bind(...values: any[]) { args = values; return api; },
      async first() { return statement.get(...args) || null; },
      async all() { return { results: statement.all(...args) }; },
      async run() { const r = statement.run(...args); return { meta: { changes: r.changes } }; }
    }; return api;
  }, async batch(statements: any[]) {
    sqlite.exec("BEGIN");
    try { const results = []; for (const statement of statements) results.push(await statement.run()); sqlite.exec("COMMIT"); return results; }
    catch (e) { sqlite.exec("ROLLBACK"); throw e; }
  } };
  pending = [];
  ctx = { waitUntil(p: Promise<unknown>) { pending.push(p); } };
  env = { DB: db, CHATBOX_API_KEY: "owner-key", MEMORY_MCP_API_KEY: "mcp-key",
    VECTORIZE: { async getByIds() { return []; }, async deleteByIds() {}, async query() { return { matches: [] }; } } };
  setConfig([identity("alice"), identity("bob")]);
});

async function run(path: string, body?: any, key = "mcp-key") {
  const response = await worker.fetch(new Request(`https://aelios.test${path}`, {
    method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {})
  }), env, ctx);
  const text = await response.text();
  await Promise.all(pending);
  return { response, text };
}

async function mcpCall(path: string, name: string, args: any) {
  const { text } = await run(path, {
    jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args }
  });
  return JSON.parse(text);
}

async function listAt(path: string) {
  const { text } = await run(path, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  return JSON.parse(text).result.tools as any[];
}

async function seedMemory(namespace: string, content: string) {
  await createMemory(db, { namespace, type: "fact", content });
}

test("identity memory_list reads only the bound namespace even with a forged namespace", async () => {
  await seedMemory("alice", "alice-only memory");
  await seedMemory("default", "default memory");
  await seedMemory("bob", "bob memory");

  for (const args of [{}, { namespace: "bob" }, { namespace: "default" }]) {
    const out = await mcpCall("/mcp/alice", "memory_list", args);
    const contents = out.result.structuredContent.data.map((row: any) => row.content);
    assert.deepEqual(contents, ["alice-only memory"], `args=${JSON.stringify(args)}`);
  }
});

test("identity memory_ingest writes only the bound namespace even with a forged namespace", async () => {
  for (const args of [{}, { namespace: "bob" }, { namespace: "default" }]) {
    const out = await mcpCall("/mcp/alice", "memory_ingest", {
      messages: [{ role: "user", content: "hello" }],
      ...args
    });
    assert.equal(out.result.isError, undefined);
    assert.equal(out.result.structuredContent.data.conversation_id, "alice:default");
  }
  const messageNamespaces = (sqlite.prepare("SELECT DISTINCT namespace FROM messages").all() as any[])
    .map((row) => row.namespace);
  const conversationNamespaces = (sqlite.prepare("SELECT DISTINCT namespace FROM conversations").all() as any[])
    .map((row) => row.namespace);
  assert.deepEqual(messageNamespaces, ["alice"]);
  assert.deepEqual(conversationNamespaces, ["alice"]);
});

test("memory_ingest reuses an existing conversation in the same namespace", async () => {
  const first = await mcpCall("/mcp/alice", "memory_ingest", {
    messages: [{ role: "user", content: "first" }],
    conversation_id: "alice-conv"
  });
  assert.equal(first.result.isError, undefined);
  const second = await mcpCall("/mcp/alice", "memory_ingest", {
    messages: [{ role: "user", content: "second" }],
    conversation_id: "alice-conv"
  });
  assert.equal(second.result.isError, undefined);
  assert.equal(second.result.structuredContent.data.conversation_id, "alice-conv");
  assert.notEqual(second.result.structuredContent.data.message_ids[0], first.result.structuredContent.data.message_ids[0]);
  assert.equal((sqlite.prepare("SELECT count(*) AS n FROM conversations WHERE id = 'alice-conv'").get() as any).n, 1);
  assert.equal((sqlite.prepare("SELECT count(*) AS n FROM messages WHERE conversation_id = 'alice-conv'").get() as any).n, 2);
});

test("memory_ingest rejects a conversation_id owned by another namespace and writes no messages", async () => {
  const bob = await mcpCall("/mcp/bob", "memory_ingest", {
    messages: [{ role: "user", content: "bob message" }],
    conversation_id: "shared-conv"
  });
  assert.equal(bob.result.isError, undefined);
  const before = (sqlite.prepare("SELECT count(*) AS n FROM messages").get() as any).n;

  const rejected = await mcpCall("/mcp/alice", "memory_ingest", {
    messages: [{ role: "user", content: "alice message" }],
    conversation_id: "shared-conv"
  });
  assert.equal(rejected.result.isError, true);
  assert.match(rejected.result.content[0].text, /another namespace/);
  assert.equal((sqlite.prepare("SELECT count(*) AS n FROM messages").get() as any).n, before);
  assert.equal((sqlite.prepare("SELECT count(*) AS n FROM messages WHERE namespace = 'alice'").get() as any).n, 0);
});

test("identity v1 memory_get and memory_delete hide and refuse cross-namespace targets", async () => {
  env.MEMORY_LIFECYCLE_ENABLED = "false";
  const aliceMemory = await createMemory(db, { namespace: "alice", type: "fact", content: "alice v1" });
  const bobMemory = await createMemory(db, { namespace: "bob", type: "fact", content: "bob v1" });

  const own = await mcpCall("/mcp/alice", "memory_get", { id: aliceMemory.id });
  assert.equal(own.result.structuredContent.data.content, "alice v1");

  const crossRead = await mcpCall("/mcp/alice", "memory_get", { id: bobMemory.id });
  const missing = await mcpCall("/mcp/alice", "memory_get", { id: "mem_missing" });
  assert.equal(crossRead.result.isError, true);
  assert.equal(crossRead.result.content[0].text, "Memory not found");
  assert.deepEqual(crossRead.result, missing.result);

  const crossDelete = await mcpCall("/mcp/alice", "memory_delete", { id: bobMemory.id });
  assert.equal(crossDelete.result.isError, true);
  assert.equal(crossDelete.result.content[0].text, "Memory not found");
  assert.equal((sqlite.prepare("SELECT status FROM memories WHERE id = ?").get(bobMemory.id) as any).status, "active");

  const ownDelete = await mcpCall("/mcp/alice", "memory_delete", { id: aliceMemory.id });
  assert.equal(ownDelete.result.isError, undefined);
  assert.equal((sqlite.prepare("SELECT status FROM memories WHERE id = ?").get(aliceMemory.id) as any).status, "deleted");

  const globalRead = await mcpCall("/mcp", "memory_get", { id: bobMemory.id });
  assert.equal(globalRead.result.structuredContent.data.namespace, "bob");
  const globalDelete = await mcpCall("/mcp", "memory_delete", { id: bobMemory.id });
  assert.equal(globalDelete.result.isError, undefined);
  assert.equal((sqlite.prepare("SELECT status FROM memories WHERE id = ?").get(bobMemory.id) as any).status, "deleted");
});

test("global /mcp keeps the legacy profile namespace for list and ingest", async () => {
  await seedMemory("alice", "alice-only memory");
  await seedMemory("default", "default memory");
  await seedMemory("bob", "bob memory");

  const listed = await mcpCall("/mcp", "memory_list", { namespace: "bob" });
  assert.deepEqual(listed.result.structuredContent.data.map((row: any) => row.content), ["default memory"]);

  const ingested = await mcpCall("/mcp", "memory_ingest", {
    messages: [{ role: "user", content: "hello" }],
    namespace: "bob"
  });
  assert.equal(ingested.result.structuredContent.data.conversation_id, "default:default");
  const messageNamespaces = (sqlite.prepare("SELECT DISTINCT namespace FROM messages").all() as any[])
    .map((row) => row.namespace);
  assert.deepEqual(messageNamespaces, ["default"]);
});

function seedBootData(namespace: string, label: string, yesterday: string, today: string) {
  sqlite.prepare(
    "INSERT INTO precious (id, namespace, content, source, pinned, created_at) VALUES (?, ?, ?, 'human', 1, ?)"
  ).run(`pcz-${label}`, namespace, `${label} precious`, "2026-10-24T00:00:00Z");
  sqlite.prepare(
    "INSERT INTO glossary (id, namespace, term, definition, status, updated_at) VALUES (?, ?, ?, ?, 'active', ?)"
  ).run(`glo-${label}`, namespace, `${label}-term`, `${label} definition`, "2026-10-24T00:00:00Z");
  sqlite.prepare(
    `INSERT INTO daily_log (namespace, date, title, summary, updated_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(namespace, yesterday, `${label} day`, `${label} daily`, "2026-10-24T00:00:00Z");
  sqlite.prepare(
    `INSERT INTO weekly_log (namespace, week, start_date, end_date, title, summary, source_days, updated_at)
     VALUES (?, '2026-W43', '2026-10-19', '2026-10-25', ?, ?, 1, ?)`
  ).run(namespace, `${label} week`, `${label} weekly`, "2026-10-24T00:00:00Z");
  sqlite.prepare(
    `INSERT INTO monthly_log (namespace, month, title, summary, source_week_count, created_at, updated_at)
     VALUES (?, '2026-10', ?, ?, 1, ?, ?)`
  ).run(namespace, `${label} month`, `${label} monthly`, "2026-10-24T00:00:00Z", "2026-10-24T00:00:00Z");
  sqlite.prepare(
    "INSERT INTO perception_cache (namespace, date, items, created_at) VALUES (?, ?, ?, ?)"
  ).run(namespace, today, JSON.stringify([{ id: `per-${label}`, content: `${label} spontaneous`, importance: 0.9 }]),
    "2026-10-24T00:00:00Z");
}

test("identity memory_boot composes every section from the bound namespace, never default", async () => {
  const yesterday = getYesterdayDateLabel(TZ);
  const today = formatDateLabel(new Date(), TZ);
  seedBootData("alice", "alice", yesterday, today);
  seedBootData("default", "default", yesterday, today);

  const out = await mcpCall("/mcp/alice", "memory_boot", { namespace: "default" });
  const pkg = out.result.structuredContent.data;
  assert.deepEqual(pkg.precious.map((row: any) => row.content), ["alice precious"]);
  assert.deepEqual(pkg.glossary.map((row: any) => row.term), ["alice-term"]);
  assert.equal(pkg.impressions.daily.summary, "alice daily");
  assert.equal(pkg.impressions.weekly.summary, "alice weekly");
  assert.equal(pkg.impressions.monthly.summary, "alice monthly");
  assert.deepEqual(pkg.spontaneous.map((row: any) => row.content), ["alice spontaneous"]);

  const global = await mcpCall("/mcp", "memory_boot", { namespace: "alice" });
  const globalPkg = global.result.structuredContent.data;
  assert.deepEqual(globalPkg.precious.map((row: any) => row.content), ["default precious"]);
  assert.deepEqual(globalPkg.glossary.map((row: any) => row.term), ["default-term"]);
  assert.equal(globalPkg.impressions.daily.summary, "default daily");
  assert.equal(globalPkg.impressions.weekly.summary, "default weekly");
  assert.equal(globalPkg.impressions.monthly.summary, "default monthly");
  assert.deepEqual(globalPkg.spontaneous.map((row: any) => row.content), ["default spontaneous"]);
});

test("tools schema removes namespace from every identity tool and keeps it on the global route", async () => {
  const globalNamespaceTools = [
    "memory_search", "memory_list", "memory_export", "memory_get", "memory_delete",
    "memory_ingest", "memory_boot", "memory_recall", "memory_pin", "glossary_set",
    "memory_upsert", "memory_supersede", "memory_archive"
  ];
  const scoped = await listAt("/mcp/alice");
  assert.ok(scoped.length > 0);
  for (const tool of scoped) {
    assert.equal(tool.inputSchema?.properties?.namespace, undefined,
      `${tool.name} must not expose namespace under /mcp/alice`);
  }
  const global = await listAt("/mcp");
  for (const name of globalNamespaceTools) {
    assert.ok(global.find((tool) => tool.name === name).inputSchema.properties.namespace,
      `${name} must keep namespace on global /mcp`);
  }
  const get = await run("/mcp/alice", undefined);
  assert.equal(get.response.status, 200);
  const advertised = JSON.parse(get.text).tools;
  assert.ok(globalNamespaceTools.every((name) => advertised.includes(name)));
});

test("unknown identity and keys outside the identity keep their previous errors", async () => {
  const unknown = await run("/mcp/ghost", {
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "memory_list", arguments: {} }
  });
  assert.equal(unknown.response.status, 404);
  assert.match(JSON.parse(unknown.text).error.message, /No identity "ghost"/);

  setConfig([identity("alice"), { ...identity("bob"), keys: ["CHATBOX_API_KEY"] }]);
  const forbidden = await run("/mcp/bob", {
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "memory_list", arguments: {} }
  });
  assert.equal(forbidden.response.status, 404);

  const allowed = await mcpCall("/mcp/alice", "memory_list", {});
  assert.equal(allowed.result.isError, undefined);
});

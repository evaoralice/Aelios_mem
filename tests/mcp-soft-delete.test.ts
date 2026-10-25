import { strict as assert } from "node:assert";
import { test, beforeEach } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import worker from "../src/index";
import { createMemory } from "../src/db/memories";
import { supersedeMemory, upsertMemoryByFactKey } from "../src/db/v2/memories";

// P5-A MCP memory_delete 软删除验收（行为模板 = 旧分支 4cc0263）：
//   删除 = status='deleted'，D1 行与 lifecycle/版本链保留（可恢复、供核查/迁移）；
//   向量 best-effort 删除（失败只记日志，不回滚软删、不向调用方谎报失败）；
//   已删除/跨 namespace/不存在保持未命中（MCP 工具面契约与硬删时代一致）；
//   删除后 MCP 正常读面（get/search/list）不可见。
// REST DELETE /v1/memories/:id 的软删行为不变（上游已有），本文件不重测 REST。

let sqlite: DatabaseSync;
let db: any;
let env: any;
let ctx: any;
let pending: Promise<unknown>[];

(crypto.subtle as any).timingSafeEqual = (a: Uint8Array, b: Uint8Array) => timingSafeEqual(a, b);

const identity = (namespace?: string): any => ({ slug: namespace || "sol", namespace: namespace || "sol",
  keys: ["CHATBOX_API_KEY", "MEMORY_MCP_API_KEY"], models: [namespace || "sol"] });

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
    AI: { async run(_model: string, _data: any) {
      return { data: [{ embedding: [0.1, 0.2, 0.3] }] };
    } },
    VECTORIZE: { async getByIds() { return []; }, async query() { return { matches: [] }; }, async upsert() {}, async deleteByIds() {} } as any };
  globalThis.fetch = (async (_url: any, init: any) =>
    Response.json({ model: "actual", choices: [{ index: 0, message: { content: "ok" }, finish_reason: "stop" }] })
  ) as any;
  env.GATEWAY_CONFIG = JSON.stringify({ version: 3, upstream: { address: "https://upstream.test/ai/v1" },
    identities: [identity("sol")] });
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

async function mcpCall(name: string, args: any) {
  const out = await run("/mcp/sol", {
    jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args }
  });
  return JSON.parse(out.text);
}

const rawRow = (id: string): Record<string, any> | undefined =>
  sqlite.prepare("SELECT * FROM memories WHERE id = ?").get(id) as Record<string, any> | undefined;

const lifecycleRow = (memoryId: string): Record<string, any> | undefined =>
  sqlite.prepare("SELECT * FROM memory_lifecycle WHERE memory_id = ?").get(memoryId) as
    Record<string, any> | undefined;

test("MCP delete hides the memory from normal get/search/list while the D1 row survives as deleted", async () => {
  const m = await createMemory(db, { namespace: "sol", type: "fact", content: "调试暗号是芝麻开门" });
  const del = await mcpCall("memory_delete", { id: m.id });
  assert.equal(del.result.isError, undefined, "first delete succeeds");
  assert.equal(del.result.structuredContent.data.deleted, true);

  const got = await mcpCall("memory_get", { id: m.id });
  assert.equal(got.result.isError, true, "get must miss the soft-deleted row");
  const searched = await mcpCall("memory_search", { query: "芝麻开门" });
  assert.equal(JSON.parse(JSON.stringify(searched.result.structuredContent)).data.length, 0, "search must not return deleted");
  const listed = await mcpCall("memory_list", {});
  assert.equal(JSON.parse(JSON.stringify(listed.result.structuredContent)).data.length, 0, "list (default active) must not show deleted");

  const row = rawRow(m.id);
  assert.ok(row, "physical D1 row must survive");
  assert.equal(row.status, "deleted");
});

test("MCP delete keeps lifecycle sidecar and supersede chain intact", async () => {
  const first = await upsertMemoryByFactKey(env, { namespace: "sol", factKey: "k1", content: "v1" });
  const { newId } = await supersedeMemory(env, { namespace: "sol", oldId: first.id, newContent: "v2" });

  const del = await mcpCall("memory_delete", { id: newId });
  assert.equal(del.result.isError, undefined);

  const oldLc = lifecycleRow(first.id);
  const newLc = lifecycleRow(newId);
  assert.ok(oldLc, "old sidecar row must survive");
  assert.ok(newLc, "superseded (new) sidecar row must survive");
  assert.equal(oldLc.superseded_by_id, newId, "version chain link kept on old row");
  assert.equal(newLc.supersedes_id, first.id, "version chain link kept on deleted row");
  const oldMemory = rawRow(first.id);
  const newMemory = rawRow(newId);
  assert.ok(oldMemory); assert.ok(newMemory);
  assert.equal(oldMemory.status, "superseded");
  assert.equal(newMemory.status, "deleted");
});

test("vector delete failure still soft-deletes D1 and the tool reports success", async () => {
  const m = await createMemory(db, { namespace: "sol", type: "fact", content: "x" });
  sqlite.prepare("UPDATE memories SET vector_id = ? WHERE id = ?").run(`mem_${m.id}`, m.id);
  env.VECTORIZE.deleteByIds = async () => { throw Error("vectorize unavailable"); };

  const del = await mcpCall("memory_delete", { id: m.id });
  assert.equal(del.result.isError, undefined, "vector failure must not surface to the caller");
  assert.equal(del.result.structuredContent.data.deleted, true);
  const delRow = rawRow(m.id);
  assert.ok(delRow);
  assert.equal(delRow.status, "deleted", "D1 soft delete must not roll back");
});

test("deleting twice misses, and a foreign-namespace row is never touched", async () => {
  const m = await createMemory(db, { namespace: "sol", type: "fact", content: "x" });
  const foreign = await createMemory(db, { namespace: "ns-b", type: "fact", content: "secret" });

  const first = await mcpCall("memory_delete", { id: m.id });
  assert.equal(first.result.isError, undefined);
  const second = await mcpCall("memory_delete", { id: m.id });
  assert.equal(second.result.isError, true, "second delete must miss (already deleted)");
  assert.match(second.result.content[0].text, /not found/i);

  const foreignAttempt = await mcpCall("memory_delete", { id: foreign.id });
  assert.equal(foreignAttempt.result.isError, true, "cross-namespace delete must miss");
  const foreignRow = rawRow(foreign.id);
  assert.ok(foreignRow);
  assert.equal(foreignRow.status, "active", "foreign namespace row must stay untouched");
  assert.equal(foreignRow.namespace, "ns-b");
});
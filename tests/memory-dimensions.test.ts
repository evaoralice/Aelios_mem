import { strict as assert } from "node:assert";
import { test, beforeEach } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import worker from "../src/index";
import { computeWeight } from "../src/extensions/memoryWeight";
import { createMemory, getMemoryById, updateMemory } from "../src/db/memories";
import { supersedeMemory, upsertMemoryByFactKey } from "../src/db/v2/memories";
import { createVectorMemory, updateVectorMemory } from "../src/memory/vectorStore";

// P2 四维存储与写入保持验收（plan 工作包 P2，P0「已裁定」节为契约）：
// 新建默认值、局部更新重算、未提供维度继承旧值、所有写入路径不静默归零、MCP 边缘规则。
// weight 一律等于 computeWeight 输出（P1 唯一权威实现），不复制公式。

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
    // vector 路径需要的 embedding mock（bge-m3），reranker 在本测试不用。
    AI: { async run(model: string, _data: any) {
      return { data: [{ embedding: [0.1, 0.2, 0.3] }] };
    } },
    VECTORIZE: { async getByIds() { return []; }, async upsert() {}, async deleteByIds() {} } as any };
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

const row = (id: string) => getMemoryById(db, { namespace: "sol", id });

test("createMemory 新建默认：0.5/0/0/0，weight=0.175 落库（0018 列）", async () => {
  const m = await createMemory(db, { namespace: "sol", type: "fact", content: "默认" });
  assert.equal(m.importance, 0.5);
  assert.equal(m.emotional, 0);
  assert.equal(m.recurrence, 0);
  assert.equal(m.unresolved, 0);
  assert.equal(m.weight, 0.175);
  const stored = await row(m.id);
  assert.equal(stored?.weight, 0.175);
});

test("createMemory 显式四维：weight 等于 computeWeight 输出", async () => {
  const dims = { importance: 0.8, emotional: 0.6, recurrence: 0.4, unresolved: 0.2 };
  const m = await createMemory(db, { namespace: "sol", type: "fact", content: "x", ...dims });
  assert.equal(m.weight, computeWeight(dims));
  assert.equal(m.weight, 0.56);
});

test("updateMemory 局部维度：提供 emotional 重算 weight，其余维度继承现有值", async () => {
  const m = await createMemory(db, { namespace: "sol", type: "fact", content: "x",
    importance: 0.8, emotional: 0.6, recurrence: 0.4, unresolved: 0.2 });
  const updated = await updateMemory(db, { namespace: "sol", id: m.id, patch: { emotional: 0.9 } });
  assert.equal(updated?.emotional, 0.9);
  assert.equal(updated?.importance, 0.8);
  assert.equal(updated?.recurrence, 0.4);
  assert.equal(updated?.unresolved, 0.2);
  assert.equal(updated?.weight, computeWeight({ importance: 0.8, emotional: 0.9, recurrence: 0.4, unresolved: 0.2 }));
});

test("updateMemory 纯文本补丁：不重算 weight、不归零维度（条件重算，裁定 #5）", async () => {
  const m = await createMemory(db, { namespace: "sol", type: "fact", content: "x",
    importance: 0.8, emotional: 0.6, recurrence: 0.4, unresolved: 0.2 });
  const updated = await updateMemory(db, { namespace: "sol", id: m.id, patch: { content: "改文本" } });
  assert.equal(updated?.weight, 0.56);
  assert.equal(updated?.emotional, 0.6);
  assert.equal(updated?.recurrence, 0.4);
  assert.equal(updated?.unresolved, 0.2);
});

test("upsert 新建默认：0.6/0/0/0，weight=0.21", async () => {
  const r = await upsertMemoryByFactKey(env, { namespace: "sol", factKey: "k1", content: "x" });
  assert.equal(r.created, true);
  const stored = await row(r.id);
  assert.equal(stored?.importance, 0.6);
  assert.equal(stored?.emotional, 0);
  assert.equal(stored?.weight, 0.21);
});

test("upsert 命中：真省略(undefined)时四维全继承、weight 重算，importance 不再重置 0.6", async () => {
  await upsertMemoryByFactKey(env, { namespace: "sol", factKey: "k2", content: "v1",
    importance: 0.9, emotional: 0.8, recurrence: 0.7, unresolved: 0.6 });
  const hit = await upsertMemoryByFactKey(env, { namespace: "sol", factKey: "k2", content: "v2" });
  assert.equal(hit.created, false);
  const stored = await row(hit.id);
  assert.equal(stored?.importance, 0.9);
  assert.equal(stored?.emotional, 0.8);
  assert.equal(stored?.recurrence, 0.7);
  assert.equal(stored?.unresolved, 0.6);
  assert.equal(stored?.weight, computeWeight({ importance: 0.9, emotional: 0.8, recurrence: 0.7, unresolved: 0.6 }));
});

test("supersede 恒继承旧四维，weight 与旧条一致（裁定 #3）", async () => {
  const base = await createMemory(db, { namespace: "sol", type: "world_fact", content: "旧事实",
    importance: 0.9, emotional: 0.8, recurrence: 0.7, unresolved: 0.6 });
  const { newId, oldStatus } = await supersedeMemory(env, {
    namespace: "sol", oldId: base.id, newContent: "新事实", newType: "world_fact"
  });
  assert.equal(oldStatus, "active");
  const fresh = await row(newId);
  assert.equal(fresh?.importance, 0.9);
  assert.equal(fresh?.emotional, 0.8);
  assert.equal(fresh?.recurrence, 0.7);
  assert.equal(fresh?.unresolved, 0.6);
  assert.equal(fresh?.weight, base.weight);
  const old = await row(base.id);
  assert.equal(old?.status, "superseded");
});

test("supersede 旧条缺失：走 upsert 默认 0.6，weight=0.21", async () => {
  const { newId, oldStatus } = await supersedeMemory(env, {
    namespace: "sol", oldId: "mem_missing", newContent: "x", newType: "fact"
  });
  assert.equal(oldStatus, "missing");
  const stored = await row(newId);
  assert.equal(stored?.importance, 0.6);
  assert.equal(stored?.weight, 0.21);
});

test("vector 路径不归零（旧 d123991 回归）：updateVectorMemory 回读 D1 四维并保持 weight", async () => {
  const dims = { importance: 0.8, emotional: 0.5, recurrence: 0.3, unresolved: 0.1 };
  const created = await createVectorMemory(env, { namespace: "sol", type: "fact", content: "v1", ...dims });
  assert.equal((await row(created.id))?.weight, computeWeight(dims));
  const updated = await updateVectorMemory(env, created.id, { content: "v2" });
  assert.ok(updated);
  const after = await row(created.id);
  assert.equal(after?.emotional, 0.5);
  assert.equal(after?.recurrence, 0.3);
  assert.equal(after?.unresolved, 0.1);
  assert.equal(after?.weight, computeWeight(dims));
});

test("MCP memory_upsert：越界拒绝（isValidRange，裁定 #2）；省略即默认 0=全量覆盖语义", async () => {
  const bad = await mcpCall("memory_upsert", { fact_key: "f1", content: "x", emotional: 1.5 });
  assert.match(JSON.stringify(bad), /emotional must be between 0 and 1/);
  // 显式四维先落库，再经 MCP 省略 emotional 重复 upsert：工具默认 0.0 属全量覆盖（旧版
  // readNumber(args.emotional, 0.0) 语义，工具描述写明 Defaults to 0.0），不是静默归零 bug。
  await upsertMemoryByFactKey(env, { namespace: "sol", factKey: "f2", content: "v1",
    importance: 0.9, emotional: 0.8, recurrence: 0.7, unresolved: 0.6 });
  const ok = await mcpCall("memory_upsert", { fact_key: "f2", content: "v2" });
  assert.equal(ok.result?.isError, undefined);
  const stored = await row(JSON.parse(JSON.stringify(ok.result.structuredContent)).data.id);
  assert.equal(stored?.emotional, 0);
  assert.equal(stored?.recurrence, 0);
  assert.equal(stored?.importance, 0.6);
  assert.equal(stored?.weight, 0.21);
  // 显式提供则透传落库
  const ok2 = await mcpCall("memory_upsert", { fact_key: "f3", content: "x", emotional: 0.7, recurrence: 0.4 });
  assert.equal(ok2.result?.isError, undefined);
  const stored2 = await row(JSON.parse(JSON.stringify(ok2.result.structuredContent)).data.id);
  assert.equal(stored2?.emotional, 0.7);
  assert.equal(stored2?.recurrence, 0.4);
  assert.equal(stored2?.weight, computeWeight({ importance: 0.6, emotional: 0.7, recurrence: 0.4, unresolved: 0 }));
});
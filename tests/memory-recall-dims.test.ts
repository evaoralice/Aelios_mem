import { strict as assert } from "node:assert";
import { test, beforeEach } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import worker from "../src/index";
import { computeWeight } from "../src/extensions/memoryWeight";
import {
  memoryRankScore,
  RECALL_ORDER_IMPORTANCE_FACTOR
} from "../src/extensions/memoryRanking";
import { createMemory, getMemoryById } from "../src/db/memories";
import { searchMemoriesWithProvenance } from "../src/memory/search";
import { createVectorMemory, getVectorMemory } from "../src/memory/vectorStore";

// P3 四维召回与向量适配验收（plan 工作包 P3）：
//   1. API/MCP 查询结果返回 D1 真实四维与 weight（MemoryApiRecord 恢复可见性）；
//   2. 旧版排序公式 score + importance*0.05 集中到 extensions/memoryRanking，weight 不参与排序；
//   3. Vectorize metadata 不存四维：D1 为唯一真源，孤儿向量按旧版口径四维 0、可整批丢弃；
//   4. 召回/读取不覆盖 P2 已存的四维数据。

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
  // 默认不带 VECTORIZE：searchWithVectorize 直接走词面（D1 背书）路径，
  // 向量相关用例按需自行挂 VECTORIZE mock。
  env = { DB: db, CHATBOX_API_KEY: "owner-key", MEMORY_MCP_API_KEY: "mcp-key",
    AI: { async run(_model: string, _data: any) {
      return { data: [{ embedding: [0.1, 0.2, 0.3] }] };
    } } };
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
const DIMS = { importance: 0.8, emotional: 0.6, recurrence: 0.4, unresolved: 0.2 };

test("排序因子与旧版公式逐值一致：score + importance*0.05，weight 不参与排序", () => {
  assert.equal(RECALL_ORDER_IMPORTANCE_FACTOR, 0.05);
  for (const [score, importance] of [[0, 0], [0.5, 0.9], [0.4125, 0], [0.22, 1]]) {
    assert.equal(memoryRankScore(score as number, importance as number), (score as number) + (importance as number) * 0.05);
  }
  // weight 极端悬殊也不改变顺序：高 weight 低 rank 分仍排后面（旧版排序不读 weight）。
  const rows = [
    { id: "hi-weight", score: 0.5, importance: 0.9, weight: 1 },
    { id: "hi-score", score: 0.55, importance: 0.1, weight: 0 }
  ];
  const ordered = [...rows].sort((a, b) => memoryRankScore(b.score, b.importance) - memoryRankScore(a.score, a.importance));
  assert.deepEqual(ordered.map((r) => r.id), ["hi-score", "hi-weight"]);
});

test("MCP memory_search 返回 D1 真实四维与 weight；召回记账不覆盖已存四维", async () => {
  const m = await createMemory(db, { namespace: "sol", type: "fact", content: "调试暗号是芝麻开门", ...DIMS });
  const out = await mcpCall("memory_search", { query: "芝麻开门" });
  const data = JSON.parse(JSON.stringify(out.result.structuredContent)).data;
  assert.equal(data.length, 1);
  assert.equal(data[0].id, m.id);
  assert.equal(data[0].importance, 0.8);
  assert.equal(data[0].emotional, 0.6);
  assert.equal(data[0].recurrence, 0.4);
  assert.equal(data[0].unresolved, 0.2);
  assert.equal(data[0].weight, computeWeight(DIMS));
  // 召回只记 last_recalled_at/recall_count，四维与 weight 原样保留（不被覆盖/归零）。
  const stored = await row(m.id);
  assert.equal(stored?.emotional, 0.6);
  assert.equal(stored?.recurrence, 0.4);
  assert.equal(stored?.unresolved, 0.2);
  assert.equal(stored?.weight, 0.56);
});

test("MCP memory_get 返回 D1 真实四维与 weight", async () => {
  const m = await createMemory(db, { namespace: "sol", type: "fact", content: "调试暗号是芝麻开门", ...DIMS });
  const out = await mcpCall("memory_get", { id: m.id });
  const data = JSON.parse(JSON.stringify(out.result.structuredContent)).data;
  assert.equal(data.emotional, 0.6);
  assert.equal(data.recurrence, 0.4);
  assert.equal(data.unresolved, 0.2);
  assert.equal(data.weight, computeWeight(DIMS));
});

test("REST /v1/memory/recall 命中透出 D1 真实四维与 weight（RecallHit 透传）", async () => {
  await createMemory(db, { namespace: "sol", type: "fact", content: "调试暗号是芝麻开门", ...DIMS });
  env.ENABLE_MEMORY_RERANKER = "false";
  const out = await run("/v1/memory/recall", { namespace: "sol", query: "芝麻开门", k: 5 }, "owner-key");
  const body = JSON.parse(out.text);
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0].importance, 0.8);
  assert.equal(body.data[0].emotional, 0.6);
  assert.equal(body.data[0].recurrence, 0.4);
  assert.equal(body.data[0].unresolved, 0.2);
  assert.equal(body.data[0].weight, 0.56);
  assert.equal(body.data[0].source_layer, "memory");
});

test("REST recall 的 longtail 命中不伪造四维占位（无 D1 来源字段缺省）", async () => {
  sqlite.prepare(
    "INSERT INTO longtail (id, namespace, content, ts, source_message_ids) VALUES (?, ?, ?, ?, ?)"
  ).run("lt_1", "sol", "芝麻开门备用入口", "2026-10-11T00:00:00.000Z", "[]");
  env.ENABLE_MEMORY_RERANKER = "false";
  const out = await run("/v1/memory/recall", { namespace: "sol", query: "芝麻开门备用入口", k: 5, min_score: 0.05 }, "owner-key");
  const body = JSON.parse(out.text);
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0].source_layer, "longtail");
  assert.equal("importance" in body.data[0], false);
  assert.equal("weight" in body.data[0], false);
});

test("legacy 孤儿向量：四维 0（metadata 不存四维，与旧版一致）、backed:false、降分透传", async () => {
  env.VECTORIZE = { async query() {
    return { matches: [{ id: "vec_orphan", score: 0.9, metadata: {
      ref_id: "mem_ghost", namespace: "sol", status: "active", type: "note", content: "芝麻开门幽灵向量"
    } }] };
  }, async getByIds() { return []; }, async upsert() {}, async deleteByIds() {} } as any;
  const result = await searchMemoriesWithProvenance(env, { namespace: "sol", query: "芝麻开门" });
  assert.equal(result.records.length, 1);
  const record = result.records[0];
  assert.equal(record.backed, false);
  assert.equal(record.emotional, 0);
  assert.equal(record.recurrence, 0);
  assert.equal(record.unresolved, 0);
  assert.equal(record.weight, 0);
  assert.match(record.source ?? "", /legacy_vectorize/);
  assert.equal(record.score, 0.9 * 0.45);
  assert.equal(result.unbacked_count, 1);
});

test("RECALL_REQUIRE_D1_BACKING=true：孤儿向量整批丢弃，不进结果", async () => {
  env.VECTORIZE = { async query() {
    return { matches: [{ id: "vec_orphan", score: 0.9, metadata: {
      ref_id: "mem_ghost", namespace: "sol", status: "active", type: "note", content: "芝麻开门幽灵向量"
    } }] };
  }, async getByIds() { return []; }, async upsert() {}, async deleteByIds() {} } as any;
  env.RECALL_REQUIRE_D1_BACKING = "true";
  const result = await searchMemoriesWithProvenance(env, { namespace: "sol", query: "芝麻开门" });
  assert.equal(result.records.length, 0);
  assert.equal(result.unbacked_dropped, 1);
  assert.equal(result.unbacked_count, 0);
});

test("vectorStore 读取路径从 D1 补全四维：createVectorMemory 返回体与 getVectorMemory 均带真实值", async () => {
  env.VECTORIZE = { async getByIds() { return []; }, async upsert() {}, async deleteByIds() {} } as any;
  const dims = { importance: 0.8, emotional: 0.5, recurrence: 0.3, unresolved: 0.1 };
  const created = await createVectorMemory(env, { namespace: "sol", type: "fact", content: "v1", ...dims });
  assert.equal(created.emotional, 0.5);
  assert.equal(created.recurrence, 0.3);
  assert.equal(created.unresolved, 0.1);
  assert.equal(created.weight, computeWeight(dims));
  // VECTORIZE.getByIds 空 → 回退 D1 本体：四维以 D1 为准，不因 metadata 缺字段归零。
  const fetched = await getVectorMemory(env, created.id);
  assert.equal(fetched?.emotional, 0.5);
  assert.equal(fetched?.recurrence, 0.3);
  assert.equal(fetched?.unresolved, 0.1);
  assert.equal(fetched?.weight, computeWeight(dims));
});

test("getVectorMemory 读取顺序回归：D1 与 Vectorize 同时存在时必须返回 D1 真实四维", async () => {
  // P3 验收阻塞项：旧实现先返回 metadata 记录、向量不存在才回退 D1，
  // 而 metadata 不存四维——D1 正常记忆会被归零。正确顺序：有 D1 本体必返 D1 完整记录，
  // 只有 D1 查不到才允许 metadata 记录（孤儿降级保留）。
  const state: { vectorId: string; metadata: Record<string, unknown> | null } = {
    vectorId: "vec_pending", metadata: null
  };
  env.VECTORIZE = { async getByIds() {
    return state.metadata ? [{ id: state.vectorId, metadata: state.metadata }] : [];
  }, async upsert() {}, async deleteByIds() {} } as any;
  const dims = { importance: 0.8, emotional: 0.5, recurrence: 0.3, unresolved: 0.1 };
  const created = await createVectorMemory(env, { namespace: "sol", type: "fact", content: "v1", ...dims });
  // 向量存在、metadata 可正常读取且不含四维（importance 故意放 0.5 与 D1 的 0.8 区分）。
  state.vectorId = created.vector_id as string;
  state.metadata = { ref_id: created.id, namespace: "sol", status: "active", type: "fact",
    content: "v1", importance: 0.5, confidence: 0.8 };

  // public id 查询：D1 先于 metadata，返回真实四维而非 metadata 的 0。
  const byPublicId = await getVectorMemory(env, created.id);
  assert.equal(byPublicId?.importance, 0.8);
  assert.equal(byPublicId?.emotional, 0.5);
  assert.equal(byPublicId?.recurrence, 0.3);
  assert.equal(byPublicId?.unresolved, 0.1);
  assert.equal(byPublicId?.weight, computeWeight(dims));

  // vector id 查询（mem_mem_* 形态）同样命中 D1：candidateMemoryIds 归一两种查询方式。
  const byVectorId = await getVectorMemory(env, created.vector_id as string);
  assert.equal(byVectorId?.emotional, 0.5);
  assert.equal(byVectorId?.importance, 0.8);
  assert.equal(byVectorId?.weight, computeWeight(dims));

  // 非 mem_ 前缀的旧向量 id 归一不到 D1：metadata ref_id 能对上 D1 时仍以 D1 为准（补全）。
  state.vectorId = "vec_odd_shape";
  const byOddVectorId = await getVectorMemory(env, "vec_odd_shape");
  assert.equal(byOddVectorId?.emotional, 0.5);
  assert.equal(byOddVectorId?.importance, 0.8);

  // 真 orphan（ref_id 也对不上 D1）：保留降级，按旧口径返回 metadata 记录（四维 0）。
  state.metadata = { ref_id: "mem_ghost", namespace: "sol", status: "active", type: "note",
    content: "幽灵", importance: 0.5, confidence: 0.8 };
  const orphan = await getVectorMemory(env, "ghost_query");
  assert.equal(orphan?.content, "幽灵");
  assert.equal(orphan?.emotional, 0);
  assert.equal(orphan?.weight, 0);
});
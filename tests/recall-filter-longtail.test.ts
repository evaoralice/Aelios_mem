import { strict as assert } from "node:assert";
import { test, beforeEach } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import worker from "../src/index";
import { createMemory } from "../src/db/memories";

// P5-D 验收（行为模板 = 旧分支 78e2a7e P2-7，只恢复接线不搬旧 filter 实现）：
//   v2 recall 2.5 步的 reranker 失败（fail-closed 清空）时禁止落入 longtail 兜底；
//   fail-open 已提供 fallback 时正常召回；真空（status=empty）与 reranker 关闭
//   （status=disabled，gateway 热路径配置）不拦兜底；正常选中结果不变。
//   走全栈 worker.fetch（REST /v1/memory/recall），AI mock 按模型分发：
//   reranker 模型可切换 throw / success，embedding 模型恒返回向量。

let sqlite: DatabaseSync;
let db: any;
let env: any;
let ctx: any;
let pending: Promise<unknown>[];
let rerankerBehavior: "throw" | "success";

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
  rerankerBehavior = "throw";
  // 不挂 VECTORIZE：混合检索走词面（D1 背书）路径，longtail 走 LIKE 占位分支，
  // 测试只关心 filter meta 与第 5 步兜底的接线。
  env = { DB: db, CHATBOX_API_KEY: "owner-key", MEMORY_MCP_API_KEY: "mcp-key",
    AI: { async run(model: string, _data: any) {
      if (String(model).includes("reranker")) {
        if (rerankerBehavior === "throw") throw new Error("reranker down");
        return { result: [{ id: 0, score: 0.95 }] };
      }
      return { data: [{ embedding: [0.1, 0.2, 0.3] }] };
    } } };
  globalThis.fetch = (async (_url: any, init: any) =>
    Response.json({ model: "actual", choices: [{ index: 0, message: { content: "ok" }, finish_reason: "stop" }] })
  ) as any;
  env.GATEWAY_CONFIG = JSON.stringify({ version: 3, upstream: { address: "https://upstream.test/ai/v1" },
    identities: [identity("sol")] });
});

async function recall(query: string, extraEnv: Record<string, string> = {}) {
  Object.assign(env, extraEnv);
  const response = await worker.fetch(new Request("https://aelios.test/v1/memory/recall", {
    method: "POST",
    headers: { authorization: "Bearer owner-key", "content-type": "application/json" },
    body: JSON.stringify({ namespace: "sol", query, k: 5, min_score: 0.05 })
  }), env, ctx);
  const text = await response.text();
  await Promise.all(pending);
  return JSON.parse(text);
}

function seedLongtail(content: string) {
  sqlite.prepare(
    "INSERT INTO longtail (id, namespace, content, ts, source_message_ids) VALUES (?, ?, ?, ?, ?)"
  ).run("lt_1", "sol", content, "2026-10-11T00:00:00.000Z", "[]");
}

test("reranker fail-closed 错误且空结果：不落 longtail 兜底", async () => {
  await createMemory(db, { namespace: "sol", type: "fact", content: "调试暗号是芝麻开门" });
  seedLongtail("芝麻开门的过期回收站残片");
  rerankerBehavior = "throw";
  // MEMORY_FILTER_FAIL_OPEN 不配 = fail-closed：filter 返回 status=error、data=[]，
  // 修复前这里会落入 longtail 兜底（LIKE 命中回收站内容），修复后必须整体空手。
  const body = await recall("芝麻开门");
  assert.equal(body.data.length, 0);
  assert.ok(!body.data.some((h: any) => h.source_layer === "longtail"));
});

test("reranker fail-open 错误但有 fallback：正常召回，行为保持", async () => {
  await createMemory(db, { namespace: "sol", type: "fact", content: "调试暗号是芝麻开门" });
  seedLongtail("芝麻开门的过期回收站残片");
  rerankerBehavior = "throw";
  const body = await recall("芝麻开门", { MEMORY_FILTER_FAIL_OPEN: "true" });
  // fail-open 已提供 fallback 候选：召回结果就是这些候选，不因错误被拦。
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0].source_layer, "memory");
  assert.equal(body.data[0].content, "调试暗号是芝麻开门");
  assert.ok(!body.data.some((h: any) => h.source_layer === "longtail"));
});

test("过滤后真空（status=empty）：仍落 longtail 兜底", async () => {
  seedLongtail("芝麻开门备用入口");
  rerankerBehavior = "throw";
  // 没有任何 memory 命中 → filter 走 no_candidates 分支返回 status=empty，
  // 不是失败，longtail 兜底必须照常（LIKE 命中得分 0.1，min_score 0.05 过地板）。
  const body = await recall("芝麻开门备用入口");
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0].source_layer, "longtail");
  assert.equal(body.data[0].content, "芝麻开门备用入口");
});

test("reranker 关闭（status=disabled，gateway 热路径配置）：空结果不拦 longtail", async () => {
  seedLongtail("芝麻开门备用入口");
  const body = await recall("芝麻开门备用入口", { ENABLE_MEMORY_RERANKER: "false" });
  // filter disabled 只透传不判 error；真空仍允许兜底，接线上下文与 78e2a7e 一致。
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0].source_layer, "longtail");
});

test("reranker 正常选中：召回结果不变，longtail 不参与", async () => {
  await createMemory(db, { namespace: "sol", type: "fact", content: "调试暗号是芝麻开门" });
  seedLongtail("芝麻开门的过期回收站残片");
  rerankerBehavior = "success";
  const body = await recall("芝麻开门");
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0].source_layer, "memory");
  assert.equal(body.data[0].content, "调试暗号是芝麻开门");
  // reranker 给出的分透传为命中分（WithMeta 切换不改变正常路径的选中结果）。
  assert.equal(body.data[0].score, 0.95);
  assert.ok(!body.data.some((h: any) => h.source_layer === "longtail"));
});
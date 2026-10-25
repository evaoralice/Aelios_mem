import { strict as assert } from "node:assert";
import { test, beforeEach } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import worker from "../src/index";
import { formatBackgroundBlock, injectBackground, loadBackgroundContext } from "../src/gateway/background";
import { applyBaselineChanges } from "../src/memory/baselineMerge";
import { createBaselineChangelogEntry, upsertBaseline, listPendingBaselineChangelog } from "../src/db/v2";
import { getTools } from "../src/api/mcp";
import { lexicalOverlapScore, shapeRecallQuery } from "../src/memory/queryShape";

// Baseline 闭环（plan/Aelios-upstream-v2-baseline-integration.md 阶段 1–3）验收：
// Gateway 固定背景注入、跨 ns boost、日记工具、baseline_change 校验、Dream 合并语义。
(crypto.subtle as any).timingSafeEqual = (a: Uint8Array, b: Uint8Array) => timingSafeEqual(a, b);
let sqlite: DatabaseSync;
let db: any;
let env: any;
let ctx: any;
let pending: Promise<unknown>[];
let calls: any[];
let queue: any[];
const identity = (namespace?: string): any => ({ slug: namespace || "sol", namespace: namespace || "sol",
  keys: ["CHATBOX_API_KEY", "MEMORY_MCP_API_KEY"], models: [namespace || "sol"] });

function setConfig(identities: any[]) {
  env.GATEWAY_CONFIG = JSON.stringify({ version: 3, upstream: { address: "https://upstream.test/ai/v1" }, identities });
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
  invalidate();
  pending = []; calls = []; queue = [];
  ctx = { waitUntil(p: Promise<unknown>) { pending.push(p); } };
  env = { DB: db, CHATBOX_API_KEY: "owner-key", MEMORY_MCP_API_KEY: "mcp-key", CLOUDFLARE_API_TOKEN: "cf-token",
    AI: { async run(model: string, data: any) {
      if (!model.includes("reranker")) throw new Error("embedding unavailable in test");
      return { response: data.contexts.map((c: any, id: number) => ({ id,
        score: lexicalOverlapScore(c.text, shapeRecallQuery({ query: data.query }).lexicalTokens) > 0 ? 0.9 : 0.01 })) };
    } },
    MEMORY_QUEUE: { async send(e: any) { queue.push(e); } } as any };
  globalThis.fetch = async (url: any, init: any) => {
    if (String(url).endsWith("/models")) return Response.json({ object: "list", data: [] });
    calls.push({ url: String(url), query: JSON.parse(init?.body as string) });
    return Response.json({ model: "actual", choices: [{ index: 0, message: { content: "好的。" }, finish_reason: "stop" }] });
  };
  setConfig([identity("sol"), identity("ke")]);
});

function invalidate() { /* placeholder for settings cache reset */ }
async function run(path: string, body?: any, key = "owner-key") {
  const response = await worker.fetch(new Request(`https://aelios.test${path}`, {
    method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {})
  }), env, ctx);
  const text = await response.text();
  await Promise.all(pending);
  return { response, text };
}

function insertBaseline(namespace: string, content: string) {
  sqlite.prepare(
    "INSERT INTO long_term_baselines (namespace, content, version, generated_at) VALUES (?, ?, 1, ?)"
  ).run(namespace, content, "2026-10-04T00:00:00Z");
}

function insertDailyLog(namespace: string, date: string, title: string, summary: string) {
  sqlite.prepare(
    `INSERT INTO daily_log (namespace, date, title, summary, source_message_ids, updated_at)
     VALUES (?, ?, ?, ?, '[]', '2026-10-04T00:00:00Z')`
  ).run(namespace, date, title, summary);
}

// ============================ 阶段 1 ============================

test("assistant A receives only namespace A's baseline; B never sees A's", async () => {
  insertBaseline("sol", "sol 的长期印象：喜欢深色主题。");
  insertBaseline("ke", "ke 的长期印象：讨厌香菜。");
  await run("/sol/v1/chat/completions", { model: "sol", messages: [{ role: "user", content: "你好" }] });
  const solSystem = JSON.stringify(calls[0].query.messages.filter((m: any) => m.role === "system"));
  assert.match(solSystem, /sol 的长期印象/);
  assert.doesNotMatch(solSystem, /ke 的长期印象/);
  await run("/ke/v1/chat/completions", { model: "ke", messages: [{ role: "user", content: "你好" }] });
  const keSystem = JSON.stringify(calls[1].query.messages.filter((m: any) => m.role === "system"));
  assert.match(keSystem, /ke 的长期印象/);
  assert.doesNotMatch(keSystem, /sol 的长期印象/);
});

test("no baseline: chat works, no empty tags injected", async () => {
  const { response } = await run("/sol/v1/chat/completions", { model: "sol", messages: [{ role: "user", content: "你好" }] });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-aelios-background"), "empty");
  const system = JSON.stringify(calls[0].query.messages.filter((m: any) => m.role === "system"));
  assert.doesNotMatch(system, /long_term_baseline|daily_log/);
});

test("all three protocols receive the same background text and position", async () => {
  insertBaseline("sol", "sol 的长期印象。");
  const bodies = {
    chat: { model: "sol", messages: [{ role: "user", content: "你好" }] },
    messages: { model: "sol", max_tokens: 100, messages: [{ role: "user", content: "你好" }] },
    responses: { model: "sol", input: "你好" }
  };
  await run("/sol/v1/chat/completions", bodies.chat);
  await run("/sol/v1/messages", bodies.messages);
  await run("/sol/v1/responses", bodies.responses);
  const chatSystem = JSON.stringify((calls[0].query.messages as any[]).filter(m => m.role === "system"));
  const messagesSystem = JSON.stringify(calls[1].query.system ?? "");
  const responsesInstructions = JSON.stringify(calls[2].query.instructions ?? "");
  for (const surface of [chatSystem, messagesSystem, responsesInstructions]) {
    assert.match(surface, /sol 的长期印象/, "background missing on one protocol");
  }
  assert.equal(responseText(chatSystem), responseText(messagesSystem));
});

function responseText(json: string): string {
  // extract the <long_term_baseline> block so the three protocols compare equal
  const match = json.match(/<long_term_baseline>[\s\S]*?<\/long_term_baseline>/);
  return match ? match[0] : "";
}

test("baseline survives when dynamic recall is empty; pending receipt is injected with it", async () => {
  insertBaseline("sol", "sol 的长期印象。");
  await createBaselineChangelogEntry(db, { namespace: "sol", op: "add", afterContent: "最近在学 Rust", reason: "提到过多次" });
  const { response } = await run("/sol/v1/chat/completions", { model: "sol", messages: [{ role: "user", content: "你好" }] });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-aelios-background"), "injected");
  const system = JSON.stringify(calls[0].query.messages.filter((m: any) => m.role === "system"));
  assert.match(system, /sol 的长期印象/);
  assert.match(system, /=== 待处理变更（今日）===/);
  assert.match(system, /\[baseline\] 新增：最近在学 Rust/);
});

test("namespace boost ranks own memory ahead of shared at equal relevance", async () => {
  setConfig([{ ...identity("sol"), readNamespaces: ["sol", "shared"] }]);
  for (const [id, ns, content] of [
    ["own-1", "sol", "我们喜欢的暗号是芝麻开门"],
    ["shared-1", "shared", "我们喜欢的暗号是芝麻开门"]
  ] as const) {
    sqlite.prepare(
      `INSERT INTO memories (id, namespace, type, content, importance, confidence, created_at, updated_at)
       VALUES (?, ?, 'fact', ?, 1, 1, '2026-09-06', '2026-09-06')`
    ).run(id, ns, content);
  }
  // reranker scores both spans identically; boost must order sol's first.
  env.AI.run = async (model: string, data: any) => ({
    response: data.contexts.map((c: any, id: number) => ({ id, score: c.text.includes("芝麻开门") ? 0.9 : 0.01 }))
  });
  await run("/sol/v1/chat/completions", { model: "sol", messages: [{ role: "user", content: "暗号是什么？" }] });
  const injected = (calls[0].query.messages[0].content as string) || "";
  assert.match(injected, /芝麻开门/);
  const trace = JSON.parse((await run("/api/gateway/recalls?identity=sol")).text).items[0];
  const firstMemory = trace.items.find((i: any) => i.id);
  assert.equal(firstMemory.namespace, "sol");
});

// ============================ 阶段 2 ============================

test("diary background shows the last two logged dates with explicit date tags, oldest first", async () => {
  insertDailyLog("sol", "2026-10-01", "十月开始", "- 聊了迁移");
  insertDailyLog("sol", "2026-10-03", "修网关", "- 修好了注入");
  insertDailyLog("sol", "2026-09-28", "更早的一天", "- 不该进背景");
  await run("/sol/v1/chat/completions", { model: "sol", messages: [{ role: "user", content: "你好" }] });
  const system = calls[0].query.messages.find((m: any) => m.role === "system").content as string;
  assert.match(system, /<daily_log date="2026-10-01">/);
  assert.match(system, /<daily_log date="2026-10-03">/);
  assert.doesNotMatch(system, /2026-09-28/);
  const pos1 = system.indexOf("2026-10-01");
  const pos3 = system.indexOf("2026-10-03");
  assert.ok(pos1 >= 0 && pos3 > pos1, "older diary must come first");
  // third older date is not in background but reachable via tool
  assert.doesNotMatch(system, /更早的一天/);
});

test("daily_log_write appends to today's log via /mcp/:identity; the gateway background picks it up next request", async () => {
  // 方案 D：MCP 走 identity 路由，namespace 由 URL 强制绑定
  const call = async (name: string, args: any, slug = "sol") => run(`/mcp/${slug}`, {
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name, arguments: args }
  }, "mcp-key");
  const write = JSON.parse((await call("daily_log_write", { title: "新的一天", summary: "- 第一条" })).text);
  assert.equal(write.result.isError, undefined);
  // append same day
  await call("daily_log_write", { title: "不该覆盖", summary: "- 第二条" });
  const read = JSON.parse((await call("daily_log_read", {})).text);
  const logs = read.result.structuredContent.data;
  assert.equal(logs.length, 1);
  assert.equal(logs[0].namespace, "sol");
  assert.equal(logs[0].title, "新的一天");
  assert.match(logs[0].summary, /第一条/);
  assert.match(logs[0].summary, /第二条/);
  // gateway identity on another namespace never sees it in its background
  await run("/sol/v1/chat/completions", { model: "sol", messages: [{ role: "user", content: "你好" }] });
  const solSystem = JSON.stringify(calls[0].query.messages.filter((m: any) => m.role === "system"));
  assert.match(solSystem, /新的一天/);
  await run("/ke/v1/chat/completions", { model: "ke", messages: [{ role: "user", content: "你好" }] });
  const keSystem = JSON.stringify(calls[1].query.messages.filter((m: any) => m.role === "system"));
  assert.doesNotMatch(keSystem, /新的一天|第一条/);
});

test("tool list exposes daily_log_read/write and hides upstream diary_get", () => {
  const names = getTools().map((t: any) => t.name);
  assert.ok(names.includes("daily_log_read"));
  assert.ok(names.includes("daily_log_write"));
  assert.ok(!names.includes("diary_get"));
  // 方案 D：三个角色记忆工具不再声明 namespace 参数
  for (const name of ["baseline_change", "daily_log_read", "daily_log_write"]) {
    const tool = getTools().find((t: any) => t.name === name) as any;
    assert.equal(tool.inputSchema.properties.namespace, undefined, `${name} must not declare namespace`);
  }
});

// ============================ 方案 D：namespace 归属 ============================

test("identity-bound MCP forces the identity namespace and ignores args.namespace", async () => {
  const call = async (name: string, args: any) => run("/mcp/sol", {
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name, arguments: args }
  }, "mcp-key");
  // 传 namespace 参数也不能写到别的空间
  const write = JSON.parse((await call("daily_log_write", { title: "标题", summary: "- s", namespace: "ke" })).text);
  assert.equal(write.result.isError, undefined);
  const read = JSON.parse((await call("daily_log_read", { namespace: "ke" })).text);
  assert.equal(read.result.structuredContent.data[0].namespace, "sol");
  const keRead = JSON.parse((await call("daily_log_read", {})).text);
  assert.equal(keRead.result.structuredContent.data[0].namespace, "sol");
});

test("role-memory tools on the global /mcp path report an error instead of falling back to default", async () => {
  const call = async (name: string, args: any) => JSON.parse((await run("/mcp", {
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name, arguments: args }
  }, "mcp-key")).text);
  for (const [name, args] of [
    ["baseline_change", { op: "add", reason: "r", after_content: "x" }],
    ["daily_log_write", { title: "t" }],
    ["daily_log_read", {}],
    ["diary_get", {}]
  ] as const) {
    const result = await call(name, args);
    assert.equal(result.result.isError, true, `${name} must error on the global path`);
    assert.match(result.result.content[0].text, /identity-bound MCP endpoint/);
  }
  // 而且什么都没写进去
  assert.equal((sqlite.prepare("SELECT count(*) AS n FROM daily_log").get() as any).n, 0);
  assert.equal((sqlite.prepare("SELECT count(*) AS n FROM baseline_changelog").get() as any).n, 0);
});

test("unknown identity slug is rejected with 404, not a fallback", async () => {
  const { response, text } = await run("/mcp/nobody", {
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "daily_log_write", arguments: { title: "t" } }
  }, "mcp-key");
  assert.equal(response.status, 404);
  const parsed = JSON.parse(text);
  assert.match(parsed.error.message, /No identity "nobody"/);
});

test("a key not listed on the identity cannot use its MCP route", async () => {
  // ke identity 只挂 CHATBOX key；mcp key 访问 /mcp/ke 应 404
  setConfig([identity("sol"), { ...identity("ke"), keys: ["CHATBOX_API_KEY"] }]);
  const { response } = await run("/mcp/ke", {
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "daily_log_write", arguments: { title: "t" } }
  }, "mcp-key");
  assert.equal(response.status, 404);
  // 同一个 mcp key 在 sol identity 上仍然可用
  const ok = await run("/mcp/sol", {
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "daily_log_write", arguments: { title: "标题" } }
  }, "mcp-key");
  assert.equal(ok.response.status, 200);
});

// ============================ 阶段 3 ============================

test("baseline_change validates op fields and lands pending in the identity namespace", async () => {
  const call = async (args: any) => JSON.parse((await run("/mcp/sol", {
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "baseline_change", arguments: args }
  }, "mcp-key")).text);
  assert.match((await call({ op: "remove", reason: "x" })).result.content[0].text, /op must be/);
  assert.match((await call({ op: "add", reason: "" })).result.content[0].text, /reason is required/);
  assert.match((await call({ op: "add", reason: "r" })).result.content[0].text, /add requires after_content/);
  assert.match((await call({ op: "update", reason: "r", after_content: "y" })).result.content[0].text, /update requires/);
  assert.match((await call({ op: "delete", reason: "r" })).result.content[0].text, /delete requires before_content/);
  const ok = await call({ op: "add", reason: "多次提到", after_content: "喜欢深色主题" });
  assert.equal(ok.result.isError, undefined);
  const rows = await listPendingBaselineChangelog(db, { namespace: "sol" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].op, "add");
});

test("dream applies a pending group atomically and versions the baseline", async () => {
  env.DREAM_MODEL = "openai/gpt-dream-test";
  env.AI_GATEWAY_BASE_URL = "https://upstream.test/ai/v1";
  insertBaseline("sol", "旧 baseline：喜欢深色主题。");
  await createBaselineChangelogEntry(db, { namespace: "sol", op: "add", afterContent: "最近在学 Rust", reason: "提到多次" });
  const prompts: string[] = [];
  globalThis.fetch = async (url: any, init: any) => {
    const body = JSON.parse(init?.body as string);
    prompts.push(body.messages.map((m: any) => m.content).join("\n"));
    return Response.json({ model: "dream", choices: [{ index: 0, message: { content: "合并后的 baseline：喜欢深色主题，最近在学 Rust。" }, finish_reason: "stop" }] });
  };
  const result = await applyBaselineChanges(env, "sol");
  assert.deepEqual(result, { ran: true, applied: 1, kept_pending: 0, model_calls: 1 });
  assert.match(prompts[0], /旧 baseline：喜欢深色主题。/);
  assert.match(prompts[0], /最近在学 Rust/);
  const row = sqlite.prepare("SELECT content, version FROM long_term_baselines WHERE namespace = 'sol'").get() as any;
  assert.equal(row.content, "合并后的 baseline：喜欢深色主题，最近在学 Rust。");
  assert.equal(row.version, 2);
  // 快照保存的是上一版（v1 旧内容），不是新版本——审查问题 2。
  const snaps = sqlite.prepare("SELECT version, content FROM long_term_baseline_snapshots WHERE namespace = 'sol' ORDER BY version").all() as any[];
  assert.equal(snaps.length, 1);
  assert.equal(snaps[0].version, 1);
  assert.equal(snaps[0].content, "旧 baseline：喜欢深色主题。");
  const still = await listPendingBaselineChangelog(db, { namespace: "sol" });
  assert.equal(still.length, 0);
});

test("first baseline creation makes no snapshot (no previous version exists)", async () => {
  env.DREAM_MODEL = "openai/gpt-dream-test";
  env.AI_GATEWAY_BASE_URL = "https://upstream.test/ai/v1";
  await createBaselineChangelogEntry(db, { namespace: "sol", op: "add", afterContent: "全新的印象", reason: "r" });
  globalThis.fetch = async (_url: any, init: any) => {
    const body = JSON.parse(init?.body as string);
    return Response.json({ model: "dream", choices: [{ index: 0, message: { content: "全新 baseline。", finish_reason: "stop" } }] });
  };
  const result = await applyBaselineChanges(env, "sol");
  assert.equal(result.ran, true);
  const row = sqlite.prepare("SELECT content, version FROM long_term_baselines WHERE namespace = 'sol'").get() as any;
  assert.equal(row.version, 1);
  assert.equal(row.content, "全新 baseline。");
  const snaps = sqlite.prepare("SELECT count(*) AS n FROM long_term_baseline_snapshots WHERE namespace = 'sol'").get() as any;
  assert.equal(snaps.n, 0, "首次创建没有上一版，不该生成快照");
});

test("batch failure rolls the whole group back: baseline unchanged, pending kept", async () => {
  env.DREAM_MODEL = "openai/gpt-dream-test";
  env.AI_GATEWAY_BASE_URL = "https://upstream.test/ai/v1";
  insertBaseline("sol", "旧 baseline 不许变。");
  await createBaselineChangelogEntry(db, { namespace: "sol", op: "add", afterContent: "新印象", reason: "r" });
  globalThis.fetch = async (_url: any, init: any) => {
    const body = JSON.parse(init?.body as string);
    return Response.json({ model: "dream", choices: [{ index: 0, message: { content: "新 baseline。", finish_reason: "stop" } }] });
  };
  // 让 batch 整体抛错，模拟写库基础设施故障（真实 D1 batch 事务失败同样整体回滚）。
  db.batch = async (_statements: any[]) => {
    throw new Error("simulated mid-batch failure");
  };
  const result = await applyBaselineChanges(env, "sol");
  assert.equal(result.ran, false);
  assert.equal(result.reason, "write_failed");
  // 原子性：baseline 还是旧内容、快照没有半截写入、pending 整组保留——审查问题 1。
  const row = sqlite.prepare("SELECT content FROM long_term_baselines WHERE namespace = 'sol'").get() as any;
  assert.equal(row.content, "旧 baseline 不许变。");
  const snaps = sqlite.prepare("SELECT count(*) AS n FROM long_term_baseline_snapshots WHERE namespace = 'sol'").get() as any;
  assert.equal(snaps.n, 0);
  const still = await listPendingBaselineChangelog(db, { namespace: "sol" });
  assert.equal(still.length, 1);
  assert.equal(still[0].status, "pending");
  assert.match(still[0].error_message ?? "", /write failed/);
});

test("dream model failure keeps the whole pending group and the old baseline", async () => {
  env.DREAM_MODEL = "openai/gpt-dream-test";
  env.AI_GATEWAY_BASE_URL = "https://upstream.test/ai/v1";
  insertBaseline("sol", "旧 baseline 不许丢。");
  await createBaselineChangelogEntry(db, { namespace: "sol", op: "add", afterContent: "新印象", reason: "r" });
  globalThis.fetch = async () => new Response("upstream down", { status: 500 });
  const result = await applyBaselineChanges(env, "sol");
  assert.equal(result.ran, false);
  assert.equal(result.reason, "model_failed");
  const row = sqlite.prepare("SELECT content FROM long_term_baselines WHERE namespace = 'sol'").get() as any;
  assert.equal(row.content, "旧 baseline 不许丢。");
  const still = await listPendingBaselineChangelog(db, { namespace: "sol" });
  assert.equal(still.length, 1);
  assert.equal(still[0].status, "pending");
  assert.match(still[0].error_message ?? "", /model call failed/);
});

test("no pending means no model call and unchanged baseline", async () => {
  env.DREAM_MODEL = "openai/gpt-dream-test";
  env.AI_GATEWAY_BASE_URL = "https://upstream.test/ai/v1";
  insertBaseline("sol", "稳定 baseline。");
  let called = 0;
  globalThis.fetch = async () => { called++; return Response.json({}); };
  const result = await applyBaselineChanges(env, "sol");
  assert.deepEqual(result, { ran: false, applied: 0, kept_pending: 0, model_calls: 0 });
  assert.equal(called, 0);
});

test("oversize merge output triggers one compress pass instead of hard truncation", async () => {
  env.DREAM_MODEL = "openai/gpt-dream-test";
  env.AI_GATEWAY_BASE_URL = "https://upstream.test/ai/v1";
  await createBaselineChangelogEntry(db, { namespace: "sol", op: "add", afterContent: "新印象", reason: "r" });
  let call = 0;
  globalThis.fetch = async (_url: any, init: any) => {
    call++;
    const body = JSON.parse(init?.body as string);
    const isCompress = body.messages.some((m: any) => String(m.content).includes("超过了目标长度"));
    return Response.json({ model: "dream", choices: [{ index: 0, message: { content: isCompress ? "压缩后的短 baseline。" : "很长的合并结果。".repeat(500) }, finish_reason: "stop" }] });
  };
  const result = await applyBaselineChanges(env, "sol");
  assert.equal(call, 2);
  assert.equal(result.model_calls, 2);
  const row = sqlite.prepare("SELECT content FROM long_term_baselines WHERE namespace = 'sol'").get() as any;
  assert.equal(row.content, "压缩后的短 baseline。");
});

// ============================ 注入细节 ============================

test("tool continuation re-sends clean history: background injected once, never duplicated", async () => {
  insertBaseline("sol", "sol 的长期印象。");
  const continuation = { model: "sol", messages: [
    { role: "user", content: "查一下" },
    { role: "assistant", content: null, tool_calls: [{ id: "t", function: { name: "lookup", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "t", content: "result" }
  ] };
  await run("/sol/v1/chat/completions", continuation);
  const system = calls[0].query.messages.find((m: any) => m.role === "system");
  assert.match(system.content, /sol 的长期印象/);
  assert.equal((system.content.match(/<long_term_baseline>/g) ?? []).length, 1);
  // A client echoing an OLD background in its system must not keep using stale content:
  // the system is not touched a second time, and the CURRENT background is re-delivered
  // through the dynamic patch instead (审查问题：回放旧背景只判重不替换).
  const staleSystem = "<long_term_baseline>过时的印象</long_term_baseline>";
  const echoed = { ...continuation, messages: [{ role: "system", content: staleSystem }, ...continuation.messages] };
  await run("/sol/v1/chat/completions", echoed);
  const echoedSystem = calls[1].query.messages.find((m: any) => m.role === "system");
  assert.equal(echoedSystem.content, staleSystem, "system 回放时保持原样，不被追加第二份");
  const lastMessage = calls[1].query.messages[calls[1].query.messages.length - 1];
  const patchText = typeof lastMessage.content === "string" ? lastMessage.content : JSON.stringify(lastMessage.content);
  assert.match(patchText, /sol 的长期印象/, "最新背景转投动态 patch，模型仍能看到当前内容");
  assert.doesNotMatch(patchText, /过时的印象/);
});

test("loadBackgroundContext tolerates missing baseline and empty pending", async () => {
  const ctxValue = await loadBackgroundContext(env, identity("sol"));
  assert.equal(ctxValue.baseline, null);
  assert.equal(ctxValue.pendingText, null);
  assert.deepEqual(ctxValue.dailyLogs, []);
  assert.equal(formatBackgroundBlock(ctxValue), "");
});

test("background only reads the write namespace even with readNamespaces granted", async () => {
  insertBaseline("sol", "sol 自己的。");
  insertBaseline("shared", "shared 的不该被注入。");
  const identityShared = { ...identity("sol"), readNamespaces: ["sol", "shared"] };
  const ctxValue = await loadBackgroundContext(env, identityShared);
  assert.equal(ctxValue.baseline, "sol 自己的。");
  const block = formatBackgroundBlock(ctxValue);
  assert.doesNotMatch(block, /shared 的不该被注入/);
});

test("injectBackground places the block at the system surface for each protocol", () => {
  const block = "<long_term_baseline>x</long_term_baseline>";
  const chat = { model: "m", messages: [{ role: "system", content: "s" }, { role: "user", content: "u" }] };
  assert.equal(injectBackground(chat, "chat", block), true);
  assert.equal(chat.messages[0].content, `s\n\n${block}`);
  const messagesBody = { model: "m", max_tokens: 1, messages: [{ role: "user", content: "u" }], system: "s" };
  assert.equal(injectBackground(messagesBody, "messages", block), true);
  assert.equal(messagesBody.system, `s\n\n${block}`);
  const responses = { model: "m", input: "u", instructions: "s" };
  assert.equal(injectBackground(responses, "responses", block), true);
  assert.equal(responses.instructions, `s\n\n${block}`);
  // 已带旧标记时拒绝二次注入，返回 false
  assert.equal(injectBackground({ model: "m", messages: [], system: "<long_term_baseline>旧</long_term_baseline>" }, "messages", block), false);
});
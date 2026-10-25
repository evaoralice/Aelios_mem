import { strict as assert } from "node:assert";
import { test, beforeEach } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import worker from "../src/index";
import { formatAffectChordLine, normalizeAffectChord } from "../src/extensions/affectChord";
import { formatBackgroundBlock, loadBackgroundContext } from "../src/gateway/background";
import { getDailyLog, upsertDailyLog } from "../src/db/v2";
import { getTools } from "../src/api/mcp";
import { lexicalOverlapScore, shapeRecallQuery } from "../src/memory/queryShape";

// P4 affect_chord 数据保真验收（plan 工作包 P4）：
//   1. 0019 迁移补建 daily_log.affect_chord 可空列；带/不带 chord 的旧日记读路径无损往返；
//   2. 写语义 = 旧分支行为：MCP 是唯一模型写入口，新值替换、省略保留（DB 层 COALESCE）、
//      Dream 重写 summary 不抹模型 chord、回显输入值（旧版口径）；
//   3. 固定背景注入：有 chord 渲染独立一行 "♪ <chord>"（旧 assembler/types.ts:206 同款），
//      无 chord 的输出与 P4 前逐字节一致；
//   4. 生成语义（有明确情绪温度才写、普通/中性可省略）只活在工具描述里，
//      入口无格式校验（忠实旧版：旧分支就没有运行期校验）。

(crypto.subtle as any).timingSafeEqual = (a: Uint8Array, b: Uint8Array) => timingSafeEqual(a, b);
let sqlite: DatabaseSync;
let db: any;
let env: any;
let ctx: any;
let pending: Promise<unknown>[];
let calls: any[];
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
  pending = []; calls = [];
  ctx = { waitUntil(p: Promise<unknown>) { pending.push(p); } };
  env = { DB: db, CHATBOX_API_KEY: "owner-key", MEMORY_MCP_API_KEY: "mcp-key", CLOUDFLARE_API_TOKEN: "cf-token",
    AI: { async run(model: string, data: any) {
      if (!model.includes("reranker")) throw new Error("embedding unavailable in test");
      return { response: data.contexts.map((c: any, id: number) => ({ id,
        score: lexicalOverlapScore(c.text, shapeRecallQuery({ query: data.query }).lexicalTokens) > 0 ? 0.9 : 0.01 })) };
    } } };
  globalThis.fetch = async (url: any, init: any) => {
    if (String(url).endsWith("/models")) return Response.json({ object: "list", data: [] });
    calls.push({ url: String(url), query: JSON.parse(init?.body as string) });
    return Response.json({ model: "actual", choices: [{ index: 0, message: { content: "好的。" }, finish_reason: "stop" }] });
  };
  env.GATEWAY_CONFIG = JSON.stringify({ version: 3, upstream: { address: "https://upstream.test/ai/v1" },
    identities: [identity("sol")] });
});

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

async function mcpCall(name: string, args: any) {
  return JSON.parse((await run("/mcp/sol", {
    jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args }
  }, "mcp-key")).text);
}

/** 模拟 P8 迁入的旧日记行（带/不带 chord 都可能出现）。 */
function insertDailyLog(namespace: string, date: string, title: string, summary: string, affectChord: string | null) {
  sqlite.prepare(
    `INSERT INTO daily_log (namespace, date, title, summary, affect_chord, source_message_ids, updated_at)
     VALUES (?, ?, ?, ?, ?, '[]', '2026-10-10T00:00:00Z')`
  ).run(namespace, date, title, summary, affectChord);
}

test("normalizeAffectChord/formatAffectChordLine：旧 readString||null 与 ♪ 渲染语义", () => {
  assert.equal(normalizeAffectChord("Fmaj9 → C/E"), "Fmaj9 → C/E");
  assert.equal(normalizeAffectChord("  G6sus4  "), "G6sus4");
  assert.equal(normalizeAffectChord(""), null);
  assert.equal(normalizeAffectChord("   "), null);
  assert.equal(normalizeAffectChord(null), null);
  assert.equal(normalizeAffectChord(undefined), null);
  assert.equal(normalizeAffectChord(42), null);
  assert.equal(formatAffectChordLine("Am add9 · mf"), "♪ Am add9 · mf");
  assert.equal(formatAffectChordLine(null), null);
  assert.equal(formatAffectChordLine(undefined), null);
  assert.equal(formatAffectChordLine(""), null);
});

test("带/不带 affect_chord 的旧日记都能无损往返（MCP、REST、admin 面）", async () => {
  const chord = "Fmaj9 → C/E → Am add9 → G6sus4 · 60bpm";
  insertDailyLog("sol", "2026-10-09", "平淡的一天", "- 无和弦", null);
  insertDailyLog("sol", "2026-10-10", "动情的一天", "- 聊了很多", chord);
  // MCP daily_log_read（最近列表，DESC 新在前）
  const read = await mcpCall("daily_log_read", {});
  const logs = read.result.structuredContent.data;
  assert.equal(logs[0].date, "2026-10-10");
  assert.equal(logs[0].affect_chord, chord);
  assert.equal(logs[1].date, "2026-10-09");
  assert.equal(logs[1].affect_chord, null);
  assert.equal(logs[1].title, "平淡的一天");
  // 指定日期单读
  const one = await mcpCall("daily_log_read", { date: "2026-10-10" });
  assert.equal(one.result.structuredContent.data.affect_chord, chord);
  // REST /v1/diary 与 admin /admin/diary 读面同样透传可选字段
  const rest = JSON.parse((await run("/v1/diary?date=2026-10-10&namespace=sol")).text);
  assert.equal(rest.data.affect_chord, chord);
  const restNone = JSON.parse((await run("/v1/diary?date=2026-10-09&namespace=sol")).text);
  assert.equal(restNone.data.affect_chord, null);
  const admin = JSON.parse((await run("/admin/diary?namespace=sol&limit=30")).text);
  assert.equal(admin.data.dailies[0].affect_chord, chord);
  assert.equal(admin.data.dailies[1].affect_chord, null);
});

test("daily_log_write：chord 新值替换、省略保留、空白视为省略、回显输入值（旧版口径）", async () => {
  // 首次带 chord 写入：回显输入值
  const first = await mcpCall("daily_log_write", { title: "新的一天", summary: "- 第一条", affect_chord: "Cmaj7 · 66bpm" });
  assert.equal(first.result.isError, undefined);
  assert.equal(first.result.structuredContent.data.affect_chord, "Cmaj7 · 66bpm");
  // 追加不带 chord：summary 追加、chord 保留（DB 层 COALESCE），回显 null（旧版回显输入值，不是 DB 值）
  const second = await mcpCall("daily_log_write", { title: "不该覆盖", summary: "- 第二条" });
  assert.equal(second.result.structuredContent.data.affect_chord, null);
  // 空白 chord = 省略，同样保留
  await mcpCall("daily_log_write", { title: "空白和弦", summary: "- 第三条", affect_chord: "   " });
  let read = await mcpCall("daily_log_read", {});
  let log = read.result.structuredContent.data[0];
  assert.equal(log.affect_chord, "Cmaj7 · 66bpm");
  assert.equal(log.title, "新的一天");
  assert.match(log.summary, /第一条/);
  assert.match(log.summary, /第三条/);
  // 带新 chord 再写：替换旧值
  await mcpCall("daily_log_write", { title: "换心情", summary: "- 第四条", affect_chord: "  Dm7 → G7  " });
  read = await mcpCall("daily_log_read", {});
  log = read.result.structuredContent.data[0];
  assert.equal(log.affect_chord, "Dm7 → G7");
});

test("DB 层 upsert 省略 chord 时保留旧值：Dream 重写 summary 不抹模型 chord", async () => {
  insertDailyLog("sol", "2026-10-10", "动情的一天", "- 旧 summary", "Fmaj9");
  // diaryWriter / lifecyclePhase 的调用形状：不带 affectChord
  await upsertDailyLog(db, { namespace: "sol", date: "2026-10-10", title: "梦改的标题", summary: "- 梦重写", sourceMessageIds: ["m1"] });
  const row = await getDailyLog(db, { namespace: "sol", date: "2026-10-10" });
  assert.equal(row?.affect_chord, "Fmaj9");
  assert.equal(row?.title, "梦改的标题");
  assert.match(row?.summary ?? "", /梦重写/);
  // 显式传 null 也走保留（省略语义），传新值才替换
  await upsertDailyLog(db, { namespace: "sol", date: "2026-10-10", title: "t", summary: "- s", affectChord: null });
  assert.equal((await getDailyLog(db, { namespace: "sol", date: "2026-10-10" }))?.affect_chord, "Fmaj9");
});

test("背景注入：有 chord 渲染 ♪ 行，无 chord 与 P4 前逐字节一致", async () => {
  insertDailyLog("sol", "2026-10-09", "无和弦", "- 平淡", null);
  insertDailyLog("sol", "2026-10-10", "有和弦", "- 动情", "Am add9 · mf");
  const ctxValue = await loadBackgroundContext(env, identity("sol"));
  const block = formatBackgroundBlock(ctxValue);
  // 旧日期在前；chord 是紧跟该篇 summary 的独立一行（旧 assembler 渲染 "\n♪ <chord>" 同款）
  const chordlessPart = '<daily_log date="2026-10-09">\n【无和弦】\n- 平淡\n</daily_log>';
  const chordPart = '<daily_log date="2026-10-10">\n【有和弦】\n- 动情\n♪ Am add9 · mf\n</daily_log>';
  assert.ok(block.includes(chordlessPart), block);
  assert.ok(block.includes(chordPart), block);
  // 无 chord 的输出与 P4 前形状完全一致（无 ♪、无多余空行）
  const ctxNone = { baseline: null,
    dailyLogs: [{ date: "2026-10-09", title: "无和弦", summary: "- 平淡", affect_chord: null }],
    pendingText: null };
  assert.equal(formatBackgroundBlock(ctxNone), `<daily_log>\n${chordlessPart}\n</daily_log>`);
  // 三协议主链（chat）里模型实际能看到 chord 行
  await run("/sol/v1/chat/completions", { model: "sol", messages: [{ role: "user", content: "你好" }] });
  const system = calls[0].query.messages.find((m: any) => m.role === "system").content as string;
  assert.match(system, /♪ Am add9 · mf/);
});

test("工具面：daily_log_write 暴露 affect_chord，生成语义只活在描述里（无运行期格式校验）", async () => {
  const tool = getTools().find((t: any) => t.name === "daily_log_write") as any;
  assert.match(tool.description, /affect_chord/);
  const desc: string = tool.inputSchema.properties.affect_chord.description;
  // 旧版描述逐字移植：格式、最多 4 个和弦、绝对和弦名、情绪温度才写 / 普通-中性省略、替换语义
  assert.match(desc, /skip for routine\/neutral sessions/);
  assert.match(desc, /Max 4 chords per line/);
  assert.match(desc, /a new chord will replace it/);
  // 忠实旧版：入口不校验格式，"乱写"的 chord 也照收（规则靠模型自觉，P4 不加防护）
  const weird = await mcpCall("daily_log_write", { title: "随意", summary: "- s", affect_chord: "不是和弦" });
  assert.equal(weird.result.isError, undefined);
  assert.equal(weird.result.structuredContent.data.affect_chord, "不是和弦");
});
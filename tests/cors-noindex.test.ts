import { strict as assert } from "node:assert";
import { test, beforeEach } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import worker from "../src/index";
import { invalidateSettingsCache } from "../src/gateway/config";

// P5-E/F 验收（行为模板 = 旧分支 77e25c0 CORS 白名单 + 89c2240 noindex）：
//   CORS_ALLOW_ORIGINS 不配 = 不返回任何 CORS 头（浏览器跨域全拦）；配置后白名单内
//   Origin 精确等值匹配（不吃通配符/前缀/子串），OPTIONS 预检 204 + 完整 CORS 头
//   不进业务路由；全部响应带 x-robots-tag: noindex, nofollow，admin 两页 HTML
//   另有 meta robots 兜底。走全栈 worker.fetch，业务路由不改、只测传输层 wrapper。

(crypto.subtle as any).timingSafeEqual = (a: Uint8Array, b: Uint8Array) => timingSafeEqual(a, b);

let sqlite: DatabaseSync;
let db: any;
let env: any;
let ctx: any;

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
  ctx = { waitUntil() {} };
  env = { DB: db, CHATBOX_API_KEY: "owner-key", AI: {} };
  invalidateSettingsCache();
});

function request(path: string, method = "GET", origin?: string): Request {
  const headers: Record<string, string> = {};
  if (origin) headers.origin = origin;
  return new Request(`https://aelios.test${path}`, { method, headers });
}

test("未配置 CORS_ALLOW_ORIGINS：带 Origin 的请求不返回任何 CORS 头（保持现状）", async () => {
  const response = await worker.fetch(request("/health", "GET", "https://memoria.example"), env, ctx);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  assert.equal(response.headers.get("vary"), null);
});

test("未配置时 OPTIONS 进路由不拦截：/health 落 404，/mcp 保持自有 204（均无 CORS 头）", async () => {
  const health = await worker.fetch(request("/health", "OPTIONS"), env, ctx);
  assert.equal(health.status, 404);
  assert.equal(health.headers.get("access-control-allow-origin"), null);

  const mcp = await worker.fetch(request("/mcp", "OPTIONS"), env, ctx);
  assert.equal(mcp.status, 204);
  assert.equal(mcp.headers.get("access-control-allow-origin"), null);
});

test("配置白名单 + Origin 精确匹配：回显该 Origin 并带 Vary: Origin", async () => {
  env.CORS_ALLOW_ORIGINS = "https://memoria.example";
  const response = await worker.fetch(request("/health", "GET", "https://memoria.example"), env, ctx);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "https://memoria.example");
  assert.equal(response.headers.get("vary"), "Origin");
});

test("配置白名单 + 不匹配或前缀绕过：不获得 CORS 许可", async () => {
  env.CORS_ALLOW_ORIGINS = "https://memoria.example";
  for (const origin of ["https://evil.example", "https://evil.memoria.example", "https://memoria.example.evil.com", "https://memoria.example:8443"]) {
    const response = await worker.fetch(request("/health", "GET", origin), env, ctx);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), null, origin);
    assert.equal(response.headers.get("vary"), null, origin);
  }
});

test("配置白名单 + 无 Origin 头：不加 CORS 头（响应仍带 noindex）", async () => {
  env.CORS_ALLOW_ORIGINS = "https://memoria.example";
  const response = await worker.fetch(request("/health", "GET"), env, ctx);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
});

test("配置白名单 + OPTIONS 预检匹配：204 + 完整 CORS 头，不进业务路由", async () => {
  env.CORS_ALLOW_ORIGINS = "https://memoria.example";
  const response = await worker.fetch(request("/v1/chat/completions", "OPTIONS", "https://memoria.example"), env, ctx);
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), "https://memoria.example");
  assert.ok(response.headers.get("access-control-allow-methods")?.includes("GET"));
  assert.ok(response.headers.get("access-control-allow-methods")?.includes("POST"));
  assert.ok(response.headers.get("access-control-allow-headers")?.includes("Authorization"));
  assert.equal(response.headers.get("access-control-max-age"), "86400");
  assert.equal(response.headers.get("vary"), "Origin");
  assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
});

test("配置白名单 + OPTIONS 预检不匹配：204 但无 CORS 头", async () => {
  env.CORS_ALLOW_ORIGINS = "https://memoria.example";
  const response = await worker.fetch(request("/v1/chat/completions", "OPTIONS", "https://evil.example"), env, ctx);
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  assert.equal(response.headers.get("access-control-allow-methods"), null);
  assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
});

test("多 Origin 逗号分隔（含空格）精确匹配第二项", async () => {
  env.CORS_ALLOW_ORIGINS = "https://a.example, https://b.example";
  const response = await worker.fetch(request("/health", "GET", "https://b.example"), env, ctx);
  assert.equal(response.headers.get("access-control-allow-origin"), "https://b.example");
});

test("noindex：普通 API、错误响应均带 x-robots-tag，CORS 与 noindex 互不影响", async () => {
  env.CORS_ALLOW_ORIGINS = "https://memoria.example";
  const ok = await worker.fetch(request("/health", "GET", "https://memoria.example"), env, ctx);
  assert.equal(ok.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.equal(ok.headers.get("access-control-allow-origin"), "https://memoria.example");

  const notFound = await worker.fetch(request("/no-such-path", "GET"), env, ctx);
  assert.equal(notFound.status, 404);
  assert.equal(notFound.headers.get("x-robots-tag"), "noindex, nofollow");
});

test("Admin 两页 HTML 含 meta robots 兜底", async () => {
  const admin = await worker.fetch(request("/admin"), env, ctx);
  assert.equal(admin.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.match(await admin.text(), /<meta name="robots" content="noindex, nofollow">/);

  const starmap = await worker.fetch(request("/admin/starmap"), env, ctx);
  assert.equal(starmap.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.match(await starmap.text(), /<meta name="robots" content="noindex, nofollow">/);
});

test("/admin 保存的 settings（D1 gateway_config）里配置 CORS 白名单同样生效", async () => {
  sqlite.prepare("INSERT INTO gateway_config (id, config_json, updated_at) VALUES (1, ?, ?)").run(
    JSON.stringify({ version: 3, identities: [], settings: { CORS_ALLOW_ORIGINS: "https://from-admin.example" } }),
    "2026-10-11T00:00:00.000Z"
  );
  const response = await worker.fetch(request("/health", "GET", "https://from-admin.example"), env, ctx);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "https://from-admin.example");
  assert.equal(response.headers.get("vary"), "Origin");
});
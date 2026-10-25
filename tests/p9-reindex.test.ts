import { strict as assert } from "node:assert";
import { test, beforeEach, afterEach } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import worker from "../src/index";
import { upsertMemoryEmbedding } from "../src/memory/embedding";
import { runVectorBackfill } from "../src/memory/vectorBackfill";
import { runVectorDoctor } from "../src/memory/vectorDoctor";
import { upsertMemoryFts } from "../src/memory/fts";
import type { MemoryRecord } from "../src/types";

// P9 · 迁移后索引重建与向量修复的专项测试（P9-DS 修订 + 二轮收口）。
// 覆盖：namespace 漂移判 stale + repair 按新 namespace 重写、四类 stale 不回归、
// repair 幂等、doctor cleanup 必须显式、doctor 不误判漂移向量为 orphan、
// p9 单 namespace 逐批收敛（省略 namespace 落回 profile 默认、绝不全空间）、
// chooseNamespace=false 钉死绑定 namespace、401/403、扫描+修复共用同一份子请求预算、
// 队头持续失败不饿死后续项（skip 游标）、MAX_SCAN 精确边界（恰好 5000 不误判、
// 5001 触发 blocker）、no_vector_id blocker、报告不含记忆正文、
// 三个旧向量维护入口（doctor/backfill/reindex）同一套 key profile 鉴权：
// pinned key 显式请求他空间 403 且拒绝前零扫描零写入零删除、省略 namespace 用
// 绑定空间、chooseNamespace=true 显式跨空间保留、
// FTS 从 D1 重建收敛且不动业务表、rebuild 清迁移前残留行、
// 不可分词内容的空标记终态与替换、FTS 顶层失败/清空失败/orphan purge 失败
// fail-closed、orphan purge 限定当前 namespace、limit 跨 messages/memories
// 共用且硬上限 100（requested_limit/effective_limit）。
// 环境与 vector-backfill.test.ts 同构：真实迁移 + node:sqlite、内存 Vectorize double、
// Workers AI embedding double（"毒"字触发 embedding 失败）；doctor 的 /list 走 fetch 桩。
(crypto.subtle as any).timingSafeEqual = (a: Uint8Array, b: Uint8Array) => timingSafeEqual(a, b);
let sqlite: DatabaseSync;
let env: any;
let vectors: Map<string, { id: string; values: number[]; namespace?: string; metadata: Record<string, unknown> }>;
let deletedVectorIds: string[];
let upsertCalls: number;
let embedCalls: number;
let listVectorIds: string[];
let fetchCalls: number;
let getByIdsCalls: number;
const realFetch = globalThis.fetch;

beforeEach(() => {
  sqlite?.close(); sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync("migrations").filter((f: string) => f.endsWith(".sql")).sort()) {
    try { sqlite.exec(readFileSync(`migrations/${file}`, "utf8")); }
    catch (error) {
      if (!String(error).includes("fts5")) throw error;
    }
  }
  const db = { prepare(sql: string) {
    const statement = sqlite.prepare(sql); let args: any[] = [];
    const api = { bind(...values: any[]) { args = values; return api; },
      async first() { return statement.get(...args) || null; },
      async all() { return { results: statement.all(...args) }; },
      async run() { const r = statement.run(...args); return { meta: { changes: r.changes } }; }
    }; return api;
  } };
  vectors = new Map(); deletedVectorIds = []; upsertCalls = 0; embedCalls = 0; listVectorIds = [];
  fetchCalls = 0; getByIdsCalls = 0;
  env = {
    DB: db, CHATBOX_API_KEY: "owner-key", MEMORY_MCP_API_KEY: "mcp-key", GUIDE_DOG_API_KEY: "gd-key",
    AI: { async run(_model: string, data: any) {
      if (String(data.text[0]).includes("毒")) throw new Error("poisoned embedding");
      embedCalls += 1; return { data: [[0.1, 0.2, data.text[0].length]] };
    } },
    CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_API_TOKEN: "tok", VECTORIZE_INDEX_NAME: "memo-kb",
    VECTORIZE: {
      async getByIds(ids: string[]) {
        getByIdsCalls += 1;
        return ids.flatMap((id) => (vectors.has(id) ? [vectors.get(id) as any] : []));
      },
      async upsert(items: any[]) { upsertCalls += 1; for (const item of items) vectors.set(item.id, item); return { mutationId: "m" }; },
      async deleteByIds(ids: string[]) { for (const id of ids) { vectors.delete(id); deletedVectorIds.push(id); } return { mutationId: "m" }; }
    }
  };
  (globalThis as any).fetch = async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify({ result: { ids: listVectorIds, isTruncated: false } }), { status: 200 });
  };
});

afterEach(() => {
  (globalThis as any).fetch = realFetch;
});

let seq = 0;
function insertMemory(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  seq += 1;
  const id = overrides.id ?? `mem_${String(seq).padStart(32, "0")}`;
  const row = {
    id, namespace: "eva", type: "note", content: `记忆 ${seq}`, summary: null, importance: 0.5,
    confidence: 0.8, status: "active", pinned: 0, tags: "[]", source: "review", source_message_ids: "[]",
    vector_id: `mem_${id}`, created_at: `2026-09-22T00:00:${String(seq % 60).padStart(2, "0")}Z`,
    updated_at: "2026-09-22T00:00:00Z", expires_at: null, ...overrides
  };
  sqlite.prepare(
    `INSERT INTO memories (id, namespace, type, content, summary, importance, confidence, status, pinned,
       tags, source, source_message_ids, vector_id, created_at, updated_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(row.id, row.namespace, row.type, row.content, row.summary, row.importance, row.confidence, row.status,
    row.pinned, row.tags, row.source, row.source_message_ids, row.vector_id, row.created_at, row.updated_at,
    row.expires_at);
  return sqlite.prepare("SELECT * FROM memories WHERE id = ?").get(row.id) as unknown as MemoryRecord;
}

function insertMessage(overrides: { id?: string; namespace?: string; role?: string; content?: string } = {}) {
  seq += 1;
  const row = {
    id: overrides.id ?? `msg_${String(seq).padStart(32, "0")}`,
    namespace: overrides.namespace ?? "eva",
    role: overrides.role ?? "user",
    content: overrides.content ?? `消息 ${seq}`,
    ...overrides
  };
  sqlite.prepare(
    `INSERT INTO messages (id, conversation_id, namespace, role, content, source, created_at)
     VALUES (?, 'c1', ?, ?, ?, 'gw', '2026-10-01T00:00:00Z')`
  ).run(row.id, row.namespace, row.role, row.content);
  return row;
}

// 模拟"P8 前旧向量"：Vectorize namespace 与 metadata.namespace 都是旧值，正文/类型等与 D1 一致。
function plantDriftedVector(memory: MemoryRecord, oldNamespace: string) {
  vectors.set(memory.vector_id as string, {
    id: memory.vector_id as string,
    values: [0.1],
    namespace: oldNamespace,
    metadata: {
      namespace: oldNamespace, kind: "memory", ref_id: memory.id,
      type: memory.type, content: memory.content, status: "active", tags: "[]"
    }
  });
}

async function embedNormally(memory: MemoryRecord) {
  assert.equal(await upsertMemoryEmbedding(env, memory), true);
}

async function callEndpoint(path: string, body: unknown, key = "owner-key"): Promise<{ status: number; json: any }> {
  const response = await worker.fetch(new Request(`https://aelios.test${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body)
  }), env, { waitUntil() {} } as any);
  return { status: response.status, json: await response.json() };
}

async function post(path: string, body: unknown, key = "owner-key"): Promise<any> {
  return (await callEndpoint(path, body, key)).json;
}

// 迁移 0014 的 fts5 建表在本机 node:sqlite 可用；老版本缺 fts5 时退化为普通表，
// 两种形状 upsert/backfill/purge/rebuild 的 SQL 都能跑。
function ensureFtsTables() {
  const exists = (table: string) =>
    sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  if (!exists("message_fts")) sqlite.exec("CREATE TABLE message_fts (fts_body TEXT, namespace TEXT, message_id TEXT)");
  if (!exists("memory_fts")) sqlite.exec("CREATE TABLE memory_fts (fts_body TEXT, namespace TEXT, memory_id TEXT)");
}

test("namespace drift: dry run reports stale, repair rewrites vector under the new namespace", async () => {
  const memory = insertMemory({ content: "迁移后归属新空间的记忆" });
  plantDriftedVector(memory, "id:12345");
  embedCalls = 0;

  const dry = await runVectorBackfill(env, { namespace: "eva" });
  assert.equal(dry.counts.ok, 0);
  assert.equal(dry.counts.stale, 1);
  assert.equal(dry.samples.stale[0].reason, "namespace");
  assert.equal(embedCalls, 0);

  const report = await runVectorBackfill(env, { namespace: "eva", dryRun: false });
  assert.equal(report.repair?.repaired, 1);
  const written = vectors.get(memory.vector_id as string) as any;
  assert.equal(written.namespace, "eva", "vectorize namespace moves to the D1 namespace");
  assert.equal(written.metadata.namespace, "eva");
  assert.equal(written.metadata.content, "迁移后归属新空间的记忆");
});

test("content / type / tags / status drift keep being flagged stale", async () => {
  const content = insertMemory({ content: "新内容" });
  vectors.set(content.vector_id as string, {
    id: content.vector_id as string, values: [0.1], namespace: "eva",
    metadata: { namespace: "eva", ref_id: content.id, content: "旧内容", type: content.type, tags: "[]", status: "active" }
  });
  const type = insertMemory({ type: "fact" });
  vectors.set(type.vector_id as string, {
    id: type.vector_id as string, values: [0.1], namespace: "eva",
    metadata: { namespace: "eva", ref_id: type.id, content: type.content, type: "note", tags: "[]", status: "active" }
  });
  const tags = insertMemory({ tags: "[\"x\"]" });
  vectors.set(tags.vector_id as string, {
    id: tags.vector_id as string, values: [0.1], namespace: "eva",
    metadata: { namespace: "eva", ref_id: tags.id, content: tags.content, type: tags.type, tags: "[\"y\"]", status: "active" }
  });
  const status = insertMemory();
  vectors.set(status.vector_id as string, {
    id: status.vector_id as string, values: [0.1], namespace: "eva",
    metadata: { namespace: "eva", ref_id: status.id, content: status.content, type: status.type, tags: "[]", status: "archived" }
  });
  const clean = insertMemory();
  await embedNormally(clean);

  const report = await runVectorBackfill(env, { namespace: "eva" });
  assert.equal(report.counts.ok, 1);
  assert.equal(report.counts.stale, 4);
  const reasons = report.samples.stale.map((s) => s.reason).sort();
  assert.deepEqual(reasons, ["content", "status", "tags", "type"]);
});

test("second repair run is idempotent with no further writes", async () => {
  const drifted = insertMemory({ content: "漂移记忆" });
  plantDriftedVector(drifted, "name:alice");
  const missing = insertMemory({ content: "缺向量记忆" });

  await runVectorBackfill(env, { namespace: "eva", dryRun: false });
  const afterFirst = { embedCalls, upsertCalls };
  const second = await runVectorBackfill(env, { namespace: "eva", dryRun: false });

  assert.deepEqual(second.counts, { ok: 2, missing: 0, stale: 0, no_vector_id: 0 });
  assert.equal(second.repair?.attempted, 0);
  assert.equal(embedCalls, afterFirst.embedCalls, "no redundant embedding on the second run");
  assert.equal(upsertCalls, afterFirst.upsertCalls, "no redundant vectorize writes on the second run");
  assert.ok(vectors.has(missing.vector_id as string));
});

test("doctor never deletes anything unless cleanup is explicitly true", async () => {
  const active = insertMemory({ content: "活记忆" });
  await embedNormally(active);
  const archived = insertMemory({ status: "archived", content: "归档记忆" });
  vectors.set(archived.vector_id as string, {
    id: archived.vector_id as string, values: [0.1], namespace: "eva",
    metadata: { namespace: "eva", ref_id: archived.id, content: "归档记忆", type: "note", status: "archived" }
  });
  vectors.set("mem_ghost_1", {
    id: "mem_ghost_1", values: [0.1], namespace: "eva",
    metadata: { namespace: "eva", ref_id: "ghost_1", content: "没有本体的孤儿", type: "note" }
  });
  listVectorIds = [active.vector_id as string, archived.vector_id as string, "mem_ghost_1"];

  const dry = await runVectorDoctor(env, { namespace: "eva" });
  assert.deepEqual(dry.counts, { backed_active: 1, backed_inactive: 1, orphan: 1 });
  assert.equal(dry.cleanup, undefined);
  assert.equal(deletedVectorIds.length, 0, "no deletion happens without cleanup=true");
  assert.equal(vectors.size, 3);

  const clean = await runVectorDoctor(env, { namespace: "eva", cleanup: true });
  assert.equal(clean.cleanup?.deleted_count, 2);
  assert.deepEqual([...deletedVectorIds].sort(), [archived.vector_id as string, "mem_ghost_1"].sort());
  assert.ok(vectors.has(active.vector_id as string), "backed_active vector survives cleanup");
});

test("doctor classifies namespace-drifted vectors as backed, not orphan", async () => {
  const memory = insertMemory({ content: "D1 已迁到新 namespace 的记忆" });
  plantDriftedVector(memory, "id:12345");
  listVectorIds = [memory.vector_id as string];

  // 迁移前的旧 namespace 视角：D1 行在新 namespace 下仍存在 → 不是 orphan，cleanup 不会误删。
  const fromOld = await runVectorDoctor(env, { namespace: "id:12345" });
  assert.deepEqual(fromOld.counts, { backed_active: 1, backed_inactive: 0, orphan: 0 });

  const cleaned = await runVectorDoctor(env, { namespace: "id:12345", cleanup: true });
  assert.equal(cleaned.cleanup?.deleted_count, 0, "drifted vector backed by active D1 row is not a cleanup target");
  assert.ok(vectors.has(memory.vector_id as string));
});

test("p9 reindex audits and repairs one explicit namespace per request and reports no content", async () => {
  const evaDrift = insertMemory({ content: "eva秘密暗号芝麻开门正文", namespace: "eva" });
  plantDriftedVector(evaDrift, "name:eva-old");
  const evaMissing = insertMemory({ content: "eva缺失向量", namespace: "eva" });
  const bobDrift = insertMemory({ content: "bob秘密暗号芝麻开门正文", namespace: "bob" });
  plantDriftedVector(bobDrift, "name:bob-old");

  const unauthorized = await callEndpoint("/v1/p9-reindex", {}, "nope");
  assert.equal(unauthorized.status, 401);

  const dry = await post("/v1/p9-reindex", { namespace: "eva" });
  assert.equal(dry.data.namespace, "eva");
  assert.equal(dry.data.dry_run, true);
  assert.deepEqual(dry.data.counts, { ok: 0, missing: 1, stale: 1, no_vector_id: 0 });
  assert.equal(dry.data.pending, 2);
  assert.equal(dry.data.converged, false);
  assert.equal(vectors.size, 2, "dry run writes nothing");

  const repaired = await post("/v1/p9-reindex", { namespace: "eva", dry_run: false });
  assert.equal(repaired.data.converged, true);
  assert.deepEqual(repaired.data.blockers, { no_vector_id: 0, scan_truncated: false });
  assert.equal(repaired.data.repair.repaired, 2);
  assert.equal((vectors.get(evaDrift.vector_id as string) as any).namespace, "eva");
  assert.equal(
    (vectors.get(bobDrift.vector_id as string) as any).namespace, "name:bob-old",
    "a single-namespace request leaves other namespaces untouched"
  );

  const bob = await post("/v1/p9-reindex", { namespace: "bob", dry_run: false });
  assert.equal(bob.data.converged, true);
  assert.equal((vectors.get(bobDrift.vector_id as string) as any).namespace, "bob");

  const again = await post("/v1/p9-reindex", { namespace: "eva", dry_run: false });
  assert.equal(again.data.converged, true);
  assert.equal(again.data.repair.attempted, 0);

  const serialized = JSON.stringify(repaired) + JSON.stringify(again) + JSON.stringify(bob);
  assert.ok(!serialized.includes("秘密暗号"), "p9 report must not leak memory content");
  assert.ok(!serialized.includes("芝麻开门"));
  assert.ok(!serialized.includes("sample"), "aggregate report carries no content samples");
  void evaMissing;
});

test("p9 reindex without an explicit namespace falls back to the profile namespace, never all spaces", async () => {
  const evaDrift = insertMemory({ content: "eva漂移", namespace: "eva" });
  plantDriftedVector(evaDrift, "name:eva-old");
  const bobDrift = insertMemory({ content: "bob漂移", namespace: "bob" });
  plantDriftedVector(bobDrift, "name:bob-old");

  // chatbox key（chooseNamespace=true）省略 namespace → 落回 profile 默认 "default"：
  // 不会去扫描/修复 eva、bob，更不会全空间执行。
  const response = await post("/v1/p9-reindex", { dry_run: false });
  assert.equal(response.data.namespace, "default");
  assert.equal(response.data.active_memories, 0);
  assert.equal(response.data.converged, true, "the empty bound namespace is trivially converged");
  assert.equal(vectors.size, 2, "other namespaces are left untouched");
  assert.equal((vectors.get(evaDrift.vector_id as string) as any).namespace, "name:eva-old");
  assert.equal((vectors.get(bobDrift.vector_id as string) as any).namespace, "name:bob-old");
});

test("chooseNamespace=false keys stay pinned to their bound namespace (403 for missing scope)", async () => {
  const evaDrift = insertMemory({ content: "eva漂移", namespace: "eva" });
  plantDriftedVector(evaDrift, "name:eva-old");
  const boundMissing = insertMemory({ content: "绑定空间缺向量", namespace: "default" });
  embedCalls = 0;

  const forbidden = await callEndpoint("/v1/p9-reindex", { namespace: "eva", dry_run: false }, "gd-key");
  assert.equal(forbidden.status, 403, "chat:proxy-only key cannot touch p9 reindex");

  // mcp key（chooseNamespace=false）请求 eva：实际只操作绑定 namespace "default"。
  const response = await post("/v1/p9-reindex", { namespace: "eva", dry_run: false }, "mcp-key");
  assert.equal(response.data.namespace, "default");
  assert.equal(response.data.repair.repaired, 1, "the bound namespace's backlog is processed");
  assert.ok(vectors.has(boundMissing.vector_id as string));
  assert.equal(
    (vectors.get(evaDrift.vector_id as string) as any).namespace, "name:eva-old",
    "the requested foreign namespace is not touched"
  );

  // FTS 同规则：mcp key 请求 eva，实际只重建 default。
  ensureFtsTables();
  const evaMessage = insertMessage({ namespace: "eva", content: "eva消息正文" });
  const defaultMessage = insertMessage({ namespace: "default", content: "default消息正文" });
  const fts = await post("/v1/fts-reindex", { namespace: "eva" }, "mcp-key");
  assert.equal(fts.data.namespace, "default");
  assert.equal(fts.data.messagesIndexed, 1);
  const evaRows = sqlite.prepare("SELECT COUNT(*) AS n FROM message_fts WHERE message_id = ?").get(evaMessage.id) as { n: number };
  const defaultRows = sqlite.prepare("SELECT COUNT(*) AS n FROM message_fts WHERE message_id = ?").get(defaultMessage.id) as { n: number };
  assert.equal(evaRows.n, 0, "foreign namespace is not reindexed");
  assert.equal(defaultRows.n, 1);

  const ftsForbidden = await callEndpoint("/v1/fts-reindex", {}, "gd-key");
  assert.equal(ftsForbidden.status, 403);
  const ftsUnauthorized = await callEndpoint("/v1/fts-reindex", {}, "nope");
  assert.equal(ftsUnauthorized.status, 401);
});

test("p9 reindex converges one namespace through repeated bounded batches", async () => {
  for (let i = 0; i < 210; i += 1) insertMemory({ namespace: "nsA" });

  const first = await post("/v1/p9-reindex", { namespace: "nsA", dry_run: false, limit: 200 });
  assert.equal(first.data.repair.attempted, 200);
  assert.equal(first.data.repair.remaining, 10);
  assert.equal(first.data.pending, 10);
  assert.equal(first.data.converged, false);
  assert.deepEqual(first.data.subrequests, { scan: 12, repair: 400 }, "scan cost and repair cost are both accounted");

  const second = await post("/v1/p9-reindex", { namespace: "nsA", dry_run: false, limit: 200 });
  assert.equal(second.data.converged, true);
  assert.equal(second.data.pending, 0);
  assert.equal(second.data.repair.attempted, 10);
  assert.equal(second.data.subrequests.repair, 20);
});

test("scan and repair share one conservative subrequest budget, not a repair-only budget", async () => {
  for (let i = 0; i < 300; i += 1) insertMemory({ namespace: "nsB" });

  // scanCost = 1 次 D1 列表 + ceil(300/20)=15 批 getByIds = 16；
  // 剩余预算 60-16=44 → 每次修复 2 个子请求 → 最多修 22 条，即便 limit 给到 200。
  const report = await runVectorBackfill(env, { namespace: "nsB", dryRun: false, limit: 200, subrequestBudget: 60 });
  assert.equal(report.repair?.attempted, 22);
  assert.equal(report.repair?.remaining, 278);
  assert.deepEqual(report.subrequests, { scan: 16, repair: 44 });
});

test("persistent head failures do not starve later rows once the skip cursor advances", async () => {
  // 前两条是"毒"内容（embedding 必挂），后两条正常；创建顺序即修复顺序。
  insertMemory({ namespace: "nsC", content: "毒药记忆甲" });
  insertMemory({ namespace: "nsC", content: "毒药记忆乙" });
  const normalOne = insertMemory({ namespace: "nsC", content: "正常记忆内容丙" });
  const normalTwo = insertMemory({ namespace: "nsC", content: "正常记忆内容丁" });

  const stuck = await runVectorBackfill(env, { namespace: "nsC", dryRun: false, limit: 2 });
  assert.equal(stuck.repair?.attempted, 2);
  assert.equal(stuck.repair?.repaired, 0);
  assert.equal(stuck.repair?.failed_count, 2);
  assert.equal(stuck.repair?.remaining, 4);

  // 不带游标重跑：失败项钉在队头，后续项被堵在批次外——这正是要用 skip 的场景。
  const stillStuck = await runVectorBackfill(env, { namespace: "nsC", dryRun: false, limit: 2 });
  assert.equal(stillStuck.repair?.repaired, 0);
  assert.equal(stillStuck.repair?.failed_count, 2);

  // skip 游标跳过队头：后续合法记录得到处理机会，失败项仍在 remaining 里明确上报。
  const advanced = await runVectorBackfill(env, { namespace: "nsC", dryRun: false, limit: 2, skip: 2 });
  assert.equal(advanced.skip, 2);
  assert.equal(advanced.repair?.attempted, 2);
  assert.equal(advanced.repair?.repaired, 2);
  assert.equal(advanced.repair?.failed_count, 0);
  assert.equal(advanced.repair?.remaining, 2, "the poisoned rows stay visible as pending work");
  assert.ok(vectors.has(normalOne.vector_id as string));
  assert.ok(vectors.has(normalTwo.vector_id as string));
});

test("p9 reindex surfaces no_vector_id as a blocker without touching D1", async () => {
  const normal = insertMemory({ content: "正常记忆" });
  await embedNormally(normal);
  insertMemory({ vector_id: null, content: "没有 vector_id 的记忆" });

  const dry = await post("/v1/p9-reindex", { namespace: "eva" });
  assert.equal(dry.data.blockers.no_vector_id, 1);
  assert.equal(dry.ok, false);
  assert.equal(dry.data.converged, true, "no_vector_id is not a repair backlog item");

  const repaired = await post("/v1/p9-reindex", { namespace: "eva", dry_run: false });
  assert.equal(repaired.data.blockers.no_vector_id, 1);
  assert.equal(repaired.ok, false);
  const row = sqlite.prepare("SELECT vector_id FROM memories WHERE vector_id IS NULL").get() as { vector_id: string | null };
  assert.equal(row.vector_id, null, "D1 is never written to fabricate a vector_id");
});

test("p9 reindex reports hitting MAX_SCAN as an explicit blocker, never as converged", async () => {
  sqlite.exec("BEGIN");
  const insert = sqlite.prepare(
    `INSERT INTO memories (id, namespace, type, content, summary, importance, confidence, status, pinned,
       tags, source, source_message_ids, vector_id, created_at, updated_at, expires_at)
     VALUES (?, 'big', 'note', ?, NULL, 0.5, 0.8, 'active', 0, '[]', 'review', '[]', ?, '2026-09-22T00:00:00Z', '2026-09-22T00:00:00Z', NULL)`
  );
  for (let i = 0; i < 5001; i += 1) insert.run(`mem_big_${i}`, `扫描 ${i}`, `vec_big_${i}`);
  sqlite.exec("COMMIT");

  const response = await post("/v1/p9-reindex", { namespace: "big" });
  assert.equal(response.data.active_memories, 5000);
  assert.equal(response.data.scan_truncated, true);
  assert.equal(response.data.blockers.scan_truncated, true);
  assert.equal(response.data.converged, false, "a truncated scan can never claim convergence");
  assert.equal(response.ok, false);
  assert.ok(response.data.errors.some((e: string) => e.includes("scan_truncated_at_5000")));
});

test("exactly MAX_SCAN rows scan fully without a false truncation report", async () => {
  sqlite.exec("BEGIN");
  const insert = sqlite.prepare(
    `INSERT INTO memories (id, namespace, type, content, summary, importance, confidence, status, pinned,
       tags, source, source_message_ids, vector_id, created_at, updated_at, expires_at)
     VALUES (?, 'edge', 'note', ?, NULL, 0.5, 0.8, 'active', 0, '[]', 'review', '[]', ?, '2026-09-22T00:00:00Z', '2026-09-22T00:00:00Z', NULL)`
  );
  for (let i = 0; i < 5000; i += 1) insert.run(`mem_edge_${i}`, `边界 ${i}`, `vec_edge_${i}`);
  sqlite.exec("COMMIT");

  const response = await post("/v1/p9-reindex", { namespace: "edge" });
  assert.equal(response.data.active_memories, 5000, "all 5000 rows were fetched by the +1 probe");
  assert.equal(response.data.scan_truncated, false, "exactly 5000 rows fit the scan budget: no truncation");
  assert.equal(response.data.blockers.scan_truncated, false);
  assert.ok(!response.data.errors.some((e: string) => e.includes("scan_truncated_at_5000")));
  assert.equal(response.data.counts.missing, 5000, "the full boundary batch is still classified");
});

test("doctor report carries no memory content either", async () => {
  const memory = insertMemory({ content: "医生视角的秘密暗号正文" });
  await embedNormally(memory);
  listVectorIds = [memory.vector_id as string];

  const response = await post("/v1/vector-doctor", { namespace: "eva" });
  assert.equal(response.ok, true);
  const serialized = JSON.stringify(response);
  assert.ok(!serialized.includes("秘密暗号"), "doctor samples must not carry content previews");
  assert.ok(!serialized.includes("content_preview"));
});

test("legacy vector endpoints 403 pinned keys on foreign namespaces before any scan, write or delete", async () => {
  const evaActive = insertMemory({ content: "eva活记忆", namespace: "eva" });
  await embedNormally(evaActive);
  const archived = insertMemory({ status: "archived", content: "eva归档记忆", namespace: "eva" });
  vectors.set(archived.vector_id as string, {
    id: archived.vector_id as string, values: [0.1], namespace: "eva",
    metadata: { namespace: "eva", ref_id: archived.id, content: "归档记忆", type: "note", status: "archived" }
  });
  vectors.set("mem_ghost_1", {
    id: "mem_ghost_1", values: [0.1], namespace: "eva",
    metadata: { namespace: "eva", ref_id: "ghost_1", content: "没有本体的孤儿", type: "note" }
  });
  listVectorIds = [evaActive.vector_id as string, archived.vector_id as string, "mem_ghost_1"];
  const vectorSnapshot = vectors.size;

  // mcp key（chooseNamespace=false，绑定 "default"）显式请求 eva 的 doctor cleanup：
  // 403 必须发生在 /list 枚举之前——连扫描都不做，更没有删除。
  fetchCalls = 0;
  const doctor = await callEndpoint("/v1/vector-doctor", { namespace: "eva", cleanup: true }, "mcp-key");
  assert.equal(doctor.status, 403);
  assert.equal(fetchCalls, 0, "no /list enumeration before the rejection");
  assert.equal(deletedVectorIds.length, 0, "zero deletions on a rejected cross-namespace cleanup");
  assert.equal(vectors.size, vectorSnapshot);

  // 同 key 调 vector-backfill 显式修复：零扫描零写入。
  getByIdsCalls = 0; upsertCalls = 0; embedCalls = 0;
  const backfill = await callEndpoint("/v1/vector-backfill", { namespace: "eva", dry_run: false }, "mcp-key");
  assert.equal(backfill.status, 403);
  assert.equal(getByIdsCalls, 0, "no Vectorize scan before the rejection");
  assert.equal(upsertCalls, 0, "zero vectorize writes");
  assert.equal(embedCalls, 0, "zero embeddings");

  // 同 key 调 vector_reindex：零扫描零写入。
  fetchCalls = 0; getByIdsCalls = 0; upsertCalls = 0;
  const reindex = await callEndpoint("/v1/debug/vector_reindex", { namespace: "eva", dry_run: false }, "mcp-key");
  assert.equal(reindex.status, 403);
  assert.equal(fetchCalls, 0, "reindex lists nothing before the rejection");
  assert.equal(getByIdsCalls, 0);
  assert.equal(upsertCalls, 0);
  assert.equal(vectors.size, vectorSnapshot, "all three rejections leave the vectors untouched");
});

test("legacy vector endpoints operate the bound namespace when pinned keys omit one", async () => {
  const boundMissing = insertMemory({ content: "绑定空间缺向量", namespace: "default" });
  const evaMissing = insertMemory({ content: "eva缺向量", namespace: "eva" });

  const backfill = await callEndpoint("/v1/vector-backfill", { dry_run: false }, "mcp-key");
  assert.equal(backfill.status, 200);
  assert.equal(backfill.json.ok, true);
  assert.equal(backfill.json.data.namespace, "default", "omitted namespace falls back to the bound namespace");
  assert.equal(backfill.json.data.repair.repaired, 1, "the bound namespace's backlog is processed normally");
  assert.ok(vectors.has(boundMissing.vector_id as string));
  assert.ok(!vectors.has(evaMissing.vector_id as string), "the foreign namespace backlog is not touched");

  const doctor = await callEndpoint("/v1/vector-doctor", {}, "mcp-key");
  assert.equal(doctor.status, 200);
  assert.equal(doctor.json.data.namespace, "default");

  const reindex = await callEndpoint("/v1/debug/vector_reindex", {}, "mcp-key");
  assert.equal(reindex.status, 200);
  assert.equal(reindex.json.data.namespace, "default");

  // 显式请求自己的绑定空间同样是允许的。
  const own = await callEndpoint("/v1/vector-backfill", { namespace: "default" }, "mcp-key");
  assert.equal(own.status, 200);
  assert.equal(own.json.data.namespace, "default");
});

test("chooseNamespace=true keys keep explicit cross-namespace behavior on the legacy endpoints", async () => {
  const evaMissing = insertMemory({ content: "eva缺向量", namespace: "eva" });

  const backfill = await callEndpoint("/v1/vector-backfill", { namespace: "eva", dry_run: false }, "owner-key");
  assert.equal(backfill.status, 200);
  assert.equal(backfill.json.data.namespace, "eva");
  assert.equal(backfill.json.data.repair.repaired, 1);
  assert.ok(vectors.has(evaMissing.vector_id as string));

  const doctor = await callEndpoint("/v1/vector-doctor", { namespace: "eva" }, "owner-key");
  assert.equal(doctor.status, 200);
  assert.equal(doctor.json.data.namespace, "eva");
});

test("fts reindex backfills from D1, converges on repeat and never touches business tables", async () => {
  ensureFtsTables();
  insertMessage({ namespace: "eva", content: "FTS 消息暗号正文" });
  insertMemory({ content: "FTS 记忆正文", namespace: "eva" });
  const businessSnapshot = JSON.stringify(sqlite.prepare("SELECT * FROM memories ORDER BY id").all())
    + JSON.stringify(sqlite.prepare("SELECT * FROM messages ORDER BY id").all());

  const unauthorized = await callEndpoint("/v1/fts-reindex", {}, "nope");
  assert.equal(unauthorized.status, 401);

  const first = await post("/v1/fts-reindex", { namespace: "eva" });
  assert.equal(first.ok, true);
  assert.equal(first.data.rebuild, false);
  assert.equal(first.data.messagesIndexed, 1);
  assert.equal(first.data.memoriesIndexed, 1);
  assert.equal(first.data.messagesUnindexable, 0);
  assert.equal(first.data.memoriesUnindexable, 0);
  assert.equal(first.data.processed, 2);
  assert.equal(first.data.converged, false, "a run that processed rows cannot yet claim convergence");

  const second = await post("/v1/fts-reindex", { namespace: "eva" });
  assert.equal(second.data.converged, true, "repeat run indexes nothing new and reports convergence");
  assert.equal(second.data.processed, 0);
  assert.equal(
    JSON.stringify(sqlite.prepare("SELECT * FROM memories ORDER BY id").all())
      + JSON.stringify(sqlite.prepare("SELECT * FROM messages ORDER BY id").all()),
    businessSnapshot
  );

  const memoryId = (sqlite.prepare("SELECT id FROM memories LIMIT 1").get() as { id: string }).id;
  const rows = sqlite.prepare("SELECT namespace FROM memory_fts WHERE memory_id = ?").all(memoryId);
  assert.equal((rows[0] as any).namespace, "eva");
  assert.ok(!JSON.stringify(first).includes("FTS 消息暗号"), "fts report must not carry content");
});

test("unindexable content becomes a stable terminal state counted separately, not a repeated failure", async () => {
  ensureFtsTables();
  insertMessage({ namespace: "eva", content: "..." });
  insertMessage({ namespace: "eva", role: "assistant", content: "🎉🎉🎉" });
  insertMemory({ content: "the", namespace: "eva" });
  const businessSnapshot = JSON.stringify(sqlite.prepare("SELECT * FROM memories ORDER BY id").all())
    + JSON.stringify(sqlite.prepare("SELECT * FROM messages ORDER BY id").all());

  const first = await post("/v1/fts-reindex", { namespace: "eva" });
  assert.equal(first.ok, true, "unindexable content is not a failure");
  assert.equal(first.data.messagesUnindexable, 2);
  assert.equal(first.data.memoriesUnindexable, 1);
  assert.equal(first.data.messagesIndexed, 0);
  assert.equal(first.data.memoriesIndexed, 0);
  assert.equal(first.data.failed, 0);
  assert.equal(first.data.processed, 3);
  assert.equal(first.data.converged, false);

  // 空标记行：fts_body 为空、namespace 正确、可重复识别。
  const msgRows = sqlite.prepare("SELECT fts_body, namespace FROM message_fts ORDER BY message_id").all() as any[];
  assert.equal(msgRows.length, 2);
  for (const row of msgRows) assert.equal(row.fts_body, "");
  const memRow = sqlite.prepare("SELECT fts_body, namespace FROM memory_fts").get() as any;
  assert.equal(memRow.fts_body, "");
  assert.equal(memRow.namespace, "eva");

  const second = await post("/v1/fts-reindex", { namespace: "eva" });
  assert.equal(second.data.processed, 0, "markers are terminal: the rows are not re-selected every round");
  assert.equal(second.data.converged, true);
  assert.equal(second.data.messagesUnindexable, 0);
  assert.equal(second.data.memoriesUnindexable, 0);
  assert.equal(
    JSON.stringify(sqlite.prepare("SELECT * FROM memories ORDER BY id").all())
      + JSON.stringify(sqlite.prepare("SELECT * FROM messages ORDER BY id").all()),
    businessSnapshot
  );
});

test("unindexable markers are replaced by real text when the normal write path re-indexes", async () => {
  ensureFtsTables();
  const memory = insertMemory({ content: "...", namespace: "eva" });
  await post("/v1/fts-reindex", { namespace: "eva" });
  let row = sqlite.prepare("SELECT fts_body FROM memory_fts WHERE memory_id = ?").get(memory.id) as { fts_body: string };
  assert.equal(row.fts_body, "", "marker row in place");

  // 内容后来更新成正常文本：现有写入路径（与 updateMemory 等同一个函数）替换标记行。
  sqlite.prepare("UPDATE memories SET content = ? WHERE id = ?").run("后来更新的正常文本", memory.id);
  const indexed = await upsertMemoryFts(env.DB, { namespace: "eva", memoryId: memory.id, content: "后来更新的正常文本" });
  assert.equal(indexed, true);
  row = sqlite.prepare("SELECT fts_body FROM memory_fts WHERE memory_id = ?").get(memory.id) as { fts_body: string };
  assert.ok(row.fts_body.includes("正常"), "marker row is replaced by the real body");

  const again = await post("/v1/fts-reindex", { namespace: "eva" });
  assert.equal(again.data.converged, true);
});

test("fts backfill fails closed when the top-level D1 query fails", async () => {
  ensureFtsTables();
  insertMessage({ namespace: "eva", content: "正常消息" });
  insertMemory({ content: "正常记忆", namespace: "eva" });
  sqlite.exec("DROP TABLE message_fts");

  const response = await callEndpoint("/v1/fts-reindex", { namespace: "eva" }, "owner-key");
  assert.equal(response.status, 500);
  assert.equal(response.json.ok, false);
  assert.match(response.json.data.fatal, /messages_query_failed/);
  assert.equal(response.json.data.converged, false);
  assert.equal(response.json.data.messagesIndexed, 0);
});

test("fts rebuild fails closed when truncate fails and does not continue to backfill", async () => {
  ensureFtsTables();
  insertMessage({ namespace: "eva", content: "正常消息" });
  insertMemory({ content: "正常记忆", namespace: "eva" });
  await post("/v1/fts-reindex", { namespace: "eva" });
  assert.equal((sqlite.prepare("SELECT COUNT(*) AS n FROM message_fts").get() as { n: number }).n, 1);
  sqlite.exec("DROP TABLE memory_fts");

  const response = await callEndpoint("/v1/fts-reindex", { namespace: "eva", rebuild: true }, "owner-key");
  assert.equal(response.status, 500);
  assert.equal(response.json.ok, false);
  assert.match(response.json.data.fatal, /truncate_failed/);
  assert.equal(response.json.data.converged, false);
  // 清空已发生但绝不继续伪装成功：没有重建任何行。
  assert.equal(response.json.data.messagesIndexed, 0);
  assert.equal(response.json.data.memoriesIndexed, 0);
  assert.equal((sqlite.prepare("SELECT COUNT(*) AS n FROM message_fts").get() as { n: number }).n, 0,
    "message rows stay truncated: no fake backfill after a failed truncate");
  // 业务表原样。
  assert.equal((sqlite.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number }).n, 1);
  assert.equal((sqlite.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n, 1);
});

test("fts limit is a total cap shared across messages and memories, not one each", async () => {
  ensureFtsTables();
  for (let i = 0; i < 3; i += 1) insertMessage({ namespace: "cap", content: `上限消息 ${i}` });
  for (let i = 0; i < 3; i += 1) insertMemory({ namespace: "cap", content: `上限记忆 ${i}` });

  const first = await post("/v1/fts-reindex", { namespace: "cap", limit: 2 });
  assert.equal(first.data.messagesIndexed, 2);
  assert.equal(first.data.memoriesIndexed, 0, "messages consumed the whole shared cap");
  assert.equal(first.data.processed, 2);
  assert.equal(first.data.converged, false);

  const second = await post("/v1/fts-reindex", { namespace: "cap", limit: 2 });
  assert.equal(second.data.messagesIndexed, 1, "one message left");
  assert.equal(second.data.memoriesIndexed, 1, "the remaining cap goes to memories");
  assert.equal(second.data.processed, 2);
  assert.equal(second.data.converged, false);

  const third = await post("/v1/fts-reindex", { namespace: "cap", limit: 2 });
  assert.equal(third.data.messagesIndexed, 0);
  assert.equal(third.data.memoriesIndexed, 2, "messages drained, memories now get the full cap");
  assert.equal(third.data.processed, 2);
  assert.equal(third.data.converged, false);

  const fourth = await post("/v1/fts-reindex", { namespace: "cap", limit: 2 });
  assert.equal(fourth.data.processed, 0);
  assert.equal(fourth.data.converged, true);
});

test("fts limit clamps to the conservative hard cap and reports requested/effective limits", async () => {
  ensureFtsTables();
  for (let i = 0; i < 3; i += 1) insertMessage({ namespace: "cap2", content: `硬上限消息 ${i}` });

  const response = await post("/v1/fts-reindex", { namespace: "cap2", limit: 500 });
  assert.equal(response.data.requested_limit, 500);
  assert.equal(response.data.effective_limit, 100, "requests beyond the hard cap are clamped, not honored");
  assert.equal(response.data.messagesIndexed, 3);
  assert.equal(response.data.processed, 3);

  const omitted = await post("/v1/fts-reindex", { namespace: "cap2" });
  assert.equal(omitted.data.requested_limit, 100, "the default limit is the hard cap itself");
  assert.equal(omitted.data.effective_limit, 100);
  assert.equal(omitted.data.converged, true);
});

test("fts orphan purge is scoped to the request namespace and leaves other namespaces alone", async () => {
  ensureFtsTables();
  const evaMessage = insertMessage({ namespace: "eva", content: "eva消息正文" });
  const defaultMessage = insertMessage({ namespace: "default", content: "default消息正文" });
  // eva 的有效行 + 两个空间的 orphan 行（引用不存在的 id）。
  sqlite.prepare("INSERT INTO message_fts (fts_body, namespace, message_id) VALUES ('正文', 'eva', ?)").run(evaMessage.id);
  sqlite.prepare("INSERT INTO message_fts (fts_body, namespace, message_id) VALUES ('幽灵', 'eva', 'msg_ghost_eva')").run();
  sqlite.prepare("INSERT INTO memory_fts (fts_body, namespace, memory_id) VALUES ('幽灵', 'eva', 'mem_ghost_eva')").run();
  sqlite.prepare("INSERT INTO message_fts (fts_body, namespace, message_id) VALUES ('幽灵', 'default', 'msg_ghost_default')").run();
  const businessSnapshot = JSON.stringify(sqlite.prepare("SELECT * FROM memories ORDER BY id").all())
    + JSON.stringify(sqlite.prepare("SELECT * FROM messages ORDER BY id").all());
  const countFts = (table: string, id: string) =>
    (sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${table === "message_fts" ? "message_id" : "memory_id"} = ?`).get(id) as { n: number }).n;

  const defaultRun = await post("/v1/fts-reindex", { namespace: "default" });
  assert.equal(defaultRun.ok, true);
  assert.equal(defaultRun.data.messagesIndexed, 1);
  assert.equal(defaultRun.data.messageOrphansPurged, 1, "the default-space orphan is purged");
  assert.equal(defaultRun.data.memoryOrphansPurged, 0);
  assert.equal(countFts("message_fts", "msg_ghost_default"), 0);
  assert.equal(countFts("message_fts", "msg_ghost_eva"), 1, "eva orphans survive a default-space backfill");
  assert.equal(countFts("memory_fts", "mem_ghost_eva"), 1);
  assert.equal(countFts("message_fts", evaMessage.id), 1, "eva's valid row is untouched");
  assert.equal(defaultRun.data.messagesUnindexable, 0);

  const evaRun = await post("/v1/fts-reindex", { namespace: "eva" });
  assert.equal(evaRun.ok, true);
  assert.equal(evaRun.data.messagesIndexed, 0, "eva's valid row already exists: nothing re-indexed");
  assert.equal(evaRun.data.messageOrphansPurged, 1, "now the eva-space orphan is purged");
  assert.equal(evaRun.data.memoryOrphansPurged, 1);
  assert.equal(countFts("message_fts", "msg_ghost_eva"), 0);
  assert.equal(countFts("memory_fts", "mem_ghost_eva"), 0);
  assert.equal(countFts("message_fts", defaultMessage.id), 1, "default's freshly indexed row survives the eva purge");
  assert.equal(
    JSON.stringify(sqlite.prepare("SELECT * FROM memories ORDER BY id").all())
      + JSON.stringify(sqlite.prepare("SELECT * FROM messages ORDER BY id").all()),
    businessSnapshot
  );
});

test("fts orphan purge failure fails closed instead of reporting success", async () => {
  ensureFtsTables();
  insertMessage({ namespace: "eva", content: "唯一消息" });
  sqlite.exec("DROP TABLE memory_fts");

  // limit=1：messages 用掉全部额度 → memories 的 SELECT 被跳过 → 阶段性到达 purge，
  // purge 的 memory DELETE 抛错 → 顶层 fatal，不得 converged。
  const response = await callEndpoint("/v1/fts-reindex", { namespace: "eva", limit: 1 }, "owner-key");
  assert.equal(response.status, 500);
  assert.equal(response.json.ok, false);
  assert.match(response.json.data.fatal, /orphan_purge_failed/);
  assert.equal(response.json.data.converged, false);
  assert.equal(response.json.data.messagesIndexed, 1, "the work that did happen is still reported");
  assert.equal(response.json.data.effective_limit, 1);
  assert.equal(
    (sqlite.prepare("SELECT COUNT(*) AS n FROM message_fts").get() as { n: number }).n, 1,
    "the successfully indexed row is not rolled back by the fatal"
  );
});

test("fts rebuild clears stale pre-migration rows that backfill alone cannot reach", async () => {
  ensureFtsTables();
  const memory = insertMemory({ content: "重建来源记忆", namespace: "eva" });
  const message = insertMessage({ namespace: "eva", content: "重建来源消息" });
  // 迁移前残留：旧 namespace 的 FTS 行。backfill 只补缺失，不会重写它。
  sqlite.prepare("INSERT INTO memory_fts (fts_body, namespace, memory_id) VALUES ('旧正文', 'id:12345', ?)").run(memory.id);
  sqlite.prepare("INSERT INTO message_fts (fts_body, namespace, message_id) VALUES ('旧消息', 'name:eva-old', ?)").run(message.id);

  const backfillOnly = await post("/v1/fts-reindex", { namespace: "eva" });
  assert.equal(backfillOnly.data.memoriesIndexed, 0, "stale rows mask the owners from plain backfill");
  assert.equal(backfillOnly.data.converged, true,
    "this false-looking convergence is exactly why the runbook mandates one rebuild after P8");
  let row = sqlite.prepare("SELECT namespace FROM memory_fts WHERE memory_id = ?").get(memory.id) as { namespace: string };
  assert.equal(row.namespace, "id:12345");

  // 迁移后首个 rebuild 必做且显式指定 namespace：清本 namespace 行 + 归属在本 namespace、
  // fts 行仍停在旧 namespace 的残留，再从 D1 重建。
  const rebuilt = await post("/v1/fts-reindex", { namespace: "eva", rebuild: true });
  assert.equal(rebuilt.data.rebuild, true);
  assert.equal(rebuilt.data.memoriesIndexed, 1);
  assert.equal(rebuilt.data.messagesIndexed, 1);
  row = sqlite.prepare("SELECT namespace FROM memory_fts WHERE memory_id = ?").get(memory.id) as { namespace: string };
  assert.equal(row.namespace, "eva", "rebuild reindexes the memory under its current D1 namespace");
  const msgRow = sqlite.prepare("SELECT namespace FROM message_fts WHERE message_id = ?").get(message.id) as { namespace: string };
  assert.equal(msgRow.namespace, "eva");

  const again = await post("/v1/fts-reindex", { namespace: "eva" });
  assert.equal(again.data.converged, true);
  const memoriesNow = sqlite.prepare("SELECT * FROM memories ORDER BY id").all();
  assert.equal((memoriesNow as any[]).length, 1);
  assert.equal((memoriesNow[0] as any).content, "重建来源记忆");
});
import { strict as assert } from "node:assert";
import { test, beforeEach } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { createVectorMemory, updateVectorMemory } from "../src/memory/vectorStore";
import { createEmbedding, effectiveEmbeddingModel, upsertMemoryEmbedding } from "../src/memory/embedding";
import { upsertTriggerVectors, queryTriggerVectors } from "../src/memory/triggers/store";
import { upsertLongtailEmbedding } from "../src/db/v2/longtail";
import type { MemoryRecord } from "../src/types";

// embedding_model marker 专项验收：主记忆向量（memo-kb，kind="memory"）的全部创建/更新
// 写入路径都带当前生效模型名（effectiveEmbeddingModel 唯一默认值出处），
// updateVectorMemory 只有在"正文未变且旧向量 marker 与当前模型一致"时才复用 values。
// 另钉 Workers AI 请求体契约：embeddinggemma-2 的 schema required 是 input（旧字段
// text 会被校验拒绝），旧 embedding 系（bge-m3/300m）仍是 text——payload 按模型族分发。
// trigger / longtail 向量（同索引不同 kind）同规则：写入带 marker、查询按 marker 过滤
// （旧模型向量自然失配；longtail 失配后由 recall 的 LIKE 占位兜底；不做 backfill）。
// 环境与 vector-backfill.test.ts 同构：真实迁移 + node:sqlite、内存 Vectorize double、
// Workers AI embedding double（values 内嵌调用序号，复用/重 embed 可区分）。
(crypto.subtle as any).timingSafeEqual = (a: Uint8Array, b: Uint8Array) => timingSafeEqual(a, b);

// 生产当前生效模型（wrangler.toml EMBEDDING_MODEL 已切 embeddinggemma-2）。
const CURRENT_MODEL = "workers-ai/@cf/google/embeddinggemma-2";
const LEGACY_MODEL = "workers-ai/@cf/baai/bge-m3";

let sqlite: DatabaseSync;
let env: any;
let vectors: Map<string, { id: string; values: number[]; metadata: Record<string, unknown> }>;
let embedCalls: number;
let lastPayload: Record<string, unknown> | null;
let lastQueryOptions: Record<string, unknown> | null;

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
  }, async batch(statements: any[]) {
    sqlite.exec("BEGIN");
    try { const results = []; for (const statement of statements) results.push(await statement.run()); sqlite.exec("COMMIT"); return results; }
    catch (e) { sqlite.exec("ROLLBACK"); throw e; }
  } };
  vectors = new Map(); embedCalls = 0; lastPayload = null; lastQueryOptions = null;
  env = {
    DB: db, EMBEDDING_MODEL: CURRENT_MODEL,
    AI: { async run(_model: string, data: any) {
      embedCalls += 1;
      lastPayload = data;
      return { data: [[0.1, 0.2, embedCalls]] };
    } },
    VECTORIZE: {
      async getByIds(ids: string[]) {
        return ids.flatMap((id) => vectors.has(id) ? [vectors.get(id)] : []);
      },
      // query double：按 namespace + filter 各键匹配，但**有意忽略 embedding_model 键**
      // （模拟 Vectorize 过滤器不生效的最坏情况，逼出查询侧的 marker 双保险）；
      // 无 filter 的查询（记忆召回的 legacy 兜底路）一律返回空。
      async upsert(items: any[]) { for (const item of items) vectors.set(item.id, item); return { mutationId: "m" }; },
      async query(_vector: number[], options: any) {
        lastQueryOptions = options;
        if (!options?.filter) return { matches: [] };
        const ns = options.namespace as string;
        const matches = [...vectors.values()]
          .filter((v) => v.metadata.namespace === ns)
          .filter((v) => Object.entries(options.filter as Record<string, unknown>)
            .every(([k, val]) => k === "embedding_model" || v.metadata[k] === val))
          .map((v) => ({ id: v.id, score: 0.9, metadata: v.metadata }));
        return { matches };
      }
    }
  };
});

let seq = 0;
function insertMemory(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  seq += 1;
  const id = overrides.id ?? `mem_${String(seq).padStart(32, "0")}`;
  const row = {
    id, namespace: "sol", type: "note", content: `记忆 ${seq}`, summary: null, importance: 0.5,
    confidence: 0.8, emotional: 0, recurrence: 0, unresolved: 0, weight: 0.175,
    status: "active", pinned: 0, tags: "[]", source: "review", source_message_ids: "[]",
    vector_id: `mem_${id}`, created_at: "2026-11-25T00:00:00Z",
    updated_at: "2026-11-25T00:00:00Z", expires_at: null, ...overrides
  };
  sqlite.prepare(
    `INSERT INTO memories (id, namespace, type, content, summary, importance, confidence, emotional,
       recurrence, unresolved, weight, status, pinned, tags, source, source_message_ids, vector_id,
       created_at, updated_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(row.id, row.namespace, row.type, row.content, row.summary, row.importance, row.confidence,
    row.emotional, row.recurrence, row.unresolved, row.weight, row.status, row.pinned, row.tags,
    row.source, row.source_message_ids, row.vector_id, row.created_at, row.updated_at, row.expires_at);
  return sqlite.prepare("SELECT * FROM memories WHERE id = ?").get(row.id) as unknown as MemoryRecord;
}

const storedMetadata = (vectorId: string) => (vectors.get(vectorId) as { metadata: Record<string, unknown> }).metadata;
const storedValues = (vectorId: string) => (vectors.get(vectorId) as { values: number[] }).values;

test("effectiveEmbeddingModel: env 未配置回落默认，配置后取 env 值（唯一默认值出处）", () => {
  assert.equal(effectiveEmbeddingModel({} as any), LEGACY_MODEL);
  assert.equal(effectiveEmbeddingModel({ EMBEDDING_MODEL: CURRENT_MODEL } as any), CURRENT_MODEL);
});

test("createVectorMemory 给新向量的 metadata 写当前生效模型 marker", async () => {
  const created = await createVectorMemory(env, { namespace: "sol", content: "新记忆" });
  assert.equal(storedMetadata(created.vector_id as string).embedding_model, CURRENT_MODEL);
});

test("upsertMemoryEmbedding 给 v2 同步 / REST / P9 repair 共用写入路径的 metadata 写 marker", async () => {
  const memory = insertMemory({ content: "REST/v2/backfill 共用写入" });
  assert.equal(await upsertMemoryEmbedding(env, memory), true);
  assert.equal(storedMetadata(`mem_${memory.id}`).embedding_model, CURRENT_MODEL);
});

test("updateVectorMemory：正文未变且 marker 一致时复用旧 values，不重新 embedding", async () => {
  const created = await createVectorMemory(env, { namespace: "sol", content: "v1" });
  const valuesBefore = [...storedValues(created.vector_id as string)];
  embedCalls = 0;

  const updated = await updateVectorMemory(env, created.id, { importance: 0.9 });
  assert.ok(updated);
  assert.equal(embedCalls, 0, "metadata-only patch with a matching marker reuses the existing values");
  assert.deepEqual(storedValues(created.vector_id as string), valuesBefore);
  assert.equal(storedMetadata(created.vector_id as string).embedding_model, CURRENT_MODEL);
});

test("updateVectorMemory：正文未变但 marker 缺失时重新 embedding，不复用旧 values", async () => {
  const created = await createVectorMemory(env, { namespace: "sol", content: "v1" });
  const valuesBefore = [...storedValues(created.vector_id as string)];
  delete storedMetadata(created.vector_id as string).embedding_model;
  const embedsBefore = embedCalls;

  const updated = await updateVectorMemory(env, created.id, { importance: 0.9 });
  assert.ok(updated);
  assert.equal(embedCalls, embedsBefore + 1, "missing marker forces a fresh embedding despite unchanged content");
  assert.notDeepEqual(storedValues(created.vector_id as string), valuesBefore);
  assert.equal(storedMetadata(created.vector_id as string).embedding_model, CURRENT_MODEL,
    "rewritten metadata records the current model");
});

test("updateVectorMemory：正文未变但 marker 是其他模型时重新 embedding，并改写为当前模型", async () => {
  const created = await createVectorMemory(env, { namespace: "sol", content: "v1" });
  const valuesBefore = [...storedValues(created.vector_id as string)];
  storedMetadata(created.vector_id as string).embedding_model = LEGACY_MODEL;
  const embedsBefore = embedCalls;

  const updated = await updateVectorMemory(env, created.id, { pinned: true });
  assert.ok(updated);
  assert.equal(embedCalls, embedsBefore + 1, "a foreign-model marker must not be relabeled by value reuse");
  assert.notDeepEqual(storedValues(created.vector_id as string), valuesBefore);
  assert.equal(storedMetadata(created.vector_id as string).embedding_model, CURRENT_MODEL);
});

test("updateVectorMemory：正文变化时即使 marker 一致也照常重新 embedding", async () => {
  const created = await createVectorMemory(env, { namespace: "sol", content: "v1" });
  embedCalls = 0;

  const updated = await updateVectorMemory(env, created.id, { content: "v2" });
  assert.ok(updated);
  assert.equal(embedCalls, 1);
  assert.equal(storedMetadata(created.vector_id as string).embedding_model, CURRENT_MODEL);
});

test("createEmbedding 按模型族分发请求体：embeddinggemma-2 用 input 字段（官方 schema 契约）", async () => {
  const vector = await createEmbedding(env, "要嵌入的文本");
  assert.ok(vector);
  assert.deepEqual(lastPayload, { input: ["要嵌入的文本"] },
    "embeddinggemma-2 的 schema required 是 input；发旧字段 text 会被校验拒绝，写入/召回/P9 repair 全链路失败");
});

test("createEmbedding 兼容 embeddinggemma-2 的 REST 输出形状 data[0].embedding", async () => {
  env.AI = { async run() {
    return { object: "list", data: [{ object: "embedding", index: 0, embedding: [0.9] }] };
  } };
  const vector = await createEmbedding(env, "文本");
  assert.deepEqual(vector, [0.9]);
});

test("createEmbedding 旧模型族（bge-m3 缺省 / embeddinggemma-300m）继续用 text 字段", async () => {
  await createEmbedding({ ...env, EMBEDDING_MODEL: undefined }, "缺省模型文本");
  assert.deepEqual(lastPayload, { text: ["缺省模型文本"] }, "bge-m3 缺省回落走旧 text 契约");

  await createEmbedding({ ...env, EMBEDDING_MODEL: "workers-ai/@cf/google/embeddinggemma-300m" }, "300m 文本");
  assert.deepEqual(lastPayload, { text: ["300m 文本"] }, "300m 的 schema 仍是 required text");
});

test("upsertTriggerVectors 给三视图触发器向量写当前模型 marker", async () => {
  const count = await upsertTriggerVectors(env, {
    namespace: "sol", memoryId: "mem_trg", vectorId: "trg_t1",
    concept: "海鲜不耐受", bridge: "虾属于海鲜", confidence: 0.9
  });

  assert.equal(count, 3, "concept / bridge / joint 三视图各一个向量");
  for (const suffix of ["#c", "#b", "#j"]) {
    const vector = vectors.get(`trg_t1${suffix}`) as { metadata: Record<string, unknown> } | undefined;
    assert.ok(vector, `view vector ${suffix} exists`);
    assert.equal(vector.metadata.embedding_model, CURRENT_MODEL);
  }
});

test("queryTriggerVectors 只接受 marker 等于当前模型的触发器向量", async () => {
  // 新写入（带当前模型 marker）：bridge 留空 → concept + joint 两个视图。
  await upsertTriggerVectors(env, {
    namespace: "sol", memoryId: "mem_new", vectorId: "trg_new",
    concept: "新概念", bridge: "", confidence: 0.9
  });
  // 旧形状 planted 向量：一个缺 marker（模型标记机制前的旧向量），一个停在旧模型。
  const plant = (key: string, marker: string | null) => {
    vectors.set(`${key}#c`, {
      id: `${key}#c`, values: [0.1],
      metadata: {
        namespace: "trg:sol", kind: "trigger", view: "concept", trigger_key: key,
        memory_ns: "sol", ref_id: "mem_old", concept: "旧概念", confidence: 0.9,
        ...(marker ? { embedding_model: marker } : {})
      }
    });
  };
  plant("trg_old", null);
  plant("trg_foreign", "workers-ai/@cf/google/embeddinggemma-300m");

  const hits = await queryTriggerVectors(env, { namespace: "sol", queryVector: [0.1], topK: 5 });

  assert.equal(hits.length, 1, "缺 marker 与他模型的触发器都被挡在候选池外");
  assert.equal(hits[0].trigger_key, "trg_new");
  assert.equal(
    (lastQueryOptions?.filter as Record<string, unknown>).embedding_model,
    CURRENT_MODEL,
    "Vectorize filter 同步带上当前模型 marker"
  );
});

test("upsertLongtailEmbedding 给 longtail 向量写当前模型 marker", async () => {
  await upsertLongtailEmbedding(env, { id: "lt_row", namespace: "sol", content: "长尾内容" });

  const vector = vectors.get("lt_lt_row") as { metadata: Record<string, unknown> } | undefined;
  assert.ok(vector);
  assert.equal(vector.metadata.embedding_model, CURRENT_MODEL);
});

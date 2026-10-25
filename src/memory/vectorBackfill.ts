// 向量补齐 (vector backfill)：从 D1 这一侧出发，找出"有记忆没向量"的 active 记忆并补上。
//
// 背景：vector_reindex 和 vector_doctor 都从 Vectorize 那一侧枚举 (listVectorIdsViaApi)，
// 只能发现"有向量没记忆"，发现不了反方向。直接写 D1 的记忆 (手工 SQL、迁移、
// embedding 当时失败被 syncMemoryVector 吞掉的错误) 会在 D1 和 FTS 里齐全，
// 但 Vectorize 里没有向量，语义召回永远召不到，关键词召回又照常，所以没人会发现。
//
// 做法：
//   1. D1 列出 namespace 下全部 active 记忆 (id / vector_id / 参与 embedding 的字段)。
//   2. 按 vector_id 分批 getByIds (≤20，平台硬上限) 问 Vectorize 有没有。
//      不走 listVectorIdsViaApi，所以只要 VECTORIZE binding，不要 CF API token。
//   3. 分类：
//        ok       —— 向量在，metadata 跟 D1 对得上。
//        missing  —— 向量不在。
//        stale    —— 向量在，但 namespace / content / type / tags / status 跟 D1 不一致
//                    (更新时 embedding 失败留下的旧向量，召回会拿到旧内容；
//                     P8 迁移把 D1 namespace 从旧 role_scope 改写成新值后，
//                     旧向量的 metadata.namespace 还停在迁移前——按 namespaced query
//                     永远召不到，必须跟其它 stale 一样重写)。
//        no_vector_id —— D1 行没有 vector_id，只报告不修 (修要写 D1，这里不碰本体)。
//   4. dry_run=false 时对 missing + stale 调 upsertMemoryEmbedding，跟正常写入路径同一个函数，
//      向量 id 和 metadata 形状不会漂移。每次最多修 limit 条，剩下的在 remaining 里报出来。
//      修复尝试数同时受子请求预算约束：扫描 (D1 列表 + getByIds 批) 与修复 (每次 2 个子请求)
//      计入同一份保守预算，预算只封顶不追吞吐；预算/limit 之外的目标留在 remaining，
//      调用方逐 namespace、逐批次重复运行收敛（P9-DS：无轮转调度器、无持久游标、无队列）。
//      队头持续失败的目标会把后续项堵在批次外——调用方用 skip 游标跳过它们给后续项机会，
//      失败项仍在 failed/remaining 里明确上报，不会消失。
//
// getByIds 某一批失败时，这一批既不算 ok 也不算 missing (记进 unchecked)，
// 避免一次 Vectorize 抖动就把整库重新 embed 一遍。
// Vectorize 写入是异步生效的，刚补完立刻再查可能还显示 missing，重复 upsert 是幂等的，无害。

import type { Env, MemoryRecord } from "../types";
import { upsertMemoryEmbedding } from "./embedding";

// Vectorize getByIds platform hard cap (code 40007) — do not raise.
const GETBYIDS_BATCH = 20;
const SAMPLE_CAP = 50;
const DEFAULT_REPAIR_LIMIT = 20;
const MAX_REPAIR_LIMIT = 200;
const MAX_SCAN = 5000;
// 扫描按 MAX_SCAN + 1 条探测（P9-DS 二轮精确边界）：恰好 5000 条时全部扫完、
// 不误判 truncated；拉到 5001 条才说明超界，触发 scan_truncated blocker。
const MAX_SCAN_PROBE = MAX_SCAN + 1;
// 单次运行的保守子请求预算（P9-DS）：Workers 每请求 1000 子请求上限，
// 留 100 给鉴权/设置/响应等固定开销。扫描（1 次 D1 列表 + 每 20 条一个 getByIds）
// 与修复（每次 = 1 embedding + 1 upsert = 2）计入**同一份**预算，不是只算修复；
// 预算只封顶不追吞吐，修不完的留在 remaining，调用方重复运行收敛。
const DEFAULT_SUBREQUEST_BUDGET = 900;

export type VectorBackfillClass = "ok" | "missing" | "stale" | "no_vector_id";

export interface VectorBackfillSample {
  id: string;
  vector_id: string | null;
  type: string;
  content_preview: string;
  reason?: string;
}

export interface VectorBackfillRepairFailure {
  id: string;
  error: string;
}

export interface VectorBackfillRepairResult {
  attempted: number;
  repaired: number;
  failed_count: number;
  failed: VectorBackfillRepairFailure[];
  remaining: number;
}

export interface VectorBackfillReport {
  namespace: string;
  scanned_at: string;
  dry_run: boolean;
  limit: number;
  skip: number;
  active_memories: number;
  // 扫描触顶（active 行数 > MAX_SCAN；恰好 MAX_SCAN 条不触发误报）：只审计/修复了
  // 前 MAX_SCAN 条，后面的状态未知——converged 必须为 false，由调用方作为 blocker 上报。
  scan_truncated: boolean;
  unchecked: number;
  counts: Record<VectorBackfillClass, number>;
  samples: Record<Exclude<VectorBackfillClass, "ok">, VectorBackfillSample[]>;
  repair?: VectorBackfillRepairResult;
  subrequests: { scan: number; repair: number };
  errors: string[];
}

export interface VectorBackfillInput {
  namespace: string;
  dryRun?: boolean;
  limit?: number;
  /** 修复游标（P9-DS）：跳过 targets 前 skip 条再开始修。失败项会钉在队头时，调用方推进 skip 给后续项机会；被跳过的失败项仍在 remaining 里明确上报，不消失。 */
  skip?: number;
  /** 本次运行（扫描+修复）的保守子请求预算；默认 900。 */
  subrequestBudget?: number;
}

function clampLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_REPAIR_LIMIT;
  return Math.min(Math.max(Math.floor(value as number), 1), MAX_REPAIR_LIMIT);
}

function readMetaString(metadata: Record<string, unknown>, field: string): string | null {
  const value = metadata[field];
  return typeof value === "string" ? value : null;
}

// 参与 embedding 文本 (type + tags + content)、召回过滤 (status) 与归属 (namespace) 的
// 字段才比；importance / updated_at 之类漂了不影响召回，不值得为它重新 embed。
// namespace 是 P8 迁移漂移的核心字段：D1 是唯一真源，metadata 停在旧值 = 召回隐身。
// tags 两边都是 JSON 字符串，解析后再比，免得空格/空值写法不同被误判。
// status 缺省按 active，跟 vectorMetadataToMemoryRecord 的召回口径一致。
// namespace 不做缺省兜底：旧路径没写过 namespace 的 v1 向量本就召回隐身，应判 stale。
function normalizeTags(raw: string | null): string {
  try {
    const parsed = JSON.parse(raw || "[]") as unknown;
    return JSON.stringify(Array.isArray(parsed) ? parsed : []);
  } catch {
    return raw ?? "";
  }
}

function staleReason(memory: MemoryRecord, metadata: Record<string, unknown>): string | null {
  if (readMetaString(metadata, "namespace") !== memory.namespace) return "namespace";
  if (readMetaString(metadata, "content") !== memory.content) return "content";
  if (readMetaString(metadata, "type") !== memory.type) return "type";
  if (normalizeTags(readMetaString(metadata, "tags")) !== normalizeTags(memory.tags)) return "tags";
  if ((readMetaString(metadata, "status") || "active") !== "active") return "status";
  return null;
}

function toSample(memory: MemoryRecord, reason?: string): VectorBackfillSample {
  return {
    id: memory.id,
    vector_id: memory.vector_id,
    type: memory.type,
    content_preview: memory.content.slice(0, 80),
    ...(reason ? { reason } : {})
  };
}

async function listActiveMemories(db: D1Database, namespace: string): Promise<MemoryRecord[]> {
  const result = await db
    .prepare(
      `SELECT * FROM memories
       WHERE namespace = ? AND status = 'active'
       ORDER BY created_at ASC, id ASC
       LIMIT ?`
    )
    .bind(namespace, MAX_SCAN_PROBE)
    .all<MemoryRecord>();
  return result.results ?? [];
}

export async function runVectorBackfill(env: Env, input: VectorBackfillInput): Promise<VectorBackfillReport> {
  const namespace = input.namespace;
  const dryRun = input.dryRun !== false;
  const limit = clampLimit(input.limit);
  const skip = Math.min(Math.max(Math.floor(input.skip ?? 0), 0), MAX_SCAN);
  const budget = Math.max(0, Math.floor(input.subrequestBudget ?? DEFAULT_SUBREQUEST_BUDGET));
  const errors: string[] = [];
  const counts: Record<VectorBackfillClass, number> = { ok: 0, missing: 0, stale: 0, no_vector_id: 0 };
  const samples: VectorBackfillReport["samples"] = { missing: [], stale: [], no_vector_id: [] };

  const fetched = await listActiveMemories(env.DB, namespace);
  // 恰好 MAX_SCAN 条：全部进入本轮扫描，不判 truncated；超出才是真超界。
  const scanTruncated = fetched.length > MAX_SCAN;
  const memories = scanTruncated ? fetched.slice(0, MAX_SCAN) : fetched;
  const report: VectorBackfillReport = {
    namespace,
    scanned_at: new Date().toISOString(),
    dry_run: dryRun,
    limit,
    skip,
    active_memories: memories.length,
    scan_truncated: scanTruncated,
    unchecked: 0,
    counts,
    samples,
    subrequests: { scan: 1, repair: 0 },
    errors
  };
  if (scanTruncated) errors.push(`scan_truncated_at_${MAX_SCAN}`);

  if (!env.VECTORIZE) {
    errors.push("missing_vectorize_binding");
    report.unchecked = memories.length;
    return report;
  }

  const targets: MemoryRecord[] = [];
  const record = (cls: Exclude<VectorBackfillClass, "ok">, memory: MemoryRecord, reason?: string) => {
    counts[cls] += 1;
    if (samples[cls].length < SAMPLE_CAP) samples[cls].push(toSample(memory, reason));
  };

  const withVectorId: MemoryRecord[] = [];
  for (const memory of memories) {
    if (memory.vector_id) withVectorId.push(memory);
    else record("no_vector_id", memory);
  }

  const missing: MemoryRecord[] = [];
  const stale: MemoryRecord[] = [];
  for (let i = 0; i < withVectorId.length; i += GETBYIDS_BATCH) {
    const batch = withVectorId.slice(i, i + GETBYIDS_BATCH);
    let found: Map<string, Record<string, unknown>>;
    try {
      const vectors = await env.VECTORIZE.getByIds(batch.map((memory) => memory.vector_id as string));
      found = new Map(vectors.map((v) => [v.id, (v.metadata || {}) as Record<string, unknown>]));
    } catch (err) {
      errors.push(`getbyids_failed: ${err instanceof Error ? err.message : String(err)}`);
      report.unchecked += batch.length;
      continue;
    }

    for (const memory of batch) {
      const metadata = found.get(memory.vector_id as string);
      if (!metadata) {
        record("missing", memory);
        missing.push(memory);
        continue;
      }
      const reason = staleReason(memory, metadata);
      if (reason) {
        record("stale", memory, reason);
        stale.push(memory);
      } else {
        counts.ok += 1;
      }
    }
  }
  // 扫描开销已发生且必须计入同一份预算：1 次 D1 列表 + 每 20 条一个 getByIds。
  const scanCost = 1 + Math.ceil(withVectorId.length / GETBYIDS_BATCH);
  report.subrequests.scan = scanCost;
  // 先补完全没有向量的 (召回里彻底隐身)，再补内容过期的。
  targets.push(...missing, ...stale);

  if (dryRun) return report;

  // 修复尝试数 = min(limit, 剩余子请求预算 / 2)。预算耗尽时本轮只完成扫描，
  // 修复项全部留在 remaining，调用方重复运行继续（无轮转、无持久游标）。
  const maxAttempts = Math.max(0, Math.min(limit, Math.floor((budget - scanCost) / 2)));
  const repair: VectorBackfillRepairResult = {
    attempted: 0,
    repaired: 0,
    failed_count: 0,
    failed: [],
    remaining: 0
  };
  const batch = targets.slice(skip, skip + maxAttempts);
  for (const memory of batch) {
    repair.attempted += 1;
    try {
      const ok = await upsertMemoryEmbedding(env, memory);
      if (ok) repair.repaired += 1;
      else repair.failed.push({ id: memory.id, error: "embedding_failed" });
    } catch (err) {
      repair.failed.push({ id: memory.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  repair.failed_count = repair.failed.length;
  // 本次没补上的 (失败的 + 超出 limit/预算的 + 被 skip 跳过的) 都算剩下，
  // 下次再跑还会被找出来；失败项在 failed 里明确上报，不会因为 skip 而消失。
  repair.remaining = targets.length - repair.repaired;
  report.repair = repair;
  report.subrequests.repair = repair.attempted * 2;
  return report;
}

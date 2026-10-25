import { authenticate } from "../auth/apiKey";
import { requireScope } from "../auth/scopes";
import { createEmbedding } from "../memory/embedding";
import {
  createVectorMemory,
  deleteVectorMemory,
  getVectorMemory,
  listVectorMemories,
  searchVectorMemories,
  updateVectorMemory,
  vectorMetadataToMemoryRecord
} from "../memory/vectorStore";
import { runVectorBackfill } from "../memory/vectorBackfill";
import { runVectorDoctor } from "../memory/vectorDoctor";
import { backfillFts, rebuildFts, FTS_BACKFILL_MAX_LIMIT } from "../memory/fts";
import { json, openAiError } from "../utils/json";
import type { Env, KeyProfile, MemoryApiRecord } from "../types";
import {
  readBoolean,
  readJsonObject,
  readNonNegativeInt,
  readPositiveInt,
  readString,
  resolveNamespace
} from "../utils/request";

interface CacheHealthRow {
  created_at: string;
  model: string | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  input_tokens: number | null;
  client_system_hash: string | null;
  cache_anchor_block: string | null;
}

interface ModelAgg {
  model: string;
  requests: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  input_tokens: number;
}

interface HashAgg {
  client_system_hash: string;
  requests: number;
  cache_read_tokens: number;
}

interface CacheHealthSummary {
  total_requests: number;
  cache_creation_total_tokens: number;
  cache_read_total_tokens: number;
  input_total_tokens: number;
  cache_read_ratio: number;
  by_model: ModelAgg[];
  by_client_system_hash: HashAgg[];
  recent: CacheHealthRow[];
}

// All queries filter to Anthropic/Claude traffic only.
const ANTHROPIC_FILTER = "(provider = 'anthropic' OR lower(model) LIKE 'anthropic/%' OR lower(model) LIKE '%claude%')";

function canReadDebug(profile: KeyProfile): boolean {
  return profile.scopes.includes("debug:read") || profile.scopes.includes("memory:write");
}

// 三个旧向量维护入口（doctor / backfill / reindex）的 namespace 鉴权（P9-DS 二轮）：
// 与 P9/FTS 同一套 key profile 规则（复用 resolveNamespace，不新增鉴权机制），但维护
// 工具拒绝得"响"——chooseNamespace=false 的 key 显式请求非绑定 namespace 时直接 403，
// 且发生在任何扫描/写入/删除之前；省略 namespace 落回 profile 绑定空间；
// chooseNamespace=true 的显式跨空间行为保持不变。
function resolveStrictNamespace(
  profile: KeyProfile,
  requested: unknown
): { namespace: string } | { rejected: string } {
  const explicit = readString(requested);
  if (explicit && !profile.chooseNamespace && explicit !== profile.namespace) {
    return { rejected: explicit };
  }
  return { namespace: resolveNamespace(profile, requested) };
}

function embeddingNorm(vector: number[]): number {
  return Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
}

function readEmbeddingModel(env: Env): string {
  return env.EMBEDDING_MODEL?.trim() || "workers-ai/@cf/baai/bge-m3";
}

function readEmbeddingProvider(model: string): string {
  if (model.startsWith("workers-ai/") || model.startsWith("worker/") || model.startsWith("@cf/")) return "workers-ai";
  return "openai-compatible";
}

function compactMatch(match: VectorizeMatch): Record<string, unknown> {
  const record = vectorMetadataToMemoryRecord(match, match.score);
  return {
    id: match.id,
    vector_namespace: match.namespace,
    score: match.score,
    namespace: record?.namespace,
    ref_id: record?.id,
    type: record?.type,
    content_preview: record?.content.slice(0, 120)
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function queryVectorize(
  env: Env,
  vector: number[],
  namespace: string
): Promise<{ namespaced: Record<string, unknown>[]; legacy: Record<string, unknown>[] }> {
  if (!env.VECTORIZE) return { namespaced: [], legacy: [] };

  const namespaced = await env.VECTORIZE.query(vector, {
    topK: 10,
    namespace,
    returnMetadata: "all"
  });
  const legacy = await env.VECTORIZE.query(vector, {
    topK: 10,
    returnMetadata: "all"
  });

  return {
    namespaced: namespaced.matches.map(compactMatch),
    legacy: legacy.matches.map(compactMatch)
  };
}

async function waitForVectorMemory(
  env: Env,
  memory: MemoryApiRecord,
  vector: number[],
  namespace: string
): Promise<{
  visible: boolean;
  attempts: number;
  getByPublicId: MemoryApiRecord | null;
  getByVectorId: MemoryApiRecord | null;
  directQuery: { namespaced: Record<string, unknown>[]; legacy: Record<string, unknown>[] };
  apiSearch: MemoryApiRecord[];
}> {
  let getByPublicId: MemoryApiRecord | null = null;
  let getByVectorId: MemoryApiRecord | null = null;
  let directQuery: { namespaced: Record<string, unknown>[]; legacy: Record<string, unknown>[] } = {
    namespaced: [],
    legacy: []
  };
  let apiSearch: MemoryApiRecord[] = [];

  for (let attempt = 1; attempt <= 8; attempt += 1) {
    getByPublicId = await getVectorMemory(env, memory.id);
    getByVectorId = memory.vector_id ? await getVectorMemory(env, memory.vector_id) : null;
    directQuery = await queryVectorize(env, vector, namespace);
    apiSearch = await searchVectorMemories(env, {
      namespace,
      query: memory.content,
      topK: 10
    });

    const visible =
      Boolean(getByPublicId || getByVectorId) ||
      directQuery.namespaced.some((match) => match.id === memory.vector_id || match.ref_id === memory.id) ||
      directQuery.legacy.some((match) => match.id === memory.vector_id || match.ref_id === memory.id) ||
      apiSearch.some((item) => item.id === memory.id || item.vector_id === memory.vector_id);

    if (visible || attempt === 8) {
      return { visible, attempts: attempt, getByPublicId, getByVectorId, directQuery, apiSearch };
    }

    await delay(2500);
  }

  return { visible: false, attempts: 8, getByPublicId, getByVectorId, directQuery, apiSearch };
}

export async function handleVectorHealth(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth.ok) return openAiError("Unauthorized", 401, "authentication_error");
  if (!canReadDebug(auth.profile)) return openAiError("Missing required scope: debug:read", 403);

  const url = new URL(request.url);
  const namespace = url.searchParams.get("namespace")?.trim() || auth.profile.namespace;
  const phrase =
    url.searchParams.get("phrase")?.trim() ||
    `vector-health-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const model = readEmbeddingModel(env);
  const result: Record<string, unknown> = {
    ok: false,
    namespace,
    phrase,
    config: {
      embedding_model: model,
      embedding_provider: readEmbeddingProvider(model),
      embedding_dimensions_config: env.EMBEDDING_DIMENSIONS || null,
      vectorize_index_name: env.VECTORIZE_INDEX_NAME || "memo-kb",
      has_ai_binding: Boolean(env.AI),
      has_vectorize_binding: Boolean(env.VECTORIZE),
      has_cloudflare_api_config: Boolean(env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN)
    },
    checks: {}
  };

  let created: MemoryApiRecord | null = null;

  try {
    const vector = await createEmbedding(env, phrase);
    if (!vector) {
      result.checks = { embedding: { ok: false, error: "embedding_returned_null" } };
      return json(result, { status: 503 });
    }

    const checks: Record<string, unknown> = {
      embedding: {
        ok: true,
        dimensions: vector.length,
        norm: Number(embeddingNorm(vector).toFixed(6)),
        sample: vector.slice(0, 6)
      }
    };

    if (!env.VECTORIZE) {
      result.checks = { ...checks, vectorize: { ok: false, error: "missing_vectorize_binding" } };
      return json(result, { status: 503 });
    }

    const beforeQuery = await queryVectorize(env, vector, namespace);
    checks.before_query = beforeQuery;

    created = await createVectorMemory(env, {
      namespace,
      type: "debug",
      content: phrase,
      importance: 0.1,
      confidence: 1,
      tags: ["vector-health"],
      source: "debug"
    });
    checks.create = {
      ok: true,
      id: created.id,
      vector_id: created.vector_id
    };

    const visibility = await waitForVectorMemory(env, created, vector, namespace);
    checks.get = {
      attempts: visibility.attempts,
      by_id: Boolean(visibility.getByPublicId),
      by_vector_id: Boolean(visibility.getByVectorId),
      by_id_vector_id: visibility.getByPublicId?.vector_id || null,
      by_vector_id_vector_id: visibility.getByVectorId?.vector_id || null
    };

    checks.after_query = visibility.directQuery;
    checks.api_search = {
      count: visibility.apiSearch.length,
      hits: visibility.apiSearch.map((memory) => ({
        id: memory.id,
        vector_id: memory.vector_id,
        score: memory.score,
        type: memory.type,
        content_preview: memory.content.slice(0, 120)
      }))
    };

    checks.result = {
      ok: visibility.visible,
      reason: visibility.visible ? "canary_visible_after_write" : "canary_not_visible_after_write"
    };

    result.ok = visibility.visible;
    result.checks = checks;
    return json(result, { status: visibility.visible ? 200 : 500 });
  } catch (error) {
    result.checks = {
      ...(typeof result.checks === "object" && result.checks ? result.checks : {}),
      error: error instanceof Error ? error.message : String(error)
    };
    return json(result, { status: 500 });
  } finally {
    if (created?.id) {
      try {
        await deleteVectorMemory(env, created.id);
      } catch (error) {
        console.error("vector_health cleanup failed", error);
      }
    }
  }
}

export async function handleVectorReindex(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth.ok) return openAiError("Unauthorized", 401, "authentication_error");
  if (!auth.profile.scopes.includes("memory:write")) {
    return openAiError("Missing required scope: memory:write", 403);
  }

  const body = await readJsonObject(request);
  if (!body) return openAiError("Request body must be a JSON object", 400);

  const namespaceOrReject = resolveStrictNamespace(auth.profile, body.namespace);
  if ("rejected" in namespaceOrReject) {
    return openAiError(
      `Forbidden: this key is bound to namespace '${auth.profile.namespace}' and cannot operate '${namespaceOrReject.rejected}'`,
      403
    );
  }
  const namespace = namespaceOrReject.namespace;
  const limit = readPositiveInt(body.limit, 50, 100);
  const cursor = readString(body.cursor);
  const dryRun = readBoolean(body.dry_run, true);
  const model = readEmbeddingModel(env);

  try {
    const page = await listVectorMemories(env, {
      namespace,
      count: limit,
      cursor
    });
    const rewritten: Array<{ id: string; vector_id: string | null; ok: boolean; error?: string }> = [];

    for (const memory of page.data) {
      if (dryRun) {
        rewritten.push({ id: memory.id, vector_id: memory.vector_id, ok: true });
        continue;
      }

      try {
        const updated = await updateVectorMemory(env, memory.id, {
          type: memory.type,
          content: memory.content,
          summary: memory.summary,
          importance: memory.importance,
          confidence: memory.confidence,
          pinned: memory.pinned,
          tags: memory.tags,
          source: memory.source,
          sourceMessageIds: memory.source_message_ids,
          expiresAt: memory.expires_at
        });
        rewritten.push({
          id: memory.id,
          vector_id: updated?.vector_id || memory.vector_id,
          ok: Boolean(updated)
        });
      } catch (error) {
        rewritten.push({
          id: memory.id,
          vector_id: memory.vector_id,
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    const failed = rewritten.filter((item) => !item.ok);
    return json({
      ok: failed.length === 0,
      data: {
        namespace,
        embedding_model: model,
        dry_run: dryRun,
        requested_limit: limit,
        listed_ids: page.count,
        matched_memories: page.data.length,
        rewritten_count: rewritten.length - failed.length,
        failed_count: failed.length,
        cursor: page.cursor,
        has_more: page.hasMore,
        total_count: page.totalCount,
        rewritten,
        failed
      }
    }, { status: failed.length === 0 ? 200 : 500 });
  } catch (error) {
    return json({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    }, { status: 500 });
  }
}

// 清点 Vectorize/D1 一致性、揪出 v1 残留/孤儿向量，可选一键清掉 (只删 Vectorize，不动 D1)。
// 详见 memory/vectorDoctor.ts 头注释。auth 跟 handleVectorReindex 保持一致
// (要求 memory:write，因为 cleanup=true 会产生真实删除，即便默认是 dry-run 报告)。
// namespace 走 resolveStrictNamespace（P9-DS 二轮）：pinned key 显式请求他空间 → 403，
// 拒绝前零枚举零删除；省略 namespace 用 profile 绑定空间。
export async function handleVectorDoctor(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth.ok) return openAiError("Unauthorized", 401, "authentication_error");
  if (!auth.profile.scopes.includes("memory:write")) {
    return openAiError("Missing required scope: memory:write", 403);
  }

  const body = await readJsonObject(request);
  if (!body) return openAiError("Request body must be a JSON object", 400);

  const namespaceOrReject = resolveStrictNamespace(auth.profile, body.namespace);
  if ("rejected" in namespaceOrReject) {
    return openAiError(
      `Forbidden: this key is bound to namespace '${auth.profile.namespace}' and cannot operate '${namespaceOrReject.rejected}'`,
      403
    );
  }
  const namespace = namespaceOrReject.namespace;
  const limit = readPositiveInt(body.limit, 1000, 5000);
  // Defensive: cleanup only runs on an explicit boolean true, never on
  // truthy strings/numbers — accidental cleanup on prod vectors is the
  // one failure mode this endpoint cannot shrug off.
  const cleanup = body.cleanup === true;

  try {
    const report = await runVectorDoctor(env, { namespace, cleanup, limit });
    return json({ ok: true, data: report });
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

// 反方向的一致性检查：从 D1 的 active 记忆出发，找出 Vectorize 里缺向量 / 向量过期的，
// dry_run=false 时补上 (只写 Vectorize，不动 D1)。详见 memory/vectorBackfill.ts 头注释。
// dry_run 默认 true，auth 跟 handleVectorDoctor 一致；namespace 走 resolveStrictNamespace
// （P9-DS 二轮）：pinned key 显式请求他空间 → 403、零扫描零写入。
export async function handleVectorBackfill(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth.ok) return openAiError("Unauthorized", 401, "authentication_error");
  if (!auth.profile.scopes.includes("memory:write")) {
    return openAiError("Missing required scope: memory:write", 403);
  }

  const body = await readJsonObject(request);
  if (!body) return openAiError("Request body must be a JSON object", 400);

  const namespaceOrReject = resolveStrictNamespace(auth.profile, body.namespace);
  if ("rejected" in namespaceOrReject) {
    return openAiError(
      `Forbidden: this key is bound to namespace '${auth.profile.namespace}' and cannot operate '${namespaceOrReject.rejected}'`,
      403
    );
  }
  const namespace = namespaceOrReject.namespace;
  const limit = readPositiveInt(body.limit, 20, 200);
  const dryRun = readBoolean(body.dry_run, true);

  try {
    const report = await runVectorBackfill(env, { namespace, dryRun, limit });
    const failed = report.repair?.failed_count ?? 0;
    return json({ ok: failed === 0 && report.errors.length === 0, data: report });
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

// P9 · 迁移后索引修复入口（P9-DS 修订）：单次请求只处理**一个** namespace、一个有界批次，
// 返回 pending/converged，调用方逐 namespace、重复执行到收敛（消除多 namespace 共享
// 全局预算时的饥饿；无轮转调度器、无持久游标、无队列）。
//   namespace 走与全部 memory 端点相同的 resolveNamespace 规则：chooseNamespace=false
//   的 key 永远钉在自己的绑定 namespace（请求他 namespace 无效，不会越权）；
//   chooseNamespace=true 的 key 可显式指定；省略 namespace 落回 profile 默认——
//   任何情况下都不会触发全空间扫描/修复。
//   dry_run 默认 true（审计）；dry_run=false 显式修复，批大小 limit（默认 20，上限 200）；
//   队头持续失败堵住批次时，用 skip 游标跳过它们给后续项机会，失败项仍在报告里。
//   扫描与修复计入同一份保守子请求预算（见 vectorBackfill.ts），修不完留 pending。
//   converged = pending 清零且无 unchecked/errors 且未触扫描上限（scan_truncated
//   是 blocker：只看了前 MAX_SCAN 条，不得声称收敛）；no_vector_id 本工具不修
//   （不编造、不写 D1），单独作 blocker 上报，>0 时 ok=false 等人工裁定。
//   输出只含计数与 id 级错误，不含记忆正文；orphan/backed_inactive 清理仍走
//   /v1/vector-doctor 的显式 cleanup。
export async function handleP9Reindex(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth.ok) return openAiError("Unauthorized", 401, "authentication_error");
  if (!auth.profile.scopes.includes("memory:write")) {
    return openAiError("Missing required scope: memory:write", 403);
  }

  const body = await readJsonObject(request);
  if (!body) return openAiError("Request body must be a JSON object", 400);

  const namespace = resolveNamespace(auth.profile, body.namespace);
  const limit = readPositiveInt(body.limit, 20, 200);
  const skip = readNonNegativeInt(body.skip, 0, 5000);
  const dryRun = readBoolean(body.dry_run, true);

  try {
    const report = await runVectorBackfill(env, { namespace, dryRun, limit, skip });
    const pending = report.repair ? report.repair.remaining : report.counts.missing + report.counts.stale;
    const converged =
      pending === 0 && report.unchecked === 0 && report.errors.length === 0 && !report.scan_truncated;
    const blockers = {
      no_vector_id: report.counts.no_vector_id,
      scan_truncated: report.scan_truncated
    };

    return json({
      ok: converged && blockers.no_vector_id === 0,
      data: {
        scanned_at: new Date().toISOString(),
        namespace,
        dry_run: dryRun,
        limit,
        skip,
        active_memories: report.active_memories,
        scan_truncated: report.scan_truncated,
        unchecked: report.unchecked,
        counts: report.counts,
        pending,
        converged,
        blockers,
        errors: report.errors,
        subrequests: report.subrequests,
        ...(report.repair
          ? {
              repair: {
                attempted: report.repair.attempted,
                repaired: report.repair.repaired,
                failed_count: report.repair.failed_count,
                remaining: report.repair.remaining,
                failed: report.repair.failed.slice(0, 10)
              }
            }
          : {})
      }
    });
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

// P9 · FTS 显式重建入口（P9-DS 修订）：单 namespace、可重复执行，只包
// backfillFts / rebuildFts，不另造索引平台。
//   namespace 与 p9-reindex 同规则（resolveNamespace）：chooseNamespace=false 的 key
//   钉在绑定 namespace；省略 namespace 落回 profile 默认，绝不触发全空间重建。
//   rebuild=false（默认）= backfill：只补缺失行，重复运行到 converged。
//   rebuild=true = rebuild：先清空（本 namespace 行 + D1 归属在本 namespace、
//     fts 行还停在旧 namespace 的迁移残留），再从 D1 重建；清空失败直接 fatal、
//     不继续不伪装成功。迁移后首个 rebuild 是必做步骤（见 runbook）。
//   limit 是本次请求的总处理上限（messages+memories 共用），默认/硬上限 100
//   （FTS_BACKFILL_MAX_LIMIT：单行写入最坏 6 个 D1 子请求，100 行仍明显低于
//   Workers 1000 上限）；请求更大的值 clamp 到 100，响应报 requested_limit /
//   effective_limit。每轮顺带清 orphan FTS 行，但**只限当前 namespace**（P9-DS
//   二轮）；purge 删除失败同样进 fatal。
//   ok / converged 只有在确实无 fatal、无失败、无待处理时才为 true：
//   顶层 D1 查询失败、清空失败、orphan purge 删除失败都进 fatal → ok:false/converged:false。
//   unindexable（"..."、纯 emoji 等分词为空）是稳定终态（空标记行），单独统计、
//   不阻止收敛；失败只影响 fts 表本身，业务表全程只读。
export async function handleFtsReindex(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth.ok) return openAiError("Unauthorized", 401, "authentication_error");
  if (!auth.profile.scopes.includes("memory:write")) {
    return openAiError("Missing required scope: memory:write", 403);
  }

  const body = await readJsonObject(request);
  if (!body) return openAiError("Request body must be a JSON object", 400);

  const namespace = resolveNamespace(auth.profile, body.namespace);
  const requestedLimit = readPositiveInt(body.limit, FTS_BACKFILL_MAX_LIMIT, 1000000);
  const limit = Math.min(requestedLimit, FTS_BACKFILL_MAX_LIMIT);
  const rebuild = readBoolean(body.rebuild, false);

  try {
    const result = rebuild
      ? await rebuildFts(env.DB, { namespace, limit })
      : await backfillFts(env.DB, { namespace, limit });
    const processed =
      result.messagesIndexed +
      result.memoriesIndexed +
      result.messagesUnindexable +
      result.memoriesUnindexable +
      result.failed;
    const ok = result.fatal === null && result.failed === 0;
    const converged = ok && processed === 0;
    return json(
      {
        ok,
        data: {
          namespace,
          rebuild,
          requested_limit: requestedLimit,
          effective_limit: limit,
          ...result,
          processed,
          converged
        }
      },
      { status: ok ? 200 : 500 }
    );
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

export async function handleCacheHealth(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth.ok) return openAiError("Unauthorized", 401, "authentication_error");

  const scopeError = requireScope(auth.profile, "debug:read");
  if (scopeError) return scopeError;

  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const summary = await env.DB.prepare(
      `SELECT
         COUNT(*) as total_requests,
         COALESCE(SUM(cache_creation_tokens), 0) as cache_creation_total_tokens,
         COALESCE(SUM(cache_read_tokens), 0) as cache_read_total_tokens,
         COALESCE(SUM(input_tokens), 0) as input_total_tokens
       FROM usage_logs
       WHERE created_at >= ? AND ${ANTHROPIC_FILTER}`
    ).bind(since).first<{
      total_requests: number;
      cache_creation_total_tokens: number;
      cache_read_total_tokens: number;
      input_total_tokens: number;
    }>();

    const totalRequests = summary?.total_requests ?? 0;
    const cacheCreationTotal = summary?.cache_creation_total_tokens ?? 0;
    const cacheReadTotal = summary?.cache_read_total_tokens ?? 0;
    const inputTotal = summary?.input_total_tokens ?? 0;

    const byModel = await env.DB.prepare(
      `SELECT
         model,
         COUNT(*) as requests,
         COALESCE(SUM(cache_creation_tokens), 0) as cache_creation_tokens,
         COALESCE(SUM(cache_read_tokens), 0) as cache_read_tokens,
         COALESCE(SUM(input_tokens), 0) as input_tokens
       FROM usage_logs
       WHERE created_at >= ? AND ${ANTHROPIC_FILTER}
       GROUP BY model
       ORDER BY requests DESC`
    ).bind(since).all<ModelAgg>();

    const byHash = await env.DB.prepare(
      `SELECT
         client_system_hash,
         COUNT(*) as requests,
         COALESCE(SUM(cache_read_tokens), 0) as cache_read_tokens
       FROM usage_logs
       WHERE created_at >= ? AND client_system_hash IS NOT NULL AND ${ANTHROPIC_FILTER}
       GROUP BY client_system_hash
       ORDER BY requests DESC`
    ).bind(since).all<HashAgg>();

    const recent = await env.DB.prepare(
      `SELECT
         created_at, model, cache_read_tokens, cache_creation_tokens,
         input_tokens, client_system_hash, cache_anchor_block
       FROM usage_logs
       WHERE created_at >= ? AND ${ANTHROPIC_FILTER}
       ORDER BY created_at DESC
       LIMIT 10`
    ).bind(since).all<CacheHealthRow>();

    const result: CacheHealthSummary = {
      total_requests: totalRequests,
      cache_creation_total_tokens: cacheCreationTotal,
      cache_read_total_tokens: cacheReadTotal,
      input_total_tokens: inputTotal,
      cache_read_ratio: inputTotal > 0 ? cacheReadTotal / inputTotal : 0,
      by_model: byModel.results ?? [],
      by_client_system_hash: byHash.results ?? [],
      recent: recent.results ?? []
    };

    return json(result);
  } catch (error) {
    console.error("cache_health query failed", error);
    return json({ error: "cache_health_query_failed" }, { status: 500 });
  }
}

import type { Env, MemoryRecord } from "../types";
import { callOpenAICompatEmbeddings } from "../proxy/openaiAdapter";

const DEFAULT_EMBEDDING_MODEL = "workers-ai/@cf/baai/bge-m3";

// 当前实际生效的 embedding 模型名（env 覆盖，缺省/空白回落 DEFAULT）。
// 唯一默认值出处：metadata marker 写入（upsertMemoryEmbedding / toMetadata）、
// P9 审计比对（vectorBackfill.staleReason）、updateVectorMemory 复用判定与
// debug 端点的 config 上报都从这里取值，不得各自维护兜底，否则 marker 会各自漂移。
export function effectiveEmbeddingModel(env: Env): string {
  return env.EMBEDDING_MODEL?.trim() || DEFAULT_EMBEDDING_MODEL;
}

function workersAiModelName(model: string): string | null {
  const normalized = model.trim();
  if (normalized.startsWith("workers-ai/")) return normalized.slice("workers-ai/".length);
  if (normalized.startsWith("worker/")) return normalized.slice("worker/".length);
  if (normalized.startsWith("@cf/")) return normalized;
  return null;
}

function readEmbeddingDimensions(env: Env): number | undefined {
  const raw = env.EMBEDDING_DIMENSIONS;
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}

function readEmbedding(result: unknown): number[] | null {
  if (!result || typeof result !== "object") return null;
  const value = result as {
    data?: unknown;
    embedding?: unknown;
    embeddings?: unknown;
  };

  if (Array.isArray(value.embedding) && typeof value.embedding[0] === "number") {
    return value.embedding as number[];
  }

  if (Array.isArray(value.embeddings) && Array.isArray(value.embeddings[0])) {
    return value.embeddings[0] as number[];
  }

  if (Array.isArray(value.data)) {
    const first = value.data[0] as { embedding?: unknown } | number[] | undefined;
    if (first && typeof first === "object" && !Array.isArray(first) && Array.isArray(first.embedding)) {
      return first.embedding as number[];
    }
    if (Array.isArray(first)) return first as number[];
    if (typeof value.data[0] === "number") return value.data as number[];
  }

  return null;
}

// Workers AI embedding 请求体按模型族分发：embeddinggemma-2 的输入契约是 `input`
// （官方 schema required:["input"]，发旧字段 `text` 会被 schema 校验直接拒绝——
// createEmbedding 吞错返回 null，写入/召回/P9 repair 全部失败）；旧 embedding 系
// （bge-m3 / embeddinggemma-300m）仍是 `text`。新模型族接入时必须同步：
// ①核对模型页 schema-input.json；②改这里；③加 payload 断言测试
// （tests/embedding-model-marker.test.ts）——AI double 按旧形状取字段测不出此断裂。
function workersAiEmbeddingPayload(model: string, text: string): Record<string, unknown> {
  return /embeddinggemma-2/.test(model) ? { input: [text] } : { text: [text] };
}

export async function createEmbedding(env: Env, text: string): Promise<number[] | null> {
  const model = effectiveEmbeddingModel(env);
  const workersAiModel = workersAiModelName(model);
  if (workersAiModel) {
    if (!env.AI) return null;
    try {
      // workersAiModel is parsed at runtime from EMBEDDING_MODEL; keyof AiModels is the narrowest safe cast.
      // embeddinggemma-2 未进已安装 workers-types（仅 300m 收录），payload 形状由运行时
      // 模型族决定（workersAiEmbeddingPayload），这里同样收窄 cast 而不是拓宽类型。
      const result = await env.AI.run(
        workersAiModel as keyof AiModels,
        workersAiEmbeddingPayload(workersAiModel, text) as AiTextEmbeddingsInput
      );
      return readEmbedding(result);
    } catch (error) {
      console.error("memory embedding failed", error);
      return null;
    }
  }

  let response: Response;
  const dimensions = readEmbeddingDimensions(env);
  try {
    response = await callOpenAICompatEmbeddings(env, {
      model,
      input: text,
      ...(dimensions ? { dimensions } : {})
    });
  } catch (error) {
    console.error("memory embedding failed", error);
    return null;
  }

  if (!response.ok) return null;
  return readEmbedding(await response.json());
}

// 隔离不变量：daily_log / weekly_log / monthly_log 永不 embed、永不进检索通道。
// 只有 memories 本体经 upsertMemoryEmbedding 写入 Vectorize。
export async function upsertMemoryEmbedding(env: Env, memory: MemoryRecord): Promise<boolean> {
  if (!env.VECTORIZE || memory.status !== "active") return false;

  const tags = (() => {
    try {
      const parsed = JSON.parse(memory.tags || "[]") as unknown;
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
    } catch {
      return [];
    }
  })();
  const searchable = [memory.type, ...tags, memory.content].filter(Boolean).join("\n");
  const vector = await createEmbedding(env, searchable);
  if (!vector || !memory.vector_id) return false;

  await env.VECTORIZE.upsert([
    {
      id: memory.vector_id,
      namespace: memory.namespace,
      values: vector,
      metadata: {
        namespace: memory.namespace,
        kind: "memory",
        embedding_model: effectiveEmbeddingModel(env),
        ref_id: memory.id,
        type: memory.type,
        content: memory.content,
        summary: memory.summary || "",
        importance: memory.importance,
        confidence: memory.confidence,
        status: memory.status,
        pinned: Boolean(memory.pinned),
        tags: memory.tags || "[]",
        source: memory.source || "",
        source_message_ids: memory.source_message_ids || "[]",
        created_at: memory.created_at,
        updated_at: memory.updated_at,
        expires_at: memory.expires_at || "",
      }
    }
  ]);

  return true;
}

export async function deleteMemoryEmbedding(env: Env, memory: MemoryRecord): Promise<boolean> {
  if (!env.VECTORIZE || !memory.vector_id) return false;
  await env.VECTORIZE.deleteByIds([memory.vector_id]);
  return true;
}

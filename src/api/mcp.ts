import { authenticate } from "../auth/apiKey";
import { getOrCreateConversation } from "../db/conversations";
import { fetchMemoriesByIds, getMemoryById, listMemoriesPage, softDeleteMemory } from "../db/memories";
import { saveIngestMessages } from "../db/messages";
import {
  archiveMemory,
  createPrecious,
  createChangelogEntry,
  createBaselineChangelogEntry,
  fetchMemoryLifecycleRows,
  getDailyLog,
  getDigest,
  getRecentDailyLogs,
  getPreciousById,
  supersedeMemory,
  upsertDailyLog,
  upsertDigest,
  upsertGlossary,
  upsertMemoryByFactKey,
  DIGEST_MAX_CHARS
} from "../db/v2";
import { filterAndCompressMemories } from "../memory/filter";
import { exportMemories } from "../memory/export";
import { buildBootPackage, isV2Enabled, runRecall } from "../memory/v2/recall";
import { toMemoryApiRecord } from "../memory/search";
import {
  createVectorMemory,
  deleteVectorMemory,
  getVectorMemory,
  listVectorMemories,
  searchVectorMemories
} from "../memory/vectorStore";
import { enqueueMemoryMaintenanceIfNeeded } from "../queue/producer";
import type { Env, KeyProfile, Scope } from "../types";
import { json } from "../utils/json";
import { computeRoleScope } from "../utils/role";
import {
  isRecord,
  readBoolean,
  readMessages,
  readNonNegativeInt,
  readNumber,
  isValidRange,
  readPositiveInt,
  readString,
  readStringArray,
  resolveNamespace
} from "../utils/request";

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc?: "2.0";
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
}

interface ToolCallParams {
  name?: unknown;
  arguments?: unknown;
}

function withTokenQuery(request: Request): Request {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  if (!token || request.headers.has("authorization")) return request;

  const headers = new Headers(request.headers);
  headers.set("authorization", `Bearer ${token}`);
  return new Request(request.url, { headers });
}

function hasScope(profile: KeyProfile, scope: Scope): boolean {
  return profile.scopes.includes(scope);
}

function rpcResult(id: JsonRpcId | undefined, result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function rpcError(id: JsonRpcId | undefined, code: number, message: string): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message }
  };
}

function textToolResult(data: unknown): Record<string, unknown> {
  return {
    content: [
      {
        type: "text",
        text: typeof data === "string" ? data : JSON.stringify(data, null, 2)
      }
    ],
    structuredContent: data
  };
}

function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: "text", text: message }],
    isError: true
  };
}

function getTools(): Array<Record<string, unknown>> {
  return [
    {
      name: "memory_search",
      description: "Search the user's long-term memory library.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          top_k: { type: "number", minimum: 1, maximum: 50 },
          types: { type: "array", items: { type: "string" } },
          namespace: { type: "string" },
          role_id: { type: "string" },
          role_name: { type: "string" }
        },
        required: ["query"]
      }
    },
    {
      name: "memory_list",
      description: "List memories from the user's memory library.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", minimum: 1, maximum: 1000 },
          cursor: { type: "string" },
          offset: { type: "number", minimum: 0 },
          include_ids: { type: "boolean" },
          type: { type: "string" },
          status: { type: "string" },
          namespace: { type: "string" }
        }
      }
    },
    {
      name: "memory_export",
      description: "Bulk export memory records as JSON, including content and metadata.",
      inputSchema: {
        type: "object",
        properties: {
          type: { type: "string" },
          format: { type: "string", enum: ["json"] },
          namespace: { type: "string" }
        }
      }
    },
    {
      name: "memory_get",
      description: "Get one memory from the Vectorize memory library by id.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" }
        },
        required: ["id"]
      }
    },
    {
      name: "memory_delete",
      description: "Delete one memory from the Vectorize memory library by id.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" }
        },
        required: ["id"]
      }
    },
    {
      name: "memory_ingest",
      description: "Save chat messages and optionally extract memories from them.",
      inputSchema: {
        type: "object",
        properties: {
          messages: {
            type: "array",
            items: {
              type: "object",
              properties: {
                role: { type: "string" },
                content: {}
              },
              required: ["role", "content"]
            }
          },
          conversation_id: { type: "string" },
          source: { type: "string" },
          auto_extract: { type: "boolean" },
          namespace: { type: "string" }
        },
        required: ["messages"]
      }
    },
    // --- Aelios 记忆库 v2 端点 (母帖 #11 第 2 步) ---
    // 全部走 MEMORY_LIFECYCLE_ENABLED 总闸；关时返回未启用。
    {
      name: "memory_boot",
      description:
        "Cold-start package: current role baseline + recent daily logs (current role only) + top pinned precious + all glossary. " +
        "Output is stable and deterministically ordered so the client can cache it. " +
        "Call once on SessionStart with role_id/role_name to scope baseline and daily_log to the current role.",
      inputSchema: {
        type: "object",
        properties: {
          namespace: { type: "string" },
          role_id: { type: "string" },
          role_name: { type: "string" }
        }
      }
    },
    {
      name: "memory_recall",
      description:
        "Per-turn dynamic recall: glossary literal hits + memories(active) vector + world_fact " +
        "+ longtail fallback. Gate 3 inject-decay on last_injected_at. Gate 2 dedups hits against " +
        "the core layer (digest + precious) so the model isn't re-fed what it already knows this turn. " +
        "Precious is NOT queried here (gate 1: it lives in boot). Call on UserPromptSubmit.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          k: { type: "number", minimum: 1, maximum: 100 },
          min_score: { type: "number", minimum: 0, maximum: 1 },
          types: { type: "array", items: { type: "string" } },
          namespace: { type: "string" },
          role_id: { type: "string" },
          role_name: { type: "string" }
        },
        required: ["query"]
      }
    },
    {
      name: "memory_pin",
      description: "Mark a memory as precious (L3, pinned, exempt from dedup/decay/delete). " +
        "Store with surrounding context so a single line stays interpretable later.",
      inputSchema: {
        type: "object",
        properties: {
          content: { type: "string" },
          context_message_ids: { type: "array", items: { type: "string" } },
          namespace: { type: "string" }
        },
        required: ["content"]
      }
    },
    {
      name: "glossary_set",
      description: "Add or update a glossary term (L5, literal recall, not in vector index). " +
        "Upsert by (namespace, term).",
      inputSchema: {
        type: "object",
        properties: {
          term: { type: "string" },
          aliases: { type: "array", items: { type: "string" } },
          definition: { type: "string" },
          examples: { type: "array", items: { type: "string" } },
          namespace: { type: "string" }
        },
        required: ["term", "definition"]
      }
    },
    {
      name: "memory_upsert",
      description:
        "Assert/update a refined memory by fact_key (no waiting for dream). " +
        "Use this proactively during conversation when the user reveals lasting facts, preferences, or relationship details. " +
        "world_fact also uses this with type='world_fact'. " +
        "Available types: fact, event, preference, relationship, boundary, habit, decision, note, world_fact. Defaults to 'fact'.",
      inputSchema: {
        type: "object",
        properties: {
          fact_key: {
            type: "string",
            description:
              "Stable business key for deduplication. Reusing the same fact_key updates the existing memory instead of creating a duplicate. " +
              "Examples: 'user_work_schedule', 'user_food_preference', 'relationship_with_alice'. " +
              "Choose a concise, descriptive key that represents this fact."
          },
          content: { type: "string" },
          type: { type: "string", description: "Memory type. One of: fact, event, preference, relationship, boundary, habit, decision, note, world_fact. Defaults to 'fact'." },
          importance: { type: "number", minimum: 0, maximum: 1, description: "重要性 0-1，1 为最重要。默认 0.6。" },
          confidence: { type: "number", minimum: 0, maximum: 1, description: "置信度 0-1。默认 0.8。" },
          tags: { type: "array", items: { type: "string" } },
          source: { type: "string" },
          valid_as_of: { type: "string" },
          namespace: { type: "string" },
          role_id: { type: "string", description: "角色 ID。不传存为共享记忆。" },
          role_name: { type: "string", description: "角色名称。无 role_id 时用于兜底 scope。" }
        },
        required: ["fact_key", "content"]
      }
    },
    // --- 原子记忆 pending 工具（已屏蔽）---
    // 保留 handler 代码（见下方 callTool），但从 tools 列表移除，模型看不到。
    // 原因：当前采用 MCP 主动维护原子记忆（memory_upsert 实时写），
    // 原子记忆 pending 容易产生低价值/重复记忆，不再暴露给模型。
    // 如需恢复，取消下方三个工具的注释即可。
    //
    // {
    //   name: "memory_change_add",
    //   description:
    //     "提交新增记忆的变更日志（pending）。凌晨做梦时由代码应用。白天不直接写 memories。" +
    //     "role_id/role_name 使用规则：记录角色特征/偏好/设定 → 传；记录用户通用信息 → 不传。",
    //   inputSchema: {
    //     type: "object",
    //     properties: {
    //       content: { type: "string" },
    //       type: {
    //         type: "string",
    //         description: "Memory type. One of: fact, event, preference, relationship, boundary, habit, decision, note, world_fact.",
    //       },
    //       importance: { type: "number" },
    //       role_id: {
    //         type: "string",
    //         description: "记录角色自己的特征/偏好/设定/关系时传 role_id；记录用户通用信息时不传。不要把从记忆召回中读到的信息重新写入。",
    //       },
    //       role_name: { type: "string" },
    //       reason: { type: "string" }
    //     },
    //     required: ["content"]
    //   }
    // },
    // {
    //   name: "memory_change_update",
    //   description:
    //     "提交修改记忆的变更日志（pending）。凌晨做梦时由代码应用。" +
    //     "需要目标记忆的 target_id。归属从目标记忆继承，不接受 role_id/role_name 参数。",
    //   inputSchema: {
    //     type: "object",
    //     properties: {
    //       target_id: { type: "string" },
    //       content: { type: "string" },
    //       type: { type: "string" },
    //       importance: { type: "number" },
    //       reason: { type: "string" }
    //     },
    //     required: ["target_id", "content"]
    //   }
    // },
    // {
    //   name: "memory_change_delete",
    //   description:
    //     "提交删除记忆的变更日志（pending）。凌晨做梦时由代码应用。归属从目标记忆继承。",
    //   inputSchema: {
    //     type: "object",
    //     properties: {
    //       target_id: { type: "string" },
    //       reason: { type: "string" }
    //     },
    //     required: ["target_id"]
    //   }
    // },
    {
      name: "baseline_change",
      description:
        "提交角色长期印象（baseline）的增删改（pending）。凌晨做梦时统一合并应用。" +
        "不影响当前缓存里的 baseline。用于小幅度更新角色对用户的长期认知。",
      inputSchema: {
        type: "object",
        properties: {
          op: {
            type: "string",
            description: "add | update | delete。add=新增印象，update=修改已有印象，delete=删除过时印象。",
          },
          before_content: {
            type: "string",
            description: "要修改/删除的原文片段（update 和 delete 时必填，add 时不传）。",
          },
          after_content: {
            type: "string",
            description: "修改后的文本（add 和 update 时必填，delete 时不传）。",
          },
          reason: {
            type: "string",
            description: "为什么要改（必填）。",
          },
          role_id: {
            type: "string",
            description: "角色 ID（必填，baseline 是角色专属，不支持 shared）。",
          },
          role_name: { type: "string" },
        },
        required: ["op", "reason", "role_id"],
      },
    },
    {
      name: "memory_supersede",
      description:
        "Mark old_id as superseded and insert a new active entry, linking the supersede chain. " +
        "Used for world_fact updates that invalidate older entries.",
      inputSchema: {
        type: "object",
        properties: {
          old_id: { type: "string" },
          new_content: { type: "string" },
          new_type: { type: "string" },
          new_fact_key: { type: "string" },
          valid_as_of: { type: "string" },
          reason: { type: "string" },
          namespace: { type: "string" }
        },
        required: ["old_id", "new_content"]
      }
    },
    {
      name: "memory_archive",
      description: "Soft-archive a memory (status='archived'). Does not touch the supersede chain.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          namespace: { type: "string" }
        },
        required: ["id"]
      }
    },
    {
      name: "digest_get",
      description: "Read the L1 digest (single row per namespace, <=1000 chars).",
      inputSchema: {
        type: "object",
        properties: {
          namespace: { type: "string" }
        }
      }
    },
    {
      name: "digest_set",
      description: "Overwrite the L1 digest (covering write, <=1000 chars).",
      inputSchema: {
        type: "object",
        properties: {
          content: { type: "string" },
          namespace: { type: "string" }
        },
        required: ["content"]
      }
    },
    {
      name: "daily_log_read",
      description:
        "Read daily logs. If date is provided, returns that single day's log. " +
        "Otherwise returns the most recent logs (default 7 days). " +
        "Use role_id/role_name to scope to a specific role.",
      inputSchema: {
        type: "object",
        properties: {
          date: { type: "string", description: "YYYY-MM-DD format. If omitted, returns recent logs." },
          limit: { type: "number", minimum: 1, maximum: 365, description: "Number of recent days to return (default 7, ignored if date is set)" },
          role_id: { type: "string", description: "Role ID to scope logs to a specific role" },
          role_name: { type: "string", description: "Role name (fallback if no role_id)" },
          namespace: { type: "string" }
        }
      }
    },
    {
      name: "daily_log_write",
      description:
        "Append to today's daily log. Date is determined by the server (Asia/Singapore timezone). " +
        "If a log already exists for today, the new summary lines are appended (not overwritten). " +
        "Call this near the end of a conversation to record what was discussed. " +
        "Title should be <=12 chars. Summary should use '- ' prefixed bullet points, <=800 chars total.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short title, <=12 chars. Ignored if today's log already has a title." },
          summary: { type: "string", description: "Bullet-point summary to append, each line starts with '- ', <=800 chars" },
          role_id: { type: "string", description: "Role ID to scope log to a specific role" },
          role_name: { type: "string", description: "Role name (fallback if no role_id)" },
          namespace: { type: "string" }
        },
        required: ["title"]
      }
    },
    {
      name: "memory_context",
      description:
        "System-only memory injection tool. Automatically called by the system to provide " +
        "relevant long-term memories. Do not call this tool manually.",
      inputSchema: {
        type: "object",
        properties: {},
        required: []
      }
    }
  ];
}

export async function callTool(
  env: Env,
  ctx: ExecutionContext,
  profile: KeyProfile,
  params: ToolCallParams
): Promise<Record<string, unknown>> {
  const args = isRecord(params.arguments) ? params.arguments : {};

  if (params.name === "memory_search") {
    if (!hasScope(profile, "memory:read")) return toolError("Missing memory:read scope");
    const query = readString(args.query);
    if (!query) return toolError("query is required");
    const memories = await searchVectorMemories(env, {
      namespace: resolveNamespace(profile, args.namespace),
      query,
      topK: readNumber(args.top_k, Number(env.MEMORY_TOP_K || 50)),
      types: readStringArray(args.types)
    });
    const data = await filterAndCompressMemories(env, { query, memories });
    return textToolResult({ data });
  }

  if (params.name === "memory_create") {
    if (!hasScope(profile, "memory:write")) return toolError("Missing memory:write scope");
    if (isV2Enabled(env)) return toolError("memory_create is deprecated in v2; use memory_upsert with fact_key");
    const content = readString(args.content);
    if (!content) return toolError("content is required");
    if (args.importance != null && !isValidRange(args.importance, 0, 1)) {
      return toolError("importance must be between 0 and 1");
    }
    if (args.confidence != null && !isValidRange(args.confidence, 0, 1)) {
      return toolError("confidence must be between 0 and 1");
    }
    let memory;
    try {
      memory = await createVectorMemory(env, {
        namespace: resolveNamespace(profile, args.namespace),
        type: readString(args.type) || "note",
        content,
        summary: readString(args.summary) || null,
        importance: readNumber(args.importance, 0.5),
        confidence: readNumber(args.confidence, 0.8),
        pinned: readBoolean(args.pinned),
        tags: readStringArray(args.tags),
        source: readString(args.source) || "mcp",
        sourceMessageIds: []
      });
    } catch (error) {
      return toolError(error instanceof Error ? error.message : "memory_create failed");
    }
    return textToolResult({ data: memory });
  }

  if (params.name === "memory_list") {
    if (!hasScope(profile, "memory:read")) return toolError("Missing memory:read scope");
    const limit = readPositiveInt(args.limit, 100, 1000);
    const namespace = resolveNamespace(profile, args.namespace);

    // v2: 走 D1 (本体)，能列出 fact_key upsert 写入的记录。
    // v1: 走 Vectorize (向量是当时唯一存储)。
    if (isV2Enabled(env)) {
      const page = await listMemoriesPage(env.DB, {
        namespace,
        type: readString(args.type),
        status: readString(args.status) ?? "active",
        limit,
        offset: readNonNegativeInt(args.offset ?? 0, 0, 1000000)
      });
      const lifecycleRows = await fetchMemoryLifecycleRows(env.DB, page.records.map((r) => r.id));
      const lifecycleByMemoryId = new Map(lifecycleRows.map((lc) => [lc.memory_id, lc]));
      return textToolResult({
        data: page.records.map((r) => toMemoryApiRecord(r, undefined, lifecycleByMemoryId.get(r.id) ?? null)),
        paging: {
          limit,
          has_more: page.hasMore,
          next_offset: page.nextOffset
        }
      });
    }

    try {
      const page = await listVectorMemories(env, {
        namespace,
        count: limit,
        cursor: readString(args.cursor),
        type: readString(args.type) ?? undefined,
        status: readString(args.status) ?? undefined
      });
      return textToolResult({
        data: page.data,
        ...(readBoolean(args.include_ids) ? { ids: page.ids } : {}),
        paging: {
          limit,
          cursor: page.cursor,
          has_more: page.hasMore,
          count: page.count,
          total_count: page.totalCount
        }
      });
    } catch (error) {
      return toolError(error instanceof Error ? error.message : "memory_list failed");
    }
  }

  if (params.name === "memory_export") {
    if (!hasScope(profile, "memory:read")) return toolError("Missing memory:read scope");
    if (!hasScope(profile, "export:read")) return toolError("Missing export:read scope");
    try {
      const result = await exportMemories(env, {
        namespace: resolveNamespace(profile, args.namespace),
        type: readString(args.type),
        format: readString(args.format) || "json"
      });
      return textToolResult(result);
    } catch (error) {
      return toolError(error instanceof Error ? error.message : "memory_export failed");
    }
  }

  if (params.name === "memory_get") {
    if (!hasScope(profile, "memory:read")) return toolError("Missing memory:read scope");
    const id = readString(args.id);
    if (!id) return toolError("id is required");

    // v2: 走 D1，能拿到 fact_key upsert / supersede 写入的记录。
    if (isV2Enabled(env)) {
      const record = await getMemoryById(env.DB, {
        namespace: resolveNamespace(profile, args.namespace),
        id
      });
      if (!record) return toolError("Memory not found");
      const lifecycleRows = await fetchMemoryLifecycleRows(env.DB, [record.id]);
      return textToolResult({ data: toMemoryApiRecord(record, undefined, lifecycleRows[0] ?? null) });
    }

    const memory = await getVectorMemory(env, id);
    if (!memory) return toolError("Memory not found");
    return textToolResult({ data: memory });
  }

  if (params.name === "memory_delete") {
    if (!hasScope(profile, "memory:write")) return toolError("Missing memory:write scope");
    const id = readString(args.id);
    if (!id) return toolError("id is required");
    const namespace = resolveNamespace(profile, args.namespace);

    // 软删：标 status=deleted，行保留在 D1（可恢复）。
    // 同时删 Vectorize 向量，防止召回时复活已删除的记忆。
    const deleted = await softDeleteMemory(env.DB, { namespace, id });
    if (!deleted) return toolError("Memory not found");

    try {
      await deleteVectorMemory(env, id);
    } catch (error) {
      console.error("mcp memory_delete: vector delete failed (D1 soft-deleted, vector may linger)", { id, error });
    }

    return textToolResult({ data: { id, deleted: true } });
  }

  if (params.name === "memory_ingest") {
    if (!hasScope(profile, "memory:write")) return toolError("Missing memory:write scope");
    const messages = readMessages(args.messages);
    if (messages.length === 0) return toolError("messages must contain at least one message");
    const namespace = resolveNamespace(profile, args.namespace);
    const conversation = await getOrCreateConversation(env.DB, {
      namespace,
      id: readString(args.conversation_id)
    });
    const source = readString(args.source) || "mcp";
    const ids = await saveIngestMessages(env.DB, {
      conversationId: conversation.id,
      namespace,
      source,
      messages
    });

    if (args.auto_extract !== false && ids.length > 0) {
      ctx.waitUntil(
        enqueueMemoryMaintenanceIfNeeded(env, {
          namespace,
          conversationId: conversation.id,
          fromMessageId: ids[0],
          toMessageId: ids[ids.length - 1],
          source
        })
      );
    }

    return textToolResult({
      data: {
        conversation_id: conversation.id,
        message_ids: ids,
        auto_extract: args.auto_extract !== false
      }
    });
  }

  // --- Aelios 记忆库 v2 端点 (母帖 #11 第 2 步) ---
  // 全部走 MEMORY_LIFECYCLE_ENABLED 总闸；关时返回未启用，不碰 v2 表。

  if (params.name === "memory_boot") {
    if (!hasScope(profile, "memory:read")) return toolError("Missing memory:read scope");
    if (!isV2Enabled(env)) return toolError("memory_boot requires MEMORY_LIFECYCLE_ENABLED=true");
    const pkg = await buildBootPackage(env, {
      namespace: resolveNamespace(profile, args.namespace),
      roleId: readString(args.role_id) ?? null,
      roleName: readString(args.role_name) ?? null,
    });
    return textToolResult({ data: pkg });
  }

  if (params.name === "memory_recall") {
    if (!hasScope(profile, "memory:read")) return toolError("Missing memory:read scope");
    if (!isV2Enabled(env)) return toolError("memory_recall requires MEMORY_LIFECYCLE_ENABLED=true");
    const query = readString(args.query);
    if (!query) return toolError("query is required");
    const result = await runRecall(env, {
      namespace: resolveNamespace(profile, args.namespace),
      query,
      k: readNumber(args.k, 20),
      min_score: typeof args.min_score === "number" ? readNumber(args.min_score, 0.15) : undefined,
      types: readStringArray(args.types),
      role_id: readString(args.role_id) ?? null,
      role_name: readString(args.role_name) ?? null
    });
    return textToolResult({ data: result });
  }

  if (params.name === "memory_pin") {
    if (!hasScope(profile, "memory:write")) return toolError("Missing memory:write scope");
    if (!isV2Enabled(env)) return toolError("memory_pin requires MEMORY_LIFECYCLE_ENABLED=true");
    const content = readString(args.content);
    if (!content) return toolError("content is required");
    const precious = await createPrecious(env.DB, {
      namespace: resolveNamespace(profile, args.namespace),
      content,
      contextMessageIds: readStringArray(args.context_message_ids)
    });
    return textToolResult({ data: precious });
  }

  if (params.name === "glossary_set") {
    if (!hasScope(profile, "memory:write")) return toolError("Missing memory:write scope");
    if (!isV2Enabled(env)) return toolError("glossary_set requires MEMORY_LIFECYCLE_ENABLED=true");
    const term = readString(args.term);
    const definition = readString(args.definition);
    if (!term) return toolError("term is required");
    if (!definition) return toolError("definition is required");
    const row = await upsertGlossary(env.DB, {
      namespace: resolveNamespace(profile, args.namespace),
      term,
      aliases: readStringArray(args.aliases),
      definition,
      examples: readStringArray(args.examples)
    });
    return textToolResult({ data: row });
  }

  if (params.name === "memory_upsert") {
    if (!hasScope(profile, "memory:write")) return toolError("Missing memory:write scope");
    if (!isV2Enabled(env)) return toolError("memory_upsert requires MEMORY_LIFECYCLE_ENABLED=true");
    const factKey = readString(args.fact_key);
    const content = readString(args.content);
    if (!factKey) return toolError("fact_key is required");
    if (!content) return toolError("content is required");
    if (args.importance != null && !isValidRange(args.importance, 0, 1)) {
      return toolError("importance must be between 0 and 1");
    }
    if (args.confidence != null && !isValidRange(args.confidence, 0, 1)) {
      return toolError("confidence must be between 0 and 1");
    }
    const result = await upsertMemoryByFactKey(env, {
      namespace: resolveNamespace(profile, args.namespace),
      factKey,
      content,
      type: readString(args.type) || "fact",
      importance: readNumber(args.importance, 0.6),
      confidence: readNumber(args.confidence, 0.8),
      tags: readStringArray(args.tags),
      source: readString(args.source) || "mcp",
      validAsOf: readString(args.valid_as_of),
      roleId: readString(args.role_id) ?? null,
      roleName: readString(args.role_name) ?? null
    });
    return textToolResult({ data: result });
  }

  if (params.name === "memory_change_add") {
    if (!hasScope(profile, "memory:write")) return toolError("Missing memory:write scope");
    const content = readString(args.content);
    if (!content) return toolError("content is required");
    const row = await createChangelogEntry(env.DB, {
      namespace: resolveNamespace(profile, args.namespace),
      op: "add",
      afterContent: content,
      payloadJson: JSON.stringify({
        content,
        type: readString(args.type) || "fact",
        importance: readNumber(args.importance, 0.6),
      }),
      reason: readString(args.reason) ?? null,
      roleId: readString(args.role_id) ?? null,
      roleName: readString(args.role_name) ?? null,
    });
    return textToolResult({ data: row });
  }

  if (params.name === "memory_change_update") {
    if (!hasScope(profile, "memory:write")) return toolError("Missing memory:write scope");
    const targetId = readString(args.target_id);
    const content = readString(args.content);
    if (!targetId) return toolError("target_id is required");
    if (!content) return toolError("content is required");
    const row = await createChangelogEntry(env.DB, {
      namespace: resolveNamespace(profile, args.namespace),
      op: "update",
      targetId,
      afterContent: content,
      payloadJson: JSON.stringify({
        content,
        type: readString(args.type),
        importance: readNumber(args.importance, 0.6),
      }),
      reason: readString(args.reason) ?? null,
      // Role is NOT accepted from args — inherited from target at apply time
    });
    return textToolResult({ data: row });
  }

  if (params.name === "memory_change_delete") {
    if (!hasScope(profile, "memory:write")) return toolError("Missing memory:write scope");
    const targetId = readString(args.target_id);
    if (!targetId) return toolError("target_id is required");
    const row = await createChangelogEntry(env.DB, {
      namespace: resolveNamespace(profile, args.namespace),
      op: "delete",
      targetId,
      payloadJson: JSON.stringify({}),
      reason: readString(args.reason) ?? null,
      // Role is NOT accepted — inherited from target at apply time
    });
    return textToolResult({ data: row });
  }

  if (params.name === "baseline_change") {
    if (!hasScope(profile, "memory:write")) return toolError("Missing memory:write scope");
    const op = readString(args.op);
    const reason = readString(args.reason);
    const roleId = readString(args.role_id);
    const roleName = readString(args.role_name) ?? null;
    // 校验
    if (!op || !["add", "update", "delete"].includes(op)) {
      return toolError("op must be add, update, or delete");
    }
    if (!reason) return toolError("reason is required");
    if (!roleId) return toolError("role_id is required (baseline is role-specific, shared baseline is not allowed)");
    const beforeContent = readString(args.before_content) ?? null;
    const afterContent = readString(args.after_content) ?? null;
    if (op === "add" && !afterContent) return toolError("add requires after_content");
    if (op === "update" && (!beforeContent || !afterContent)) return toolError("update requires before_content and after_content");
    if (op === "delete" && !beforeContent) return toolError("delete requires before_content");
    const roleScope = computeRoleScope(roleId, roleName);
    if (roleScope === "shared") return toolError("shared baseline is not allowed; role_id is required");
    const row = await createBaselineChangelogEntry(env.DB, {
      namespace: resolveNamespace(profile, args.namespace),
      roleScope,
      op: op as "add" | "update" | "delete",
      beforeContent,
      afterContent,
      reason,
      roleId,
      roleName,
    });
    return textToolResult({ data: row });
  }

  if (params.name === "memory_supersede") {
    if (!hasScope(profile, "memory:write")) return toolError("Missing memory:write scope");
    if (!isV2Enabled(env)) return toolError("memory_supersede requires MEMORY_LIFECYCLE_ENABLED=true");
    const oldId = readString(args.old_id);
    const newContent = readString(args.new_content);
    if (!oldId) return toolError("old_id is required");
    if (!newContent) return toolError("new_content is required");
    try {
      const result = await supersedeMemory(env, {
        namespace: resolveNamespace(profile, args.namespace),
        oldId,
        newContent,
        newType: readString(args.new_type) || "world_fact",
        newFactKey: readString(args.new_fact_key),
        validAsOf: readString(args.valid_as_of),
        reason: readString(args.reason)
      });
      return textToolResult({ data: result });
    } catch (error) {
      return toolError(error instanceof Error ? error.message : "memory_supersede failed");
    }
  }

  if (params.name === "memory_archive") {
    if (!hasScope(profile, "memory:write")) return toolError("Missing memory:write scope");
    if (!isV2Enabled(env)) return toolError("memory_archive requires MEMORY_LIFECYCLE_ENABLED=true");
    const id = readString(args.id);
    if (!id) return toolError("id is required");
    const archived = await archiveMemory(env, {
      namespace: resolveNamespace(profile, args.namespace),
      id
    });
    if (!archived) return toolError("Memory not found");
    return textToolResult({ data: { id, archived: true } });
  }

  if (params.name === "digest_get") {
    if (!hasScope(profile, "memory:read")) return toolError("Missing memory:read scope");
    if (!isV2Enabled(env)) return toolError("digest_get requires MEMORY_LIFECYCLE_ENABLED=true");
    const row = await getDigest(env.DB, resolveNamespace(profile, args.namespace));
    return textToolResult({ data: row });
  }

  if (params.name === "digest_set") {
    if (!hasScope(profile, "memory:write")) return toolError("Missing memory:write scope");
    if (!isV2Enabled(env)) return toolError("digest_set requires MEMORY_LIFECYCLE_ENABLED=true");
    const content = readString(args.content);
    if (!content) return toolError("content is required");
    if (content.length > DIGEST_MAX_CHARS) return toolError(`digest content must be <= ${DIGEST_MAX_CHARS} chars (L1 摘要字数自检)`);
    const row = await upsertDigest(env.DB, {
      namespace: resolveNamespace(profile, args.namespace),
      content
    });
    return textToolResult({ data: row });
  }

  if (params.name === "daily_log_read") {
    if (!hasScope(profile, "memory:read")) return toolError("Missing memory:read scope");
    const namespace = resolveNamespace(profile, args.namespace);
    const roleScope = computeRoleScope(readString(args.role_id), readString(args.role_name));
    const date = readString(args.date);
    if (date) {
      const log = await getDailyLog(env.DB, { namespace, date, roleScope });
      return textToolResult({ data: log ?? { message: "No log found for this date" } });
    }
    const limit = readPositiveInt(args.limit, 7, 365);
    const logs = await getRecentDailyLogs(env.DB, { namespace, limit, roleScope });
    return textToolResult({ data: logs });
  }

  if (params.name === "daily_log_write") {
    if (!hasScope(profile, "memory:write")) return toolError("Missing memory:write scope");
    const namespace = resolveNamespace(profile, args.namespace);
    const tz = readString(env.DREAM_TIME_ZONE) || "Asia/Singapore";
    const date = new Date().toLocaleDateString("sv-SE", { timeZone: tz }); // YYYY-MM-DD
    const title = readString(args.title);
    if (!title) return toolError("title is required");
    if (title.length > 12) return toolError("title must be <= 12 characters");
    const newSummary = readString(args.summary) || "";
    if (newSummary.length > 800) return toolError("summary must be <= 800 characters");
    const roleScope = computeRoleScope(readString(args.role_id), readString(args.role_name));

    // Read existing log for today; append if exists
    const existing = await getDailyLog(env.DB, { namespace, date, roleScope });
    let mergedTitle = title;
    let mergedSummary = newSummary;
    if (existing) {
      // Keep existing title if present
      mergedTitle = existing.title || title;
      // Append new summary lines to existing
      const existingSummary = (existing.summary || "").trim();
      const appendSummary = newSummary.trim();
      if (existingSummary && appendSummary) {
        mergedSummary = existingSummary + "\n" + appendSummary;
      } else {
        mergedSummary = existingSummary || appendSummary;
      }
    }

    if (mergedSummary.length > 2000) return toolError("merged summary exceeds 2000 characters; today's log is getting too long");

    const log = await upsertDailyLog(env.DB, { namespace, date, title: mergedTitle, summary: mergedSummary, roleScope });
    return textToolResult({ data: log });
  }

  if (params.name === "memory_context") {
    return textToolResult({
      text: "This tool is system-managed and has already been executed. "
          + "The relevant context has been provided. Do not call this tool manually."
    });
  }

  return toolError(`Unknown tool: ${String(params.name || "")}`);
}

async function handleRpc(
  request: JsonRpcRequest,
  env: Env,
  ctx: ExecutionContext,
  profile: KeyProfile
): Promise<Record<string, unknown> | null> {
  if (!request.id && request.method?.startsWith("notifications/")) return null;

  if (request.method === "initialize") {
    return rpcResult(request.id, {
      protocolVersion: "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "companion-memory-mcp", version: "0.1.0" }
    });
  }

  if (request.method === "tools/list") {
    return rpcResult(request.id, { tools: getTools() });
  }

  if (request.method === "resources/list") {
    return rpcResult(request.id, { resources: [] });
  }

  if (request.method === "prompts/list") {
    return rpcResult(request.id, { prompts: [] });
  }

  if (request.method === "tools/call") {
    const params = isRecord(request.params) ? (request.params as ToolCallParams) : {};
    const result = await callTool(env, ctx, profile, params);
    return rpcResult(request.id, result);
  }

  if (request.method === "ping") {
    return rpcResult(request.id, {});
  }

  return rpcError(request.id, -32601, "Method not found");
}

export async function handleMcp(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }

  if (request.method === "GET") {
    return json({
      name: "companion-memory-mcp",
      transport: "streamable-http",
      endpoint: new URL(request.url).pathname,
      tools: getTools().map((tool) => tool.name)
    });
  }

  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  const auth = await authenticate(withTokenQuery(request), env);
  if (!auth.ok) return rpcErrorResponse(null, -32001, "Unauthorized", 401);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return rpcErrorResponse(null, -32700, "Parse error", 400);
  }

  if (Array.isArray(body)) {
    const results = (
      await Promise.all(
        body
          .filter((item): item is JsonRpcRequest => isRecord(item))
          .map((item) => handleRpc(item, env, ctx, auth.profile))
      )
    ).filter((item): item is Record<string, unknown> => item !== null);
    return results.length > 0 ? json(results) : new Response(null, { status: 202 });
  }

  if (!isRecord(body)) return rpcErrorResponse(null, -32600, "Invalid Request", 400);

  const result = await handleRpc(body, env, ctx, auth.profile);
  return result ? json(result) : new Response(null, { status: 202 });
}

function rpcErrorResponse(id: JsonRpcId | undefined, code: number, message: string, status: number): Response {
  return json(rpcError(id, code, message), { status });
}

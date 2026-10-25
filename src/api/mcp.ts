import { authenticate } from "../auth/apiKey";
import { identityNamespace, loadConfig, type GatewayConfig } from "../gateway/config";
import { getOrCreateConversation } from "../db/conversations";
import { fetchMemoriesByIds, getMemoryById, listMemoriesPage, softDeleteMemory } from "../db/memories";
import { saveIngestMessages } from "../db/messages";
import {
  archiveMemory,
  createBaselineChangelogEntry,
  createPrecious,
  fetchMemoryLifecycleRows,
  getDailyLog,
  getWeeklyLog,
  listRecentDailyLogs,
  upsertDailyLog,
  getPreciousById,
  markPreciousInjected,
  supersedeMemory,
  upsertGlossary,
  upsertMemoryByFactKey
} from "../db/v2";
import { exportMemories } from "../memory/export";
import { deleteMemoryEmbedding } from "../memory/embedding";
import { buildBootPackage, isV2Enabled, runRecall } from "../memory/v2/recall";
import { readDreamTimeZoneFromEnv } from "../memory/dailyDigest";
import { withImpressionDisclaimer } from "../memory/impression";
import { getIsoWeekLabelForDateLabel } from "../memory/weeklyRollup";
import { searchMemories, toMemoryApiRecord } from "../memory/search";
import {
  AFFECT_CHORD_TOOL_DESCRIPTION,
  AFFECT_CHORD_TOOL_HINT,
  normalizeAffectChord
} from "../extensions/affectChord";
import {
  createVectorMemory,
  deleteVectorMemory,
  getVectorMemory,
  listVectorMemories
} from "../memory/vectorStore";

import type { Env, KeyProfile, Scope } from "../types";
import { json } from "../utils/json";
import { formatDateLabel } from "../utils/time";
import {
  isRecord,
  isValidRange,
  readBoolean,
  readMessages,
  readNonNegativeInt,
  readNumber,
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

const NAMESPACE_PARAM = {
  type: "string",
  description: "Memory space to use. Defaults to 'default'. Ignored when the API key is bound to a fixed namespace."
};

const MEMORY_TYPES_TEXT = "fact, event, preference, relationship, boundary, habit, decision, note";

const MEMORY_ID_PARAM = {
  type: "string",
  description: "Memory id (e.g. from memory_search, memory_recall or memory_list)."
};

const READ_ONLY = { readOnlyHint: true, openWorldHint: false };

// Reads that also write recall bookkeeping (counters / last-injected timestamps), never memory content.
const BOOKKEEPING_READ = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

export function getTools(): Array<Record<string, unknown>> {
  return [
    {
      name: "memory_search",
      description:
        "Hybrid search (vector + keyword) over the user's active long-term memories. Returns up to top_k full records " +
        "(id, content, type, status, scores) after a relevance filter but without reranking, as { data: [...] }. " +
        "Use it to find memories you want to inspect or edit by id. To answer a question with the most relevant, " +
        "reranked memories plus glossary hits, use memory_recall instead. Never changes memory content; " +
        "it only updates recall counters.",
      annotations: { title: "Search memories", ...BOOKKEEPING_READ },
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "What to look for, in natural language or keywords." },
          top_k: {
            type: "number",
            minimum: 1,
            maximum: 50,
            description: "Maximum number of records to return. Defaults to the server setting (50)."
          },
          types: {
            type: "array",
            items: { type: "string" },
            description: `Only return these memory types (${MEMORY_TYPES_TEXT}). Omit for all types.`
          },
          namespace: NAMESPACE_PARAM
        },
        required: ["query"]
      }
    },
    {
      name: "memory_list",
      description:
        "Page through stored memories without a query, pinned first, then by importance, then most recently updated; " +
        "optionally filtered by type or status. Returns { data, paging: { limit, has_more, next_offset } }; pass next_offset back as offset for the next page. " +
        "Use memory_search or memory_recall to find memories by meaning. Read-only.",
      annotations: { title: "List memories", ...READ_ONLY },
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", minimum: 1, maximum: 1000, description: "Page size. Defaults to 100." },
          offset: { type: "number", minimum: 0, description: "Number of records to skip. Use paging.next_offset from the previous page." },
          cursor: { type: "string", description: "Legacy paging cursor; only used when the lifecycle store is disabled. Prefer offset." },
          include_ids: { type: "boolean", description: "Legacy mode only: also return the bare id list." },
          type: { type: "string", description: `Only list one memory type (${MEMORY_TYPES_TEXT}).` },
          status: {
            type: "string",
            description: "Only list memories with this status: active (default), archived or superseded."
          },
          namespace: NAMESPACE_PARAM
        }
      }
    },
    {
      name: "memory_export",
      description:
        "Export the namespace's active memories (content plus metadata) as one JSON payload, for backup or " +
        "migration. Archived and superseded memories are not included. The result can be large; use memory_list to page or memory_search to look things up. Read-only.",
      annotations: { title: "Export memories", ...READ_ONLY },
      inputSchema: {
        type: "object",
        properties: {
          type: { type: "string", description: `Only export one memory type (${MEMORY_TYPES_TEXT}). Omit for all.` },
          format: { type: "string", enum: ["json"], description: "Output format. Only json is supported (default)." },
          namespace: NAMESPACE_PARAM
        }
      }
    },
    {
      name: "memory_get",
      description:
        "Fetch one memory by id with its full record and lifecycle fields (fact_key, version status, superseded_by). " +
        "Returns { data: record }, or an error result 'Memory not found' if the id does not exist in this namespace. Use it after " +
        "memory_search, memory_recall or memory_list when you need the complete record before editing. Read-only.",
      annotations: { title: "Get memory", ...READ_ONLY },
      inputSchema: {
        type: "object",
        properties: {
          id: MEMORY_ID_PARAM,
          namespace: NAMESPACE_PARAM
        },
        required: ["id"]
      }
    },
    {
      name: "memory_delete",
      description:
        "Permanently delete one memory by id, removing it from storage and from the search index. This cannot be " +
        "undone. To hide a memory but keep the record, use memory_archive; to replace an outdated fact while keeping " +
        "its history, use memory_supersede. Returns { data: { id, deleted: true } }, or an error result if the id is not " +
        "found or the memory could not be removed from the search index (the record is then kept).",
      annotations: {
        title: "Delete memory",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: {
        type: "object",
        properties: {
          id: MEMORY_ID_PARAM,
          namespace: NAMESPACE_PARAM
        },
        required: ["id"]
      }
    },
    {
      name: "memory_ingest",
      description:
        "Store raw chat messages as conversation history. Memories are not extracted immediately: the nightly " +
        "background pipeline (dream) reads stored messages and distills them into long-term memories later. " +
        "To save a fact right away, use memory_upsert. Returns { data: { conversation_id, message_ids } }; message_ids " +
        "can be passed to memory_pin as context.",
      annotations: {
        title: "Ingest messages",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      },
      inputSchema: {
        type: "object",
        properties: {
          messages: {
            type: "array",
            description: "Messages in chronological order.",
            items: {
              type: "object",
              properties: {
                role: { type: "string", description: "One of user, assistant, system, tool. Other roles are dropped." },
                content: { description: "Message text, or an OpenAI-style content parts array." }
              },
              required: ["role", "content"]
            }
          },
          conversation_id: {
            type: "string",
            description: "Conversation to append to. Defaults to the namespace's shared default conversation."
          },
          source: { type: "string", description: "Label for where the messages came from. Defaults to 'mcp'." },
          auto_extract: {
            type: "boolean",
            description: "Accepted for compatibility only; it is not stored and does not change processing."
          },
          namespace: NAMESPACE_PARAM
        },
        required: ["messages"]
      }
    },
    // --- Aelios 记忆库 v2 端点 (母帖 #11 第 2 步) ---
    // 全部走 MEMORY_LIFECYCLE_ENABLED 总闸；关时返回未启用。
    {
      name: "memory_boot",
      description:
        "Cold-start context package for a new session: yesterday's diary log, the latest weekly and monthly summaries, " +
        "the 20 most recent precious entries (from memory_pin), every glossary term and any spontaneous perception " +
        "items, as { data: {...} }. Output is stable and deterministically ordered so the client can cache it. " +
        "Call once at session start, not every turn; for per-question lookups use memory_recall. Never changes " +
        "memory content; it only records that the returned precious entries were shown.",
      annotations: { title: "Load session context", ...BOOKKEEPING_READ },
      inputSchema: {
        type: "object",
        properties: {
          namespace: NAMESPACE_PARAM
        }
      }
    },
    {
      name: "memory_recall",
      description:
        "Answer-oriented recall: matches glossary terms literally, runs hybrid search over active memories, " +
        "reranks the hits and drops anything below min_score. Returns { data: { hits, glossary_hits, week_blocks, meta } }, " +
        "each hit with id, score and source so you can cite or edit it. Precious entries are not searched here " +
        "(they come from memory_boot). Prefer this over memory_search when you want only the relevant memories " +
        "for the current question. Never changes memory content, but marks the returned memories as recently " +
        "injected, which briefly lowers their rank in later automatic recall.",
      annotations: { title: "Recall memories", ...BOOKKEEPING_READ },
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "The question or topic to recall memories for." },
          k: {
            type: "number",
            minimum: 1,
            maximum: 100,
            description: "Maximum number of memory hits. Defaults to 20."
          },
          min_score: {
            type: "number",
            minimum: 0,
            maximum: 1,
            description: "Relevance floor applied after reranking. Defaults to the server setting (0.15)."
          },
          types: {
            type: "array",
            items: { type: "string" },
            description: `Only recall these memory types (${MEMORY_TYPES_TEXT}). Omit for all types.`
          },
          namespace: NAMESPACE_PARAM,
          include_history: {
            type: "boolean",
            description:
              "When true, include superseded memory versions (status/version_status=superseded). Default false."
          }
        },
        required: ["query"]
      }
    },
    {
      name: "memory_pin",
      description:
        "Save a moment as a precious entry: pinned, offered through memory_boot (which shows the 20 most recent), and " +
        "never deduplicated, decayed or deleted by the automatic pipeline. Each call creates a new entry. Write the content so it " +
        "still makes sense on its own later, and attach the surrounding messages via context_message_ids. " +
        "For ordinary facts use memory_upsert. Returns { data: precious record }.",
      annotations: {
        title: "Pin precious memory",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      },
      inputSchema: {
        type: "object",
        properties: {
          content: { type: "string", description: "The moment to keep, self-contained and readable on its own." },
          context_message_ids: {
            type: "array",
            items: { type: "string" },
            description: "Ids of stored messages (e.g. message_ids from memory_ingest) to keep as surrounding context."
          },
          namespace: NAMESPACE_PARAM
        },
        required: ["content"]
      }
    },
    {
      name: "glossary_set",
      description:
        "Add or update a glossary term: private vocabulary such as nicknames, in-jokes or project names. Terms are " +
        "matched literally (not by vector) during memory_recall and are all included in memory_boot. Upserts by " +
        "term: an existing term gets the new definition, and aliases/examples are replaced by what you pass " +
        "(omitting them clears them). Returns { data: glossary row }.",
      annotations: {
        title: "Set glossary term",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: {
        type: "object",
        properties: {
          term: { type: "string", description: "The word or phrase exactly as it is used." },
          aliases: {
            type: "array",
            items: { type: "string" },
            description: "Other spellings or names that should match this term. Replaces any existing aliases."
          },
          definition: { type: "string", description: "What the term means." },
          examples: {
            type: "array",
            items: { type: "string" },
            description: "Example sentences using the term. Replaces any existing examples."
          },
          namespace: NAMESPACE_PARAM
        },
        required: ["term", "definition"]
      }
    },
    {
      name: "memory_upsert",
      description:
        "Write a refined memory immediately (no waiting for the nightly dream), keyed by fact_key. If an active " +
        "memory with the same fact_key exists, its content and fields are overwritten in place and the old text is " +
        "not kept; otherwise a new memory is created. To keep the old version as history, use memory_supersede. " +
        "Pass authored_by (with the default source) to mark the memory as hand-authored: it ranks above distilled " +
        "memories and the automatic pipeline cannot overwrite it. Returns { data: { id, created } }.",
      annotations: {
        title: "Upsert memory",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false
      },
      inputSchema: {
        type: "object",
        properties: {
          fact_key: {
            type: "string",
            description:
              "Stable key for this fact, e.g. 'user:favorite_coffee'. Reusing a key updates that memory. " +
              "Facts about the outside world rather than the user use the prefix 'world_fact:'."
          },
          content: { type: "string", description: "The memory text, one self-contained statement." },
          type: { type: "string", description: `One of ${MEMORY_TYPES_TEXT}. Other values become fact (default).` },
          importance: { type: "number", description: "0 to 1, how much this matters. Defaults to 0.6." },
          emotional: { type: "number", description: "0 to 1, emotional intensity of this moment. Defaults to 0.0." },
          recurrence: { type: "number", description: "0 to 1, likelihood this pattern or topic comes up again. Defaults to 0.0." },
          unresolved: { type: "number", description: "0 to 1, whether this is still an open or pending matter; set to 0 once resolved. Defaults to 0.0." },
          confidence: { type: "number", description: "0 to 1, how sure you are it is true. Defaults to 0.8." },
          tags: { type: "array", items: { type: "string" }, description: "Free-form labels." },
          source: {
            type: "string",
            description:
              "Who is writing. Leave unset (defaults to 'mcp'). authored_by is only stored when source is mcp, manual, api or remember_now."
          },
          valid_as_of: {
            type: "string",
            description: "When the fact became true (ISO date or datetime). Used as the event date in recall."
          },
          authored_by: { type: "string", description: "E-axis signature; only honored on hand sources (mcp/manual/api/remember_now)" },
          response_tendency: { type: "string", description: "E-axis: how to respond when this memory fires" },
          namespace: NAMESPACE_PARAM
        },
        required: ["fact_key", "content"]
      }
    },
    {
      name: "memory_supersede",
      description:
        "Replace an outdated memory while keeping history: marks old_id as superseded (kept, and visible via " +
        "memory_recall with include_history) and inserts a new active memory linked to it. The new entry inherits " +
        "the old fact_key unless new_fact_key is given. If old_id does not exist, the new memory is still created and " +
        "oldStatus is 'missing'. Use it when a fact changed over time; to fix a mistake in place use memory_upsert, " +
        "and to remove a memory use memory_archive or memory_delete. Returns { data: { oldStatus, newId } }.",
      annotations: {
        title: "Supersede memory",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false
      },
      inputSchema: {
        type: "object",
        properties: {
          old_id: { type: "string", description: "Id of the memory being replaced." },
          new_content: { type: "string", description: "The up-to-date memory text." },
          new_type: { type: "string", description: `One of ${MEMORY_TYPES_TEXT}. Other values become fact (default).` },
          new_fact_key: { type: "string", description: "fact_key for the new entry. Defaults to the old entry's fact_key." },
          valid_as_of: { type: "string", description: "When the new fact became true (ISO date or datetime)." },
          reason: { type: "string", description: "Short note on why the old memory is outdated; stored with the chain." },
          authored_by: { type: "string", description: "E-axis signature for the new entry (hand sources only)" },
          response_tendency: { type: "string", description: "E-axis: how to respond when the new memory fires" },
          namespace: NAMESPACE_PARAM
        },
        required: ["old_id", "new_content"]
      }
    },
    {
      name: "memory_archive",
      description:
        "Soft-archive a memory: sets status='archived' and removes it from search and recall, but keeps the record " +
        "in storage (memory_list with status='archived' still shows it). There is no MCP tool to un-archive. " +
        "Does not touch the supersede chain. Prefer this over memory_delete when the memory might be needed later. " +
        "Returns { data: { id, archived: true } }, or an error result 'Memory not found'.",
      annotations: {
        title: "Archive memory",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: {
        type: "object",
        properties: {
          id: MEMORY_ID_PARAM,
          namespace: NAMESPACE_PARAM
        },
        required: ["id"]
      }
    },
    {
      name: "baseline_change",
      description:
        "Submit a pending change (add/update/delete) to this namespace's long-term baseline — the stable, " +
        "lasting impression of the user that you maintain yourself (namespace is fixed by the MCP endpoint " +
        "URL /mcp/<identity>). Changes are batched and merged during " +
        "the nightly dream cycle, not applied immediately; today's submitted changes are echoed back to you " +
        "in the next request, so do not resubmit. Use for incremental updates only; do not rewrite the whole " +
        "baseline here.",
      annotations: { title: "Submit baseline change", readOnlyHint: false, openWorldHint: false },
      inputSchema: {
        type: "object",
        properties: {
          op: {
            type: "string",
            description: "add | update | delete. add = new lasting impression, update = revise existing, delete = remove outdated."
          },
          before_content: {
            type: "string",
            description: "Original text to modify/delete (required for update and delete, omit for add)."
          },
          after_content: {
            type: "string",
            description: "New/updated text (required for add and update, omit for delete)."
          },
          reason: {
            type: "string",
            description: "Why the change is needed (required)."
          }
        },
        required: ["op", "reason"]
      }
    },
    {
      name: "daily_log_read",
      description:
        "Read daily logs (namespace is fixed by the MCP endpoint URL /mcp/<identity>). " +
        "These are impressions, not verified facts. " +
        "date: that single day's log (rolled-up daily dates fall back to weekly_log). " +
        "week (e.g. 2026-W29): the weekly summary. " +
        "Omit everything for the most recent logged days (default 7, limit max 365) — " +
        "use this to page back after an absence; today+yesterday only returns natural days and misses gaps.",
      annotations: { title: "Read daily log", ...READ_ONLY },
      inputSchema: {
        type: "object",
        properties: {
          date: { type: "string", description: "YYYY-MM-DD; a specific day's log" },
          week: { type: "string", description: "ISO week label, e.g. 2026-W29" },
          limit: { type: "number", minimum: 1, maximum: 365, description: "Number of recent logged days to return (default 7); ignored when date or week is set" }
        }
      }
    },
    {
      name: "daily_log_write",
      // biome-ignore format: description 为单行拼接长文本
      description: `Append to today's daily log (namespace is fixed by the MCP endpoint URL /mcp/<identity>; date decided by the server timezone). If today's log already exists, new summary lines are appended (not overwritten) and an existing title is kept. Call this near the end of a conversation to record what was discussed. Title <= 12 chars. Summary as '- ' prefixed bullet points, <= 800 chars per call; today's merged log must stay <= 2000 chars. ${AFFECT_CHORD_TOOL_HINT}`,
      annotations: { title: "Append daily log", readOnlyHint: false, openWorldHint: false },
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short title for the day, <= 12 chars. Ignored if today's log already has one." },
          summary: { type: "string", description: "Bullet-point lines to append, each starting with '- ', <= 800 chars" },
          affect_chord: { type: "string", description: AFFECT_CHORD_TOOL_DESCRIPTION }
        },
        required: ["title"]
      }
    }
  ];
}

async function callTool(
  env: Env,
  ctx: ExecutionContext,
  profile: KeyProfile,
  params: ToolCallParams,
  binding: McpNamespaceBinding
): Promise<Record<string, unknown>> {
  const args = isRecord(params.arguments) ? params.arguments : {};

  // 方案 D namespace 归属：identity 路由（/mcp/:identity）强制绑定写入空间，
  // 忽略 args.namespace；全局 /mcp 路径上角色记忆面工具必须带 identity，报错不回退 default。
  const toolNamespace = (): string | null => {
    if (binding.namespace) return binding.namespace;
    return resolveNamespace(profile, args.namespace);
  };
  const requireIdentity = (): string | null => {
    if (binding.namespace) return binding.namespace;
    return null;
  };

  if (params.name === "memory_search") {
    if (!hasScope(profile, "memory:read")) return toolError("Missing memory:read scope");
    const query = readString(args.query);
    if (!query) return toolError("query is required");
    const memories = await searchMemories(env, {
      namespace: toolNamespace() ?? "default",
      query,
      topK: readNumber(args.top_k, Number(env.MEMORY_TOP_K || 50)),
      types: readStringArray(args.types)
    });
    return textToolResult({ data: memories });
  }

  if (params.name === "memory_create") {
    if (!hasScope(profile, "memory:write")) return toolError("Missing memory:write scope");
    if (isV2Enabled(env)) return toolError("memory_create is deprecated in v2; use memory_upsert with fact_key");
    const content = readString(args.content);
    if (!content) return toolError("content is required");
    // 入口校验（裁定 #2，v1 残留路径与旧版保持一致）：拒绝越界、不收敛。
    if (args.importance != null && !isValidRange(args.importance, 0, 1)) {
      return toolError("importance must be between 0 and 1");
    }
    if (args.confidence != null && !isValidRange(args.confidence, 0, 1)) {
      return toolError("confidence must be between 0 and 1");
    }
    let memory: Awaited<ReturnType<typeof createVectorMemory>>;
    try {
      memory = await createVectorMemory(env, {
        namespace: toolNamespace() ?? "default",
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
        namespace: toolNamespace() ?? "default",
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
    // 删除语义（P5-A）：软删后的行对工具面不可见——模型侧"删了就是没了"，
    // REST GET /v1/memories/:id 保留原行为（deleted 行可读，供核查/恢复）。
    if (isV2Enabled(env)) {
      const record = await getMemoryById(env.DB, {
        namespace: toolNamespace() ?? "default",
        id
      });
      if (!record || record.status === "deleted") return toolError("Memory not found");
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

    // v2: 软删——标 status='deleted'，D1 行与 lifecycle/版本链保留（可恢复、供核查/迁移）。
    // 向量 best-effort：删除失败只记日志，不回滚软删、不向调用方谎报失败。
    // 已删除/跨 namespace/不存在保持未命中。行为模板 = 旧 4cc0263，
    // 与 REST DELETE /v1/memories/:id 同语义（softDeleteMemory + 向量 best-effort）。
    if (isV2Enabled(env)) {
      const namespace = toolNamespace() ?? "default";
      const existing = await getMemoryById(env.DB, { namespace, id });
      if (!existing || existing.status === "deleted") return toolError("Memory not found");
      const deleted = await softDeleteMemory(env.DB, { namespace, id });
      if (!deleted) return toolError("Memory not found");
      try {
        await deleteMemoryEmbedding(env, deleted);
      } catch (error) {
        console.error("mcp memory_delete: vector delete failed (D1 soft-deleted, vector may linger)", { id, error });
      }
      return textToolResult({ data: { id, deleted: true } });
    }

    await deleteVectorMemory(env, id);
    return textToolResult({
      data: {
        id,
        deleted: true
      }
    });
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
    const bootNamespace = resolveNamespace(profile, args.namespace);
    const pkg = await buildBootPackage(env, {
      namespace: bootNamespace
    });
    // Injection accounting moved out of buildBootPackage; schedule off response path.
    if (pkg.precious.length > 0) {
      ctx.waitUntil(
        markPreciousInjected(env.DB, {
          namespace: bootNamespace,
          ids: pkg.precious.map((p) => p.id)
        })
      );
    }
    return textToolResult({ data: pkg });
  }

  if (params.name === "memory_recall") {
    if (!hasScope(profile, "memory:read")) return toolError("Missing memory:read scope");
    if (!isV2Enabled(env)) return toolError("memory_recall requires MEMORY_LIFECYCLE_ENABLED=true");
    const query = readString(args.query);
    if (!query) return toolError("query is required");
    const result = await runRecall(env, {
      namespace: toolNamespace() ?? "default",
      query,
      k: readNumber(args.k, 20),
      min_score: typeof args.min_score === "number" ? readNumber(args.min_score, 0.15) : undefined,
      types: readStringArray(args.types),
      include_history: readBoolean(args.include_history, false)
    });
    return textToolResult({ data: result });
  }

  if (params.name === "memory_pin") {
    if (!hasScope(profile, "memory:write")) return toolError("Missing memory:write scope");
    if (!isV2Enabled(env)) return toolError("memory_pin requires MEMORY_LIFECYCLE_ENABLED=true");
    const content = readString(args.content);
    if (!content) return toolError("content is required");
    const precious = await createPrecious(env.DB, {
      namespace: toolNamespace() ?? "default",
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
      namespace: toolNamespace() ?? "default",
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
    // 四维/置信度入口校验（裁定 #2）：MCP 拒绝越界、不收敛，与旧版一致。
    for (const dim of ["importance", "confidence", "emotional", "recurrence", "unresolved"] as const) {
      if (args[dim] != null && !isValidRange(args[dim], 0, 1)) {
        return toolError(`${dim} must be between 0 and 1`);
      }
    }
    try {
      const result = await upsertMemoryByFactKey(env, {
        namespace: toolNamespace() ?? "default",
        factKey,
        content,
        type: readString(args.type) || "fact",
        importance: readNumber(args.importance, 0.6),
        confidence: readNumber(args.confidence, 0.8),
        emotional: readNumber(args.emotional, 0.0),
        recurrence: readNumber(args.recurrence, 0.0),
        unresolved: readNumber(args.unresolved, 0.0),
        tags: readStringArray(args.tags),
        source: readString(args.source) || "mcp",
        validAsOf: readString(args.valid_as_of),
        authoredBy: readString(args.authored_by) || null,
        responseTendency: readString(args.response_tendency) || null
      });
      return textToolResult({ data: result });
    } catch (error) {
      return toolError(error instanceof Error ? error.message : "memory_upsert failed");
    }
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
        namespace: toolNamespace() ?? "default",
        oldId,
        newContent,
        newType: readString(args.new_type) || "world_fact",
        newFactKey: readString(args.new_fact_key),
        validAsOf: readString(args.valid_as_of),
        reason: readString(args.reason),
        // MCP 走的是亲手通道：source 记 "mcp"，E 轴字段随之生效 (也能亲手 supersede 亲笔记忆)。
        source: "mcp",
        authoredBy: readString(args.authored_by) || null,
        responseTendency: readString(args.response_tendency) || null
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
      namespace: toolNamespace() ?? "default",
      id
    });
    if (!archived) return toolError("Memory not found");
    return textToolResult({ data: { id, archived: true } });
  }

  if (params.name === "baseline_change") {
    if (!hasScope(profile, "memory:write")) return toolError("Missing memory:write scope");
    const namespace = requireIdentity();
    if (!namespace) {
      return toolError("baseline_change requires an identity-bound MCP endpoint: use /mcp/<identity> (namespace is fixed by the URL, not by arguments)");
    }
    const op = readString(args.op);
    const reason = readString(args.reason);
    if (!op || !["add", "update", "delete"].includes(op)) {
      return toolError("op must be add, update, or delete");
    }
    if (!reason) return toolError("reason is required");
    const beforeContent = readString(args.before_content) ?? null;
    const afterContent = readString(args.after_content) ?? null;
    if (op === "add" && !afterContent) return toolError("add requires after_content");
    if (op === "update" && (!beforeContent || !afterContent)) return toolError("update requires before_content and after_content");
    if (op === "delete" && !beforeContent) return toolError("delete requires before_content");
    const row = await createBaselineChangelogEntry(env.DB, {
      namespace,
      op: op as "add" | "update" | "delete",
      beforeContent,
      afterContent,
      reason
    });
    return textToolResult({ data: row });
  }

  if (params.name === "digest_get" || params.name === "digest_set") {
    return toolError(
      `${params.name} is deprecated in v3; digest lives in the client system prompt. Use diary_get for daily_log.`
    );
  }

  if (params.name === "memory_extract_dryrun") {
    return toolError(
      "memory_extract_dryrun is deprecated in v3; extraction runs via the dream nightly pipeline. Use dream dry_run endpoints instead."
    );
  }

  if (params.name === "daily_log_read" || params.name === "diary_get") {
    if (!hasScope(profile, "memory:read")) return toolError("Missing memory:read scope");
    const namespace = requireIdentity();
    if (!namespace) {
      return toolError("daily_log_read requires an identity-bound MCP endpoint: use /mcp/<identity> (namespace is fixed by the URL, not by arguments)");
    }
    const timeZone = readDreamTimeZoneFromEnv(env);
    const week = readString(args.week);
    if (week && !/^\d{4}-W\d{2}$/.test(week)) {
      return toolError("week must be YYYY-Www (ISO week label)");
    }
    if (week) {
      const row = await getWeeklyLog(env.DB, { namespace, week });
      if (!row) return textToolResult({ data: null });
      return textToolResult({ data: withImpressionDisclaimer({ ...row }) });
    }
    const date = readString(args.date);
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return toolError("date must be YYYY-MM-DD");
    }
    if (date) {
      const row = await getDailyLog(env.DB, { namespace, date });
      if (row) return textToolResult({ data: withImpressionDisclaimer({ ...row }) });
      // 指定日期的日记已卷入周记时回退（上游 diary_get 能力）。
      const weekLabel = getIsoWeekLabelForDateLabel(date, timeZone);
      const weekly = await getWeeklyLog(env.DB, { namespace, week: weekLabel });
      if (!weekly) return textToolResult({ data: null });
      return textToolResult({ data: withImpressionDisclaimer({ ...weekly, note: "daily rolled into weekly" }) });
    }
    // 无 date 无 week：最近 N 个有记录日期（旧 daily_log_read 能力，向前翻页靠它）。
    const limit = readPositiveInt(args.limit, 7, 365);
    const rows = await listRecentDailyLogs(env.DB, { namespace, limit });
    return textToolResult({
      data: rows.map((row) => withImpressionDisclaimer({ ...row }))
    });
  }

  if (params.name === "daily_log_write") {
    if (!hasScope(profile, "memory:write")) return toolError("Missing memory:write scope");
    const namespace = requireIdentity();
    if (!namespace) {
      return toolError("daily_log_write requires an identity-bound MCP endpoint: use /mcp/<identity> (namespace is fixed by the URL, not by arguments)");
    }
    const timeZone = readDreamTimeZoneFromEnv(env);
    const date = formatDateLabel(new Date(), timeZone);
    const title = readString(args.title);
    if (!title) return toolError("title is required");
    if (title.length > 12) return toolError("title must be <= 12 characters");
    const newSummary = readString(args.summary) || "";
    if (newSummary.length > 800) return toolError("summary must be <= 800 characters");

    // 追加语义：今天已有日志时保留原标题，summary 追加不覆盖。
    const existing = await getDailyLog(env.DB, { namespace, date });
    let mergedTitle = title;
    let mergedSummary = newSummary;
    if (existing) {
      mergedTitle = existing.title || title;
      const existingSummary = (existing.summary || "").trim();
      const appendSummary = newSummary.trim();
      mergedSummary = existingSummary && appendSummary
        ? `${existingSummary}\n${appendSummary}`
        : existingSummary || appendSummary;
    }
    if (mergedSummary.length > 2000) {
      return toolError("merged summary exceeds 2000 characters; today's log is getting too long");
    }

    // Affect chord: new value replaces existing; omitting preserves existing (handled by COALESCE in DB layer)
    const affectChord = normalizeAffectChord(args.affect_chord);

    const log = await upsertDailyLog(env.DB, {
      namespace, date, title: mergedTitle, summary: mergedSummary, affectChord,
      sourceMessageIds: existing?.source_message_ids ?? []
    });
    return textToolResult({ data: log });
  }

  return toolError(`Unknown tool: ${String(params.name || "")}`);
}

async function handleRpc(
  request: JsonRpcRequest,
  env: Env,
  ctx: ExecutionContext,
  profile: KeyProfile,
  binding: McpNamespaceBinding
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
    const result = await callTool(env, ctx, profile, params, binding);
    return rpcResult(request.id, result);
  }

  if (request.method === "ping") {
    return rpcResult(request.id, {});
  }

  return rpcError(request.id, -32601, "Method not found");
}

export interface McpNamespaceBinding {
  /** identity 路由（/mcp/:identity）强制绑定的写入空间；null = 旧全局 /mcp 路径。 */
  namespace: string | null;
}

export async function handleMcp(request: Request, env: Env, ctx: ExecutionContext,
  identitySlug: string | null = null): Promise<Response> {
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

  // 方案 D：/mcp/:identity 从 Gateway identity 配置解析并强制绑定 namespace。
  // 模型侧工具不再接受 namespace 参数——归属由 URL 决定，传错必报错，不回退 default。
  // 注意不走 allowedIdentities（那要求 chat:proxy scope）；MCP 是记忆面，只按 key 成员匹配。
  let binding: McpNamespaceBinding = { namespace: null };
  if (identitySlug) {
    let config: GatewayConfig;
    try { config = await loadConfig(env); }
    catch { return rpcErrorResponse(null, -32002, "Gateway configuration unavailable. Apply migrations and check /admin.", 503); }
    const identity = config.identities.find(i => i.slug === identitySlug && i.keys.includes(auth.keyName));
    if (!identity) {
      return rpcErrorResponse(null, -32003,
        `No identity "${identitySlug}" available for this key. Configure /admin, then use /mcp/<identity>.`, 404);
    }
    binding = { namespace: identityNamespace(identity) };
  }

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
          .map((item) => handleRpc(item, env, ctx, auth.profile, binding))
      )
    ).filter((item): item is Record<string, unknown> => item !== null);
    return results.length > 0 ? json(results) : new Response(null, { status: 202 });
  }

  if (!isRecord(body)) return rpcErrorResponse(null, -32600, "Invalid Request", 400);

  const result = await handleRpc(body, env, ctx, auth.profile, binding);
  return result ? json(result) : new Response(null, { status: 202 });
}

function rpcErrorResponse(id: JsonRpcId | undefined, code: number, message: string, status: number): Response {
  return json(rpcError(id, code, message), { status });
}

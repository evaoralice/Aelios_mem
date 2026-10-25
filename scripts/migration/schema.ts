// =====================================================================
// P7 迁移预演 · 旧分支 schema 契约（只读工具，plan 工作包 P7）。
//
// 事实来源（冻结，不得随实现漂移）：
//   - docs/p0-schema-manifest.md（P0 字段对照与处置，§4 开放项）
//   - docs/p0-migration-acceptance.md（P0 §1 迁移前统计清单）
//   - 旧分支 fix/logic-review migrations/0001–0010（线上 D1 已应用的形状）
//
// 本模块只描述形状与分类，不连数据库、不写 SQL 迁移（P8 的 0018+/0021+ 另写）。
// 约束：
//   - 开放项 #1/#2/#3 没裁定的表/归属，本工具只统计、不映射、不猜测；
//   - 未知 role_scope 不猜去向，原样保留并计数入报告；
//   - 所有值只允许进入统计/哈希，不允许把正文带进报告（脱敏副本由 dbio 负责）。
// =====================================================================

// 旧分支 21 张表的期望列集（0001–0010 全量应用后的形状；顺序 = PRAGMA 预期顺序）。
export const OLD_TABLE_COLUMNS: Record<string, string[]> = {
  users: ["id", "display_name", "created_at", "updated_at"],
  conversations: ["id", "namespace", "title", "created_at", "updated_at", "role_id", "role_name"],
  messages: [
    "id", "conversation_id", "namespace", "role", "content", "source", "client_message_hash",
    "upstream_model", "upstream_provider", "request_model", "stream", "finish_reason",
    "token_input", "token_output", "cache_mode", "cache_ttl", "cache_hit",
    "cache_read_tokens", "cache_creation_tokens", "raw_usage_json", "created_at",
    "role_id", "role_name"
  ],
  memories: [
    "id", "namespace", "type", "content", "summary", "importance", "confidence", "status",
    "pinned", "tags", "source", "source_message_ids", "vector_id", "last_recalled_at",
    "recall_count", "created_at", "updated_at", "expires_at",
    "role_id", "role_name", "role_scope",
    "emotional", "recurrence", "unresolved", "weight"
  ],
  memory_events: ["id", "namespace", "event_type", "memory_id", "payload_json", "created_at"],
  summaries: [
    "id", "namespace", "conversation_id", "content", "from_message_id", "to_message_id",
    "message_count", "vector_id", "created_at", "updated_at"
  ],
  cache_entries: [
    "id", "namespace", "key", "value_json", "value_text", "content_type", "tags",
    "size_bytes", "expires_at", "created_at", "updated_at"
  ],
  processing_cursors: ["name", "value", "updated_at"],
  idempotency_keys: ["key", "task_type", "status", "created_at", "updated_at"],
  usage_logs: [
    "id", "message_id", "namespace", "provider", "model", "input_tokens", "output_tokens",
    "cache_read_tokens", "cache_creation_tokens", "cache_mode", "cache_ttl", "raw_usage_json",
    "created_at", "client_system_hash", "cache_anchor_block"
  ],
  memory_lifecycle: [
    "memory_id", "namespace", "fact_key", "supersedes_id", "superseded_by_id",
    "review_reason", "valid_as_of", "last_seen_at", "seen_count", "last_injected_at",
    "role_scope"
  ],
  digest: ["namespace", "content", "updated_at"],
  precious: [
    "id", "namespace", "content", "context_message_ids", "source", "pinned",
    "created_at", "last_injected_at", "status"
  ],
  glossary: [
    "id", "namespace", "term", "aliases", "definition", "examples", "status",
    "updated_at", "last_seen_at", "seen_count"
  ],
  longtail: ["id", "namespace", "content", "ts", "source_message_ids"],
  daily_log: ["namespace", "role_scope", "date", "title", "summary", "updated_at", "affect_chord"],
  memory_candidates: [
    "id", "namespace", "type", "content", "fact_key", "confidence", "importance", "tags",
    "source_message_ids", "source", "status", "target_memory_id", "decision_note",
    "created_at", "updated_at"
  ],
  memory_changelog: [
    "id", "namespace", "role_scope", "op", "target_id", "before_content", "after_content",
    "payload_json", "target_version", "reason", "role_id", "role_name", "created_at",
    "status", "error_message", "applied_at"
  ],
  long_term_baselines: ["namespace", "role_scope", "content", "version", "generated_at"],
  long_term_baseline_snapshots: [
    "id", "namespace", "role_scope", "version", "content", "created_at"
  ],
  baseline_changelog: [
    "id", "namespace", "role_scope", "op", "before_content", "after_content", "reason",
    "role_id", "role_name", "created_at", "status", "error_message", "applied_at"
  ]
};

// Cloudflare 管理的迁移账本（存在则读取，不在期望表集内做形状断言）。
export const D1_MIGRATIONS_TABLE = "d1_migrations";

// 脱敏副本中要掩码的正文列（2026-10-11 隐私收口复核后的分类）。
// 掩码 = 确定性 sha256 前缀（同值同掩码，保非空、保 NULL），同值关系不受影响，
// 去重/保真检查仍可用（掩码值前后一致即原值前后一致）。
// 收口新增（用户裁定）：daily_log.affect_chord、memory_lifecycle/memory_candidates 的
// fact_key、messages/usage_logs.raw_usage_json（载荷 JSON 可承载任意文本）、
// processing_cursors.value、idempotency_keys.key（运行时生成的任意串）。
// daily_log.affect_chord 不再例外保留：保真检查改验"确定性掩码值迁移前后一致"。
// 结构键（id/*_id/namespace/role_scope/role_id/role_name/date/status/op/type 等迁移
// 所需列）原样保留，否则映射统计与冲突清单就失真了。
export const CONTENT_COLUMNS: Record<string, string[]> = {
  users: ["display_name"],
  conversations: ["title"],
  messages: ["content", "source", "raw_usage_json"],
  memories: ["content", "summary", "tags", "source", "source_message_ids"],
  memory_events: ["payload_json"],
  summaries: ["content"],
  cache_entries: ["value_json", "value_text", "tags"],
  processing_cursors: ["value"],
  idempotency_keys: ["key"],
  usage_logs: ["raw_usage_json"],
  memory_lifecycle: ["fact_key", "review_reason"],
  digest: ["content"],
  precious: ["content", "context_message_ids"],
  glossary: ["term", "aliases", "definition", "examples"],
  longtail: ["content", "source_message_ids"],
  daily_log: ["title", "summary", "affect_chord"],
  memory_candidates: ["content", "tags", "source_message_ids", "decision_note", "fact_key"],
  memory_changelog: ["before_content", "after_content", "payload_json", "reason", "error_message"],
  long_term_baselines: ["content"],
  long_term_baseline_snapshots: ["content"],
  baseline_changelog: ["before_content", "after_content", "reason", "error_message"]
};

// —— 表分类（manifest §1/§2/§3 + 开放项） ——

// §1 既定映射：namespace 由本行 role_scope 决定（id:<id> / name:<名> / shared）。
export const SCOPE_MAPPED_TABLES = [
  "memories",
  "daily_log",
  "long_term_baselines",
  "long_term_baseline_snapshots",
  "baseline_changelog"
] as const;

// §3.2/§3.7：namespace 跟随对应 memories 行的新 namespace（memories 必须先迁）。
export const FOLLOW_MEMORY_TABLES = [
  { table: "memory_lifecycle", fkColumn: "memory_id" },
  { table: "memory_events", fkColumn: "memory_id" }
] as const;

// 开放项 #1：role-less 表，namespace 映射待用户按 identity 清单裁定（只统计 distinct）。
export const ROLE_LESS_TABLES = ["digest", "precious", "glossary", "longtail", "memory_candidates"] as const;

// 开放项 #2：消息/对话归属待裁定（只统计 role_id 非空计数，不动数据）。
export const PENDING_MESSAGE_TABLES = ["messages", "conversations"] as const;

// 开放项 #3：建议弃用，只迁行数与 status 分布入报告。
export const DEPRECATED_TABLES = [
  "users", "summaries", "cache_entries", "processing_cursors",
  "idempotency_keys", "memory_changelog"
] as const;

// manifest §3.7：usage_logs 原样迁移（不属于 role-less 开放项 #1，不做 namespace 映射）。
export const CARRY_VERBATIM_TABLES = ["usage_logs"] as const;

// 有 role_scope 列的表（报告 scope 分布；memory_changelog 有列但弃置候选，只统计不映射）。
export const ROLE_SCOPED_TABLES = [
  ...SCOPE_MAPPED_TABLES,
  "memory_lifecycle",
  "memory_changelog"
] as const;

// 指定做值分布统计的枚举列（状态/namespace 分布之外补充的低基数列）。
export const DISTRIBUTION_COLUMNS: Record<string, string[]> = {
  memories: ["status", "type", "pinned"],
  messages: ["role"],
  memory_candidates: ["status", "source"],
  memory_changelog: ["status", "op"],
  baseline_changelog: ["status", "op"],
  precious: ["status"],
  glossary: ["status"]
};

// —— 线上已应用迁移的期望（旧分支文件名）+ schema 签名 ——

export interface MigrationSignature {
  name: string;
  requires: { table: string; column?: string }[];
}

export const EXPECTED_OLD_MIGRATIONS: MigrationSignature[] = [
  { name: "0001_init.sql", requires: [{ table: "memories" }, { table: "messages" }, { table: "usage_logs" }] },
  { name: "0002_v4_assembler_cache.sql", requires: [{ table: "usage_logs", column: "client_system_hash" }] },
  { name: "0003_v2_memory_lifecycle.sql", requires: [{ table: "memory_lifecycle" }, { table: "digest" }, { table: "precious" }, { table: "glossary" }, { table: "longtail" }] },
  { name: "0004_v2_daily_log.sql", requires: [{ table: "daily_log" }] },
  { name: "0005_memory_candidates.sql", requires: [{ table: "memory_candidates" }] },
  { name: "0006_role_memory_baseline.sql", requires: [{ table: "memories", column: "role_scope" }, { table: "memory_changelog" }, { table: "long_term_baselines" }, { table: "long_term_baseline_snapshots" }] },
  { name: "0007_baseline_changelog.sql", requires: [{ table: "baseline_changelog" }] },
  { name: "0008_precious_soft_delete.sql", requires: [{ table: "precious", column: "status" }] },
  { name: "0009_daily_log_affect_chord.sql", requires: [{ table: "daily_log", column: "affect_chord" }] },
  { name: "0010_memory_weight_dimensions.sql", requires: [{ table: "memories", column: "weight" }] }
];

// E 轴（新分支 0011 authored_by / response_tendency）：旧库应缺失，P8 置 NULL 不伪造。
export const E_AXIS_COLUMNS = ["authored_by", "response_tendency"] as const;

// —— role_scope → namespace 既定映射（manifest §1，computeRoleScope 的逆） ——

export type ScopeKind = "id" | "name" | "shared" | "unknown";

export interface ScopeMapping {
  namespace: string | null; // null = 未知 scope，不猜去向（原样保留，入报告）
  kind: ScopeKind;
}

export function mapScopeToNamespace(roleScope: string): ScopeMapping {
  if (roleScope === "shared") return { namespace: "shared", kind: "shared" };
  if (roleScope.startsWith("id:")) {
    const value = roleScope.slice(3);
    return value ? { namespace: value, kind: "id" } : { namespace: null, kind: "unknown" };
  }
  if (roleScope.startsWith("name:")) {
    // 存储值在写入时已经 trim + NFKC（旧 computeRoleScope），这里只去前缀，不再归一。
    const value = roleScope.slice(5);
    return value ? { namespace: value, kind: "name" } : { namespace: null, kind: "unknown" };
  }
  return { namespace: null, kind: "unknown" };
}

// 映射后的"计划 namespace"：未知 scope 回退原 namespace 原样（不猜）。
export function plannedNamespace(roleScope: string, originalNamespace: string): string {
  const mapped = mapScopeToNamespace(roleScope);
  return mapped.namespace ?? originalNamespace;
}

// SQL 里的计划 namespace 表达式（统计/UPDATE/审计共用，防两处 CASE 漂移）。
export function mappedNamespaceSql(scopeExpr: string): string {
  return `CASE WHEN ${scopeExpr} = 'shared' THEN 'shared' WHEN ${scopeExpr} LIKE 'id:%' AND LENGTH(${scopeExpr}) > 3 THEN SUBSTR(${scopeExpr}, 4) WHEN ${scopeExpr} LIKE 'name:%' AND LENGTH(${scopeExpr}) > 5 THEN SUBSTR(${scopeExpr}, 6) ELSE NULL END`;
}

// 抽样哈希的行哈希不含 namespace 列（映射只改 namespace；namespace 的前后变化由
// 映射审计与 namespace 分布单独核对）。
export const HASH_EXCLUDED_COLUMNS = new Set(["namespace"]);

export const MASK_PREFIX = "«masked:";
export const MASK_SUFFIX = "»";
export const SAMPLE_SIZE_PER_TABLE = 25;
export const WEIGHT_MISMATCH_EPSILON = 1e-6;

// 隐私口径（2026-10-11 收口）：stdout 只打表名与数量；报告 JSON 含
// namespace/scope/冲突键等具体值，但报告与脱敏副本即使经过掩码仍属
// 本地敏感文件——不可提交仓库、不可外发（随每份报告落盘此标注）。
export const SENSITIVITY_NOTE =
  "副本与报告即使经确定性掩码仍属本地敏感文件：不得提交到仓库、不得通过任何渠道外发；处置完后可整体删除 .migration-work/";
-- ==== 0001_init ====
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  display_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL DEFAULT 'default',
  title TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  namespace TEXT NOT NULL DEFAULT 'default',
  role TEXT NOT NULL CHECK(role IN ('system','user','assistant','tool')),
  content TEXT NOT NULL,
  source TEXT,
  client_message_hash TEXT,
  upstream_model TEXT,
  upstream_provider TEXT,
  request_model TEXT,
  stream INTEGER NOT NULL DEFAULT 0,
  finish_reason TEXT,
  token_input INTEGER,
  token_output INTEGER,
  cache_mode TEXT,
  cache_ttl TEXT,
  cache_hit INTEGER,
  cache_read_tokens INTEGER,
  cache_creation_tokens INTEGER,
  raw_usage_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_created
ON messages(conversation_id, created_at);

CREATE INDEX IF NOT EXISTS idx_messages_namespace_created
ON messages(namespace, created_at);

CREATE INDEX IF NOT EXISTS idx_messages_hash
ON messages(client_message_hash);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL DEFAULT 'default',
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  summary TEXT,
  importance REAL NOT NULL DEFAULT 0.5,
  confidence REAL NOT NULL DEFAULT 0.8,
  status TEXT NOT NULL DEFAULT 'active',
  pinned INTEGER NOT NULL DEFAULT 0,
  tags TEXT,
  source TEXT,
  source_message_ids TEXT,
  vector_id TEXT,
  last_recalled_at TEXT,
  recall_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_memories_namespace_status
ON memories(namespace, status);

CREATE INDEX IF NOT EXISTS idx_memories_type
ON memories(type);

CREATE INDEX IF NOT EXISTS idx_memories_pinned
ON memories(pinned);

CREATE TABLE IF NOT EXISTS memory_events (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL DEFAULT 'default',
  event_type TEXT NOT NULL,
  memory_id TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS summaries (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL DEFAULT 'default',
  conversation_id TEXT,
  content TEXT NOT NULL,
  from_message_id TEXT,
  to_message_id TEXT,
  message_count INTEGER NOT NULL DEFAULT 0,
  vector_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cache_entries (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  key TEXT NOT NULL,
  value_json TEXT,
  value_text TEXT,
  content_type TEXT,
  tags TEXT,
  size_bytes INTEGER,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(namespace, key)
);

CREATE INDEX IF NOT EXISTS idx_cache_namespace_key
ON cache_entries(namespace, key);

CREATE INDEX IF NOT EXISTS idx_cache_expires
ON cache_entries(expires_at);

CREATE TABLE IF NOT EXISTS processing_cursors (
  name TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT PRIMARY KEY,
  task_type TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_logs (
  id TEXT PRIMARY KEY,
  message_id TEXT,
  namespace TEXT NOT NULL DEFAULT 'default',
  provider TEXT,
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_creation_tokens INTEGER,
  cache_mode TEXT,
  cache_ttl TEXT,
  raw_usage_json TEXT,
  created_at TEXT NOT NULL
);

-- ==== 0002_v4_assembler_cache ====
-- v4 assembler: track cache anchor metadata in usage_logs
-- These columns let us monitor Claude prompt cache hit rates per request.

ALTER TABLE usage_logs ADD COLUMN client_system_hash TEXT;
ALTER TABLE usage_logs ADD COLUMN cache_anchor_block TEXT;

-- ==== 0003_v2_memory_lifecycle ====
-- Aelios 记忆库 v2 (母帖 #11 第 1 步)
-- 全部用 CREATE TABLE IF NOT EXISTS，天生幂等。
-- 不动现有 memories 表 (不加列)——v2 字段进 memory_lifecycle 侧车表，
-- 靠 memory_id 关联。这样所有 fork 部署都不会因 ALTER ADD COLUMN 重复列炸。
-- 代码层默认读写这些 v2 表；只有 MEMORY_LIFECYCLE_ENABLED=false 才走旧路径。
--
-- L2 raw_messages 的口径：复用现有 messages 表 (0001 已建)，ts = created_at。
-- Vectorize 复用 memo-kb，用 metadata.kind 区分: memory | precious | longtail。

-- =====================================================================
-- L4 + L6 v2 字段侧车表 (不改 memories 本体)
-- =====================================================================
-- 一行对应一条 memories 记录的 v2 元数据。memory_id 关联 memories.id。
-- fact_key: 同一件事按 key upsert，从源头止增 (L4)
-- supersedes_id / superseded_by_id: world_fact 推翻链 (L6)
-- review_reason: doctor/patrol 提案理由
-- valid_as_of: world_fact 有效时点
-- last_seen_at / seen_count: 命中计数
-- last_injected_at: 闸三节奏，近期注入过的降权 (不动 importance)
--
-- fact_key 语义：status 在 memories 表，跨表 partial unique SQLite 做不到，
-- 因此侧车表只建普通索引，靠应用层 (upsertMemoryByFactKey 先查 active
-- 对应的侧车行再写) 保证同一 namespace + fact_key 的 active 语义。
-- 这是为了 fork 安全 (ALTER ADD COLUMN 不幂等) 主动让出的 DB 层硬约束。
CREATE TABLE IF NOT EXISTS memory_lifecycle (
  memory_id TEXT NOT NULL,
  namespace TEXT NOT NULL DEFAULT 'default',
  fact_key TEXT,
  supersedes_id TEXT,
  superseded_by_id TEXT,
  review_reason TEXT,
  valid_as_of TEXT,
  last_seen_at TEXT,
  seen_count INTEGER NOT NULL DEFAULT 0,
  last_injected_at TEXT,
  PRIMARY KEY (memory_id)
);

-- fact_key upsert 查询用 (应用层先查再写，这个索引加速查 active 同 key)
CREATE INDEX IF NOT EXISTS idx_lifecycle_namespace_factkey
ON memory_lifecycle(namespace, fact_key) WHERE fact_key IS NOT NULL;

-- supersede 链查询用
CREATE INDEX IF NOT EXISTS idx_lifecycle_supersedes
ON memory_lifecycle(supersedes_id) WHERE supersedes_id IS NOT NULL;

-- =====================================================================
-- L1 摘要 (单行覆盖，每 namespace 一行)
-- =====================================================================
CREATE TABLE IF NOT EXISTS digest (
  namespace TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- =====================================================================
-- L3 珍贵记录 (打标，含上下文，豁免去重/衰减/删)
-- =====================================================================
CREATE TABLE IF NOT EXISTS precious (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL DEFAULT 'default',
  content TEXT NOT NULL,
  context_message_ids TEXT,          -- JSON 数组，单拎一句以后看不懂
  source TEXT NOT NULL DEFAULT 'human',  -- human | secretary
  pinned INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  last_injected_at TEXT              -- 闸三节奏，珍贵也记，防复读
);

CREATE INDEX IF NOT EXISTS idx_precious_namespace_created
ON precious(namespace, created_at);

CREATE INDEX IF NOT EXISTS idx_precious_pinned
ON precious(pinned);

-- =====================================================================
-- L5 黑话 glossary (词面召回，不进向量库)
-- 第 1 步精确/子串匹配；BM25/FTS5 留到后续召回管线升级。
-- =====================================================================
CREATE TABLE IF NOT EXISTS glossary (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL DEFAULT 'default',
  term TEXT NOT NULL,
  aliases TEXT,                      -- JSON 数组
  definition TEXT NOT NULL,
  examples TEXT,                     -- JSON 数组
  status TEXT NOT NULL DEFAULT 'active',
  updated_at TEXT NOT NULL,
  last_seen_at TEXT,
  seen_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_glossary_namespace_status
ON glossary(namespace, status);

CREATE INDEX IF NOT EXISTS idx_glossary_term
ON glossary(namespace, term);

-- =====================================================================
-- L6 长尾收容所 (raw 删除前的遗物，只在前面全空时兜底)
-- =====================================================================
CREATE TABLE IF NOT EXISTS longtail (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL DEFAULT 'default',
  content TEXT NOT NULL,
  ts TEXT NOT NULL,
  source_message_ids TEXT            -- JSON 数组
);

CREATE INDEX IF NOT EXISTS idx_longtail_namespace_ts
ON longtail(namespace, ts);

-- ==== 0004_v2_daily_log ====
-- Aelios 记忆库 v2 (母帖 #11 第 4 步)
-- 昨天日志：dream 每天跑完写一条，boot 冷启动取"昨天"那条。
-- 单独放 0004：0003 已在部分环境成功记录，不能再往已应用迁移里追加表。

CREATE TABLE IF NOT EXISTS daily_log (
  namespace TEXT NOT NULL,
  date TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (namespace, date)
);

-- ==== 0005_memory_candidates ====
-- Aelios memory review candidates.
-- Low-confidence extraction output lands here first so the admin review queue
-- can approve, edit, discard, or merge candidates before they become memory.

CREATE TABLE IF NOT EXISTS memory_candidates (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL DEFAULT 'default',
  type TEXT NOT NULL DEFAULT 'note',
  content TEXT NOT NULL,
  fact_key TEXT,
  confidence REAL NOT NULL DEFAULT 0.5,
  importance REAL NOT NULL DEFAULT 0.5,
  tags TEXT,
  source_message_ids TEXT,
  source TEXT NOT NULL DEFAULT 'extract',
  status TEXT NOT NULL DEFAULT 'pending',
  target_memory_id TEXT,
  decision_note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_candidates_namespace_status
ON memory_candidates(namespace, status, created_at);

CREATE INDEX IF NOT EXISTS idx_memory_candidates_fact_key
ON memory_candidates(namespace, fact_key) WHERE fact_key IS NOT NULL;

-- ==== 0006_role_memory_baseline ====
-- 0006_role_memory_baseline.sql
-- Aelios 角色记忆 + 长期基线
-- ⚠️ daily_log 表迁移涉及 DROP TABLE + RENAME，执行前请先备份：
--   wrangler d1 export companion_memory_proxy --output backup.sql
-- D1 迁移不支持事务，DROP 后 RENAME 前中断会丢数据。

-- === 1. memories 表加角色字段 ===
ALTER TABLE memories ADD COLUMN role_id TEXT;
ALTER TABLE memories ADD COLUMN role_name TEXT;
ALTER TABLE memories ADD COLUMN role_scope TEXT NOT NULL DEFAULT 'shared';

CREATE INDEX IF NOT EXISTS idx_memories_role_scope
ON memories(namespace, role_scope, status);

-- === 2. messages 表加角色标签 ===
ALTER TABLE messages ADD COLUMN role_id TEXT;
ALTER TABLE messages ADD COLUMN role_name TEXT;

CREATE INDEX IF NOT EXISTS idx_messages_role_created
ON messages(namespace, role_id, created_at);

-- === 3. conversations 表加角色标签 ===
ALTER TABLE conversations ADD COLUMN role_id TEXT;
ALTER TABLE conversations ADD COLUMN role_name TEXT;

-- === 4. memory_lifecycle 加 role_scope（必须在索引之前）===
ALTER TABLE memory_lifecycle ADD COLUMN role_scope TEXT NOT NULL DEFAULT 'shared';

CREATE INDEX IF NOT EXISTS idx_lifecycle_role_fact
ON memory_lifecycle(namespace, role_scope, fact_key);

-- === 5. daily_log 重建为含 role_scope ===
-- 原 PK: (namespace, date) → 新 PK: (namespace, role_scope, date)
CREATE TABLE IF NOT EXISTS daily_log_v2 (
  namespace TEXT NOT NULL,
  role_scope TEXT NOT NULL DEFAULT 'shared',
  date TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (namespace, role_scope, date)
);

INSERT INTO daily_log_v2 (namespace, role_scope, date, title, summary, updated_at)
  SELECT namespace, 'shared', date, title, summary, updated_at FROM daily_log;

DROP TABLE daily_log;
ALTER TABLE daily_log_v2 RENAME TO daily_log;

-- === 6. 长期基线表 ===
CREATE TABLE IF NOT EXISTS memory_changelog (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  role_scope TEXT NOT NULL DEFAULT 'shared',
  op TEXT NOT NULL,
  target_id TEXT,
  before_content TEXT,
  after_content TEXT,
  payload_json TEXT NOT NULL,
  target_version TEXT,
  reason TEXT,
  role_id TEXT,
  role_name TEXT,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  error_message TEXT,
  applied_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_changelog_namespace_role_status
ON memory_changelog(namespace, role_scope, status, created_at);

CREATE TABLE IF NOT EXISTS long_term_baselines (
  namespace TEXT NOT NULL,
  role_scope TEXT NOT NULL DEFAULT 'shared',
  content TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  generated_at TEXT NOT NULL,
  PRIMARY KEY (namespace, role_scope)
);

CREATE TABLE IF NOT EXISTS long_term_baseline_snapshots (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  role_scope TEXT NOT NULL,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
-- ==== 0007_baseline_changelog ====
-- 0007_baseline_changelog.sql
-- baseline pending 机制：模型对话中提交角色长期印象（baseline）的增删改，
-- 做梦时统一合并应用。独立于 memory_changelog（原子记忆 pending）。

CREATE TABLE IF NOT EXISTS baseline_changelog (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  role_scope TEXT NOT NULL,
  op TEXT NOT NULL,              -- "add" | "update" | "delete"
  before_content TEXT,           -- 要修改/删除的原文片段（add 时为 null）
  after_content TEXT,            -- 修改后的文本（delete 时为 null）
  reason TEXT NOT NULL,          -- 模型解释为什么要改
  role_id TEXT,
  role_name TEXT,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | applied | conflict
  error_message TEXT,
  applied_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_baseline_changelog_ns_scope_status
ON baseline_changelog(namespace, role_scope, status, created_at);
-- ==== 0008_precious_soft_delete ====
-- 给 precious 加 status 字段，支持软删除（替代硬删 DELETE）。
-- 现有数据默认 active，不影响当前查询结果。
-- 注意：D1 ALTER TABLE 不支持 IF NOT EXISTS，此迁移只能跑一次。

ALTER TABLE precious ADD COLUMN status TEXT NOT NULL DEFAULT 'active';

CREATE INDEX IF NOT EXISTS idx_precious_namespace_status
ON precious(namespace, status);
-- ==== 0009_daily_log_affect_chord ====
-- Add affect_chord column to daily_log for chord-based emotion anchors.
-- Stores a single chord-progression line (e.g. "Fmaj9 → C/E → Am add9 → G6sus4 · 60bpm")
-- that captures the affective temperature of the day. Nullable; most days won't have one.

ALTER TABLE daily_log ADD COLUMN affect_chord TEXT;

-- ==== 0010_memory_weight_dimensions ====
-- Add multi-dimensional weight system to memories.
-- Four dimensions (0-1 float): importance (existing), emotional, recurrence, unresolved.
-- weight = importance*0.35 + emotional*0.25 + recurrence*0.25 + unresolved*0.15, normalized to 0-1.
-- Computed at write time and stored for efficient querying.

ALTER TABLE memories ADD COLUMN emotional REAL NOT NULL DEFAULT 0.0;
ALTER TABLE memories ADD COLUMN recurrence REAL NOT NULL DEFAULT 0.0;
ALTER TABLE memories ADD COLUMN unresolved REAL NOT NULL DEFAULT 0.0;
ALTER TABLE memories ADD COLUMN weight REAL NOT NULL DEFAULT 0.0;

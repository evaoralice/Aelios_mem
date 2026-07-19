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
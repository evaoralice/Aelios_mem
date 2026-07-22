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
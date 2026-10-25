-- =====================================================================
-- P8 · 0023 baseline 三表重建 + memory_changelog 弃置（plan 工作包 P8）
--
-- 线上同库升级专用（见 0021 头注释）。线上这三张表是旧 0006/0007 的
-- role_scope 形状；新分支 0017 的 CREATE TABLE IF NOT EXISTS 在线上是**静默
-- no-op**（表已存在，形状不合），这是 P8 必须显式重建的原因（代码证据：
-- 旧 0006 建 long_term_baselines PK(namespace, role_scope)，新 0017 期望
-- namespace 单主键）。这里按新 0017 的目标 DDL 逐字重建：
--   long_term_baselines          PK(namespace)，无 role 维度
--   long_term_baseline_snapshots 无 role_scope
--   baseline_changelog           op/status CHECK，无 role 三列
-- 并补建 0017 的两个索引（0017 在线上建到了旧表上，随旧表一起消失）。
--
-- namespace 按 role_scope 既定映射（CASE = mappedNamespaceSql，同 0021）。
-- content/version/generated_at/created_at 及 op/reason/status/error_message/
-- applied_at 全部原样携带。撞主键 fail-loud（orchestrator 预检
-- computeBaselineConflicts 非空即拒绝）。
--
-- memory_changelog（旧 0006，原子记忆 pending，工具已停用，实库 0 行）
-- 2026-10-24 裁定明确弃用：不迁移数据，整表移除（新分支无此表）。
-- =====================================================================

-- 1. long_term_baselines：PK (namespace, role_scope) → namespace 单主键
CREATE TABLE long_term_baselines_p8 (
  namespace TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  generated_at TEXT NOT NULL
);

INSERT INTO long_term_baselines_p8 (namespace, content, version, generated_at)
SELECT CASE
  WHEN role_scope = 'shared' THEN 'shared'
  WHEN role_scope LIKE 'id:%' AND LENGTH(role_scope) > 3 THEN SUBSTR(role_scope, 4)
  WHEN role_scope LIKE 'name:%' AND LENGTH(role_scope) > 5 THEN SUBSTR(role_scope, 6)
  ELSE NULL
END AS namespace,
  content, version, generated_at
FROM long_term_baselines;

DROP TABLE long_term_baselines;
ALTER TABLE long_term_baselines_p8 RENAME TO long_term_baselines;

-- 2. long_term_baseline_snapshots：去 role_scope
CREATE TABLE long_term_baseline_snapshots_p8 (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);

INSERT INTO long_term_baseline_snapshots_p8 (id, namespace, version, content, created_at)
SELECT id, CASE
  WHEN role_scope = 'shared' THEN 'shared'
  WHEN role_scope LIKE 'id:%' AND LENGTH(role_scope) > 3 THEN SUBSTR(role_scope, 4)
  WHEN role_scope LIKE 'name:%' AND LENGTH(role_scope) > 5 THEN SUBSTR(role_scope, 6)
  ELSE NULL
END AS namespace,
  version, content, created_at
FROM long_term_baseline_snapshots;

DROP TABLE long_term_baseline_snapshots;
ALTER TABLE long_term_baseline_snapshots_p8 RENAME TO long_term_baseline_snapshots;

CREATE INDEX IF NOT EXISTS idx_baseline_snapshots_namespace_created
ON long_term_baseline_snapshots(namespace, created_at);

-- 3. baseline_changelog：op/status 进 CHECK，去 role 三列（op/before/after/reason/
--    status/error_message/applied_at 原样；值域外数据由 orchestrator 预检拒绝）
CREATE TABLE baseline_changelog_p8 (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  op TEXT NOT NULL CHECK (op IN ('add', 'update', 'delete')),
  before_content TEXT,
  after_content TEXT,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'conflict')),
  error_message TEXT,
  applied_at TEXT
);

INSERT INTO baseline_changelog_p8
  (id, namespace, op, before_content, after_content, reason, created_at, status, error_message, applied_at)
SELECT id, CASE
  WHEN role_scope = 'shared' THEN 'shared'
  WHEN role_scope LIKE 'id:%' AND LENGTH(role_scope) > 3 THEN SUBSTR(role_scope, 4)
  WHEN role_scope LIKE 'name:%' AND LENGTH(role_scope) > 5 THEN SUBSTR(role_scope, 6)
  ELSE NULL
END AS namespace,
  op, before_content, after_content, reason, created_at, status, error_message, applied_at
FROM baseline_changelog;

DROP TABLE baseline_changelog;
ALTER TABLE baseline_changelog_p8 RENAME TO baseline_changelog;

CREATE INDEX IF NOT EXISTS idx_baseline_changelog_namespace_status
ON baseline_changelog(namespace, status, created_at);

-- 4. memory_changelog 弃置（实库 0 行；行数已由 orchestrator 记录进报告）
DROP TABLE memory_changelog;

-- 记账：与上面语句同一事务（wrangler d1 execute --file 整文件单事务；
-- 本地离线 orchestrator 同样整文件单事务）。
-- 部署链按账本跳过已成功步骤（构建中断恢复不重复执行）。
INSERT INTO d1_migrations (name) VALUES ('0023_p8_baselines_rebuild.sql');

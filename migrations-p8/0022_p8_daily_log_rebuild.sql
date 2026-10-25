-- =====================================================================
-- P8 · 0022 daily_log 重建（plan 工作包 P8）
--
-- 线上同库升级专用（见 0021 头注释）。线上 daily_log 是旧 0006 重建后的
-- 形状：PK (namespace, role_scope, date) + affect_chord（旧 0009）。
-- 新分支目标形状 = 0004 + 0013（source_message_ids）+ 0019（affect_chord）：
--   PK (namespace, date)，无 role 维度。0013 已在账本阶段加过 source_message_ids
-- （线上顺序里 0013 先于本文件），但旧表带着 role_scope 的 PK 无法就地改，
-- 只能重建。source_message_ids 置 NULL（旧日记无来源标注，不伪造）。
--
-- namespace 按 role_scope 既定映射（CASE = mappedNamespaceSql，同 0021）。
-- 冲突语义：多个旧键映到同一 (namespace, date) 时 INSERT 违反主键 → fail-loud，
-- 不静默合并/覆盖；orchestrator 预检（P7 的 computeDailyLogConflicts）发现
-- 冲突清单非空会直接拒绝执行。
-- =====================================================================

CREATE TABLE daily_log_p8 (
  namespace TEXT NOT NULL,
  date TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  source_message_ids TEXT,
  affect_chord TEXT,
  PRIMARY KEY (namespace, date)
);

INSERT INTO daily_log_p8 (namespace, date, title, summary, updated_at, affect_chord)
SELECT CASE
  WHEN role_scope = 'shared' THEN 'shared'
  WHEN role_scope LIKE 'id:%' AND LENGTH(role_scope) > 3 THEN SUBSTR(role_scope, 4)
  WHEN role_scope LIKE 'name:%' AND LENGTH(role_scope) > 5 THEN SUBSTR(role_scope, 6)
  ELSE NULL
END AS namespace,
  date, title, summary, updated_at, affect_chord
FROM daily_log;

DROP TABLE daily_log;
ALTER TABLE daily_log_p8 RENAME TO daily_log;

-- 记账：与上面语句同一事务（wrangler d1 execute --file 整文件单事务；
-- 本地离线 orchestrator 同样整文件单事务）。
-- 部署链按账本跳过已成功步骤（构建中断恢复不重复执行）。
INSERT INTO d1_migrations (name) VALUES ('0022_p8_daily_log_rebuild.sql');

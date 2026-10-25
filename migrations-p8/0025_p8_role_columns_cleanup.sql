-- =====================================================================
-- P8 · 0025 role 列收尾清除（plan 工作包 P8）
--
-- 线上同库升级专用（见 0021 头注释）。前面 0021–0024 已把 role_scope /
-- role_id 的信息折算进新 namespace，旧 role 列在新分支不存在（manifest §3.1/
-- §3.3"转换后弃置"）。本文件把旧 0006 加的列从线上表里移除，使升级后的
-- 表结构与全新部署（migrations/0001–0020）逐列一致：
--   memories          掉 role_id / role_name / role_scope（先掉旧 0006 的
--                     idx_memories_role_scope——SQLite 对被索引列 DROP COLUMN 拒绝）
--   messages          掉 role_id / role_name（先掉 idx_messages_role_created）
--   conversations     掉 role_id / role_name（无 role 索引）
--   memory_lifecycle  掉 role_scope（先掉 idx_lifecycle_role_fact）
-- daily_log / baseline 三表已在 0022/0023 整表重建，无 role 列残留。
--
-- 注意：memories 的列顺序与全新部署不同（同库升级走 DROP/ADD，新 0007/0011
-- 的列追加在旧 0010 四维列之后）——列集合与约束一致，顺序差异是同库升级
-- 路径的预期结果；新分支代码全部按列名访问，不做位置依赖。
-- 失败语义：任一 DROP 失败整文件回滚、中止升级（不产生半清除状态）。
-- =====================================================================

DROP INDEX IF EXISTS idx_memories_role_scope;
ALTER TABLE memories DROP COLUMN role_scope;
ALTER TABLE memories DROP COLUMN role_id;
ALTER TABLE memories DROP COLUMN role_name;

DROP INDEX IF EXISTS idx_messages_role_created;
ALTER TABLE messages DROP COLUMN role_id;
ALTER TABLE messages DROP COLUMN role_name;

ALTER TABLE conversations DROP COLUMN role_id;
ALTER TABLE conversations DROP COLUMN role_name;

DROP INDEX IF EXISTS idx_lifecycle_role_fact;
ALTER TABLE memory_lifecycle DROP COLUMN role_scope;

-- 记账：与上面语句同一事务（wrangler d1 execute --file 整文件单事务；
-- 本地离线 orchestrator 同样整文件单事务）。
-- 部署链按账本跳过已成功步骤（构建中断恢复不重复执行）。
INSERT INTO d1_migrations (name) VALUES ('0025_p8_role_columns_cleanup.sql');

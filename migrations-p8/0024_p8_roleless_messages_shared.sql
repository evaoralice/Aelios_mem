-- =====================================================================
-- P8 · 0024 role-less 表归 shared + 消息/对话归属 + 游标弃置（P8）
--
-- 线上同库升级专用（见 0021 头注释）。本文件只做已裁定（2026-10-24）的数据处置：
--
--   1. role-less 五表 digest/precious/glossary/longtail/memory_candidates
--      统一先归入 `shared`（用户裁定；迁移后可按实际角色手动调整）。
--      digest 的主键就是 namespace——多 distinct namespace 会撞主键 fail-loud，
--      orchestrator 预检发现 digest 多 namespace 直接拒绝执行。
--   2. summaries：实库 1 条非空摘要（覆盖 362 条消息）原样迁移并归入
--      `shared`（用户裁定）。表形状两侧同构（0001），只动 namespace。
--   3. messages/conversations：有 role_id 时跟随角色映射（role_id 即新
--      namespace，manifest §3.3"id:<role_id>→新 namespace"）；无 role_id
--      保留旧 namespace 原值（宁可见性沉默，不丢归属）。
--      client_message_hash 已由新 0010 置 NULL、seq 已由新 0015 按 role
--      回填（user=0/assistant=1/其他=2），本文件不重复处理。
--   4. processing_cursors：224 条旧运行状态游标不迁移（用户裁定，迁入陈旧
--      游标可能在复用时错误跳过任务）。线上同库路径上"不迁移"=清空该表，
--      数量由 orchestrator 记录进报告。
--
-- usage_logs/users/cache_entries/idempotency_keys 原样保留（含 0002 两列），
-- 本文件不触碰。
-- =====================================================================

-- 1. role-less 五表 → shared（裁定 2026-10-24）
UPDATE digest SET namespace = 'shared';
UPDATE precious SET namespace = 'shared';
UPDATE glossary SET namespace = 'shared';
UPDATE longtail SET namespace = 'shared';
UPDATE memory_candidates SET namespace = 'shared';

-- 2. summaries → shared（裁定 2026-10-24）
UPDATE summaries SET namespace = 'shared';

-- 3. 消息/对话归属（裁定 2026-10-24：有 role_id 跟随角色，无 role_id 保留旧值）
UPDATE messages SET namespace = role_id WHERE role_id IS NOT NULL AND namespace <> role_id;
UPDATE conversations SET namespace = role_id WHERE role_id IS NOT NULL AND namespace <> role_id;

-- 4. 旧运行游标不迁移（数量已记录进报告）
DELETE FROM processing_cursors;

-- 记账：与上面语句同一事务（wrangler d1 execute --file 整文件单事务；
-- 本地离线 orchestrator 同样整文件单事务）。
-- 部署链按账本跳过已成功步骤（构建中断恢复不重复执行）。
INSERT INTO d1_migrations (name) VALUES ('0024_p8_roleless_messages_shared.sql');

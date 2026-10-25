-- =====================================================================
-- P8 · 0021 memories 与侧车数据迁移（plan 工作包 P8）
--
-- 适用对象：**只**用于"线上同库升级"路径——源库 = feat/memory-dimensions
-- 导出（旧 0001–0010 已应用），且新分支 0006–0017 已按账本顺序应用、
-- 0018–0020 已由账本引导标记跳过（同构列已存在）。全新部署不播放本目录
-- （migrations/ 才是部署序列；本目录 SQL 引用的 role_scope 列在全新库不存在，
-- 会 fail-loud，这是有意设计，防止误播）。
--
-- 本文件做（schema manifest §3.1/§3.2/§3.7）：
--   1. memories.namespace ← role_scope 既定映射（shared / id:% / name:%）。
--      CASE 表达式 = scripts/migration/schema.ts 的 mappedNamespaceSql（单一来源，
--      迁移后由 orchestrator 的 namespace 审计对账防漂移）。
--      未知 role_scope 的行**不在**本语句命中范围（ELSE NULL），orchestrator
--      预检发现未知 scope 会拒绝执行（不猜去向）。
--   2. memories.superseded_by 从旧 memory_lifecycle.superseded_by_id 回填
--      （新 0007 只回填 fact_key/version_status，不回填这一列）。
--   3. memory_lifecycle 孤儿行删除（2026-10-24 裁定：只进报告，不迁入目标侧车；
--      行数由 orchestrator 在删除前记录进报告）。
--   4. memory_lifecycle.namespace 跟随对应 memories 行（迁移顺序 memories 先行）。
--   5. memory_events.namespace 跟随对应 memories 行；孤儿事件保留原 namespace
--      并由 orchestrator 报告（manifest §3.7）。
--
-- weight / 四维 / importance（含超界值）原样不动；E 轴 authored_by /
-- response_tendency 保持 0007/0011 建列后的 NULL（旧无来源，不伪造）。
-- 失败语义：离线 orchestrator 以单文件事务播放；线上由 npm run deploy 的
-- setup 阶段（scripts/p8-deploy.mjs）按序自动播放——wrangler d1 execute
-- --file 整文件单事务，任一语句失败整文件回滚、中止构建（不部署 Worker）；
-- 记账 INSERT 在文件末尾，与数据变更同事务，构建中断重跑按账本跳过本文件。
-- =====================================================================

-- 1. memories namespace ← role_scope 既定映射
UPDATE memories
SET namespace = CASE
  WHEN role_scope = 'shared' THEN 'shared'
  WHEN role_scope LIKE 'id:%' AND LENGTH(role_scope) > 3 THEN SUBSTR(role_scope, 4)
  WHEN role_scope LIKE 'name:%' AND LENGTH(role_scope) > 5 THEN SUBSTR(role_scope, 6)
  ELSE NULL
END
WHERE CASE
  WHEN role_scope = 'shared' THEN 'shared'
  WHEN role_scope LIKE 'id:%' AND LENGTH(role_scope) > 3 THEN SUBSTR(role_scope, 4)
  WHEN role_scope LIKE 'name:%' AND LENGTH(role_scope) > 5 THEN SUBSTR(role_scope, 6)
  ELSE NULL
END IS NOT NULL
  AND namespace <> CASE
  WHEN role_scope = 'shared' THEN 'shared'
  WHEN role_scope LIKE 'id:%' AND LENGTH(role_scope) > 3 THEN SUBSTR(role_scope, 4)
  WHEN role_scope LIKE 'name:%' AND LENGTH(role_scope) > 5 THEN SUBSTR(role_scope, 6)
  ELSE NULL
END;

-- 2. memories.superseded_by 从侧车回填（manifest §3.1；对齐 0007 的回填口径但补齐 0007 没做的这一列）
UPDATE memories
SET superseded_by = (
  SELECT l.superseded_by_id FROM memory_lifecycle l WHERE l.memory_id = memories.id
)
WHERE superseded_by IS NULL
  AND EXISTS (
    SELECT 1 FROM memory_lifecycle l
    WHERE l.memory_id = memories.id AND l.superseded_by_id IS NOT NULL
  );

-- 3. 孤儿侧车不迁入目标（裁定 2026-10-24；数量已由 orchestrator 记录进报告）
DELETE FROM memory_lifecycle
WHERE NOT EXISTS (SELECT 1 FROM memories m WHERE m.id = memory_lifecycle.memory_id);

-- 4. 侧车 namespace 跟随 memories（此时已无孤儿行，全部能对上）
UPDATE memory_lifecycle
SET namespace = (SELECT m.namespace FROM memories m WHERE m.id = memory_lifecycle.memory_id)
WHERE EXISTS (SELECT 1 FROM memories m WHERE m.id = memory_lifecycle.memory_id)
  AND namespace <> (SELECT m.namespace FROM memories m WHERE m.id = memory_lifecycle.memory_id);

-- 5. 事件 namespace 跟随 memories；孤儿事件不动（保留原 namespace，orchestrator 报告）
UPDATE memory_events
SET namespace = (SELECT m.namespace FROM memories m WHERE m.id = memory_events.memory_id)
WHERE EXISTS (SELECT 1 FROM memories m WHERE m.id = memory_events.memory_id)
  AND namespace <> (SELECT m.namespace FROM memories m WHERE m.id = memory_events.memory_id);

-- 记账：与上面语句同一事务（wrangler d1 execute --file 整文件单事务；
-- 本地离线 orchestrator 同样整文件单事务）。
-- 部署链按账本跳过已成功步骤（构建中断恢复不重复执行）。
INSERT INTO d1_migrations (name) VALUES ('0021_p8_memories_and_sidecars.sql');

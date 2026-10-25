-- P5-B · precious 软删除 status 列（plan 工作包 P5-B）。
-- 与旧分支 fix/logic-review 的 0008_precious_status.sql 同构（行为模板 = ee71f87 + 4d2b87b）：
--   status TEXT NOT NULL DEFAULT 'active' + idx_precious_namespace_status。
-- 语义：deletePrecious = UPDATE status='deleted'（行保留，供迁移/核查/恢复），
--   读路径（getPreciousById / listPrecious）只见 active；INSERT 不显式写 status 走 DEFAULT。
-- 与 0018/0019 同为裸 ALTER：本分支序列只在新库播放；线上旧库的旧 0008 已带同名列，
-- 禁止在新库播放旧号（schema manifest 头部规则），旧值由 P8 原样迁入（0021+，值域 active/deleted）。
-- 存量行由 ADD COLUMN 的 DEFAULT 'active' 回填（与 glossary 0003 同款模式）。

ALTER TABLE precious ADD COLUMN status TEXT NOT NULL DEFAULT 'active';

CREATE INDEX IF NOT EXISTS idx_precious_namespace_status
ON precious(namespace, status);
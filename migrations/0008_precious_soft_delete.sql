-- 给 precious 加 status 字段，支持软删除（替代硬删 DELETE）。
-- 现有数据默认 active，不影响当前查询结果。
-- 注意：D1 ALTER TABLE 不支持 IF NOT EXISTS，此迁移只能跑一次。

ALTER TABLE precious ADD COLUMN status TEXT NOT NULL DEFAULT 'active';

CREATE INDEX IF NOT EXISTS idx_precious_namespace_status
ON precious(namespace, status);
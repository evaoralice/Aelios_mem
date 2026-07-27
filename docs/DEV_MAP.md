# Aelios 开发者地图

> 改代码之前先查这份文档：找到要改的功能 → 定位文件 → 看影响范围。
> 最后更新：2026-07-27（含多角色记忆 + baseline pending 改造）

---

## 一、按功能找文件

| 我想改… | 主文件 | 可能连带影响 |
|---------|--------|-------------|
| 聊天接口行为 | `api/chatCompletions.ts` | 流式处理 `proxy/stream*.ts`、记忆注入 `memory/inject.ts`、角色解析 `utils/roleContext.ts` |
| 记忆召回/注入 | `memory/v2/recall.ts` | 过滤 `memory/filter.ts`、搜索 `memory/search.ts`、embedding `memory/embedding.ts`、角色加权 `utils/role.ts` |
| 记忆提取（4h cron） | `memory/extractPipeline.ts` | 数据层 `db/v2.ts`、embedding `memory/embedding.ts`、向量库 `memory/vectorStore.ts`、角色继承 `utils/role.ts` |
| 做梦/每晚整理 | `memory/dailyDigest.ts` | 数据层 `db/v2.ts`、`db/memories.ts`、搜索 `memory/search.ts`、向量库 `memory/vectorStore.ts`、角色分组 `utils/role.ts` |
| 记忆淘汰/过期/硬删除 | `memory/retention.ts` | 数据层 `db/retention.ts` |
| 记忆合并/取代 | `memory/merge.ts` | 数据层 `db/v2.ts`、`db/memories.ts`、embedding `memory/embedding.ts` |
| 记忆过滤/压缩 | `memory/filter.ts` | 被 `memory/v2/recall.ts` 和 API 调用 |
| prompt 拼装 | `assembler/blocks.ts` | 类型定义 `assembler/types.ts`、历史预处理 `preset/historyPreprocess.ts` |
| 缓存断点策略 | `proxy/anthropicAdapter.ts` | 格式转换 `assembler/toAnthropic.ts`、类型 `assembler/types.ts` |
| 管理面板页面 | `api/admin.ts` | 无依赖（独立 HTML） |
| MCP 工具 | `api/mcp.ts` | 数据层 `db/v2.ts`、`db/memories.ts`、搜索/过滤/导出、角色 `utils/role.ts` |
| token 认证/权限 | `auth/apiKey.ts` + `auth/scopes.ts` | 所有 `api/*.ts` 都依赖它 |
| 环境变量定义 | `types.ts` | 几乎所有文件 |
| 路由/cron 定义 | `index.ts` | — |
| 数据库表结构 | `migrations/*.sql` | 对应的 `db/*.ts` 文件 |
| **角色 scope 计算** | `utils/role.ts` | `chatCompletions`、`mcp`、`db/v2`、`extractPipeline`、`dailyDigest`、`recall` |
| **Operit 角色标记解析** | `utils/roleContext.ts` | `chatCompletions` |
| **baseline pending** | `db/v2.ts`(CRUD) + `mcp.ts`(工具) + `dailyDigest.ts`(合并) | `chatCompletions`(注入) |
| **baseline 文本注入** | `assembler/types.ts`(formatBootStable) + `memory/v2/recall.ts`(buildBootPackage) | `blocks.ts` |
| **Vectorize 角色元数据** | `memory/vectorStore.ts` | `search.ts`、`extractPipeline`、`dailyDigest` |
| **Vectorize 回填脚本** | `scripts/backfill-vectorize-role.mjs` | 独立脚本 |

---

## 二、按文件看影响范围

### 改了这个文件，谁会受影响？

#### 核心层（改了影响面最大，务必谨慎）

| 文件 | 用途 | 被谁依赖 |
|------|------|---------|
| `types.ts` | 全局类型 + Env 定义 | **几乎所有文件** |
| `memory/v2/recall.ts` | V2 召回管线 + BootPackage + 角色加权 | `chatCompletions`、`memories API`、`mcp`、`assembler`、`anthropicAdapter`、`extractPipeline`、`dailyDigest`、`maintenance`、`queue/producer` |
| `db/v2.ts` | V2 数据层（digest/precious/glossary/longtail/候选/fact_key/changelog/baselines） | `memories API`、`mcp`、`extractPipeline`、`dailyDigest`、`merge`、`search`、`recall` |
| `memory/embedding.ts` | 向量嵌入（创建/更新/删除） | `debug`、`db/v2`、`search`、`merge`、`vectorStore`、`extractPipeline`、`export`、`recall` |
| `proxy/openaiAdapter.ts` | OpenAI 兼容 API 调用 + pending 注入 | `chatCompletions`、`guideDog`、`anthropicAdapter`、`extract`、`extractPipeline`、`merge`、`filter`、`dailyDigest`、`embedding` |
| `utils/role.ts` | role_scope 计算 + 角色开关 | `chatCompletions`、`mcp`、`db/v2`、`extractPipeline`、`dailyDigest`、`recall` |

#### API 层

| 文件 | 用途 | 被谁依赖 |
|------|------|---------|
| `api/chatCompletions.ts` | 聊天主接口（角色解析 + pending 加载 + 记忆注入） | `index.ts` |
| `api/memories.ts` | 记忆 REST API | `index.ts` |
| `api/mcp.ts` | MCP 工具（含 baseline_change、memory_context） | `index.ts` |
| `api/admin.ts` | 管理面板 HTML | `index.ts`（无其他依赖） |
| `api/cache.ts` | KV 缓存 API | `index.ts` |
| `api/debug.ts` | 调试端点 | `index.ts` |
| `api/guideDog.ts` | 导盲犬接口 | `index.ts` |
| `api/health.ts` | 健康检查 | `index.ts` |
| `api/models.ts` | 模型列表 | `index.ts` |

#### Assembler 层

| 文件 | 用途 | 被谁依赖 |
|------|------|---------|
| `assembler/types.ts` | 块定义、排序常量、格式化函数（含 baseline 渲染、PendingChange 类型） | `blocks`、`assemble`、`toAnthropic`、`toOpenAI`、`anthropicAdapter`、`openaiAdapter` |
| `assembler/blocks.ts` | prompt 块内容生成 + 缓存断点计算 | `assemble` |
| `assembler/assemble.ts` | 拼装入口（含 tool 消息透传） | `chatCompletions` |
| `assembler/toAnthropic.ts` | 转 Anthropic 格式（含 synthetic tool call） | `anthropicAdapter`、`toolAdapters` |
| `assembler/toOpenAI.ts` | 转 OpenAI 格式（含 tool_calls 透传） | `openaiAdapter` |

#### 记忆层

| 文件 | 用途 | 被谁依赖 |
|------|------|---------|
| `memory/search.ts` | 向量 + 文本搜索 | `memories API`、`mcp`、`stablePack`、`merge`、`export`、`dailyDigest`、`recall` |
| `memory/filter.ts` | reranker + 压缩 | `memories API`、`mcp`、`recall` |
| `memory/inject.ts` | 提取用户文本、格式化补丁 | `chatCompletions`、`memories API` |
| `memory/extract.ts` | LLM 记忆提取（v1） | `maintenance`、`extractPipeline`（类型）、`dailyDigest`（类型） |
| `memory/extractPipeline.ts` | V2 定时提取管线（含角色继承） | `index.ts` |
| `memory/dailyDigest.ts` | 做梦/整理（含角色分组 + pending 应用 + baseline 合并） | `index.ts`、`memories API` |
| `memory/retention.ts` | 淘汰/清理 | `index.ts`、`queue/consumer` |
| `memory/merge.ts` | 合并/取代 | `maintenance` |
| `memory/maintenance.ts` | 增量维护 | `queue/consumer` |
| `memory/stablePack.ts` | 稳定记忆包（legacy） | `anthropicAdapter` |
| `memory/vectorStore.ts` | Vectorize CRUD（含 role_scope 元数据） | `debug`、`mcp`、`extractPipeline`、`dailyDigest` |
| `memory/export.ts` | 批量导出 | `memories API`、`mcp` |

#### 数据库层

| 文件 | 用途 | 被谁依赖 |
|------|------|---------|
| `db/memories.ts` | 记忆 CRUD | `memories API`、`mcp`、`stablePack`、`merge`、`search`、`export`、`dailyDigest`、`maintenance`、`vectorStore` |
| `db/messages.ts` | 消息存取（含 role_id/role_name） | `chatCompletions`、`memories API`、`mcp`、`extractPipeline`、`dailyDigest`、`maintenance`、`stream*` |
| `db/conversations.ts` | 会话管理（含角色分开 conversation） | `chatCompletions`、`memories API`、`mcp`、`maintenance` |
| `db/usageLogs.ts` | 用量日志 | `chatCompletions`、`stream*` |
| `db/retention.ts` | 清理查询 | `retention`、`extractPipeline`、`dailyDigest` |
| `db/cacheEntries.ts` | KV 缓存 | `cache API` |
| `db/idempotency.ts` | 幂等键 | `maintenance` |

#### 工具层

| 文件 | 用途 | 被谁依赖 |
|------|------|---------|
| `utils/role.ts` | computeRoleScope + isRoleMemoryEnabled | `chatCompletions`、`mcp`、`db/v2`、`extractPipeline`、`dailyDigest`、`recall` |
| `utils/roleContext.ts` | Operit 角色标记解析 | `chatCompletions` |
| `utils/json.ts` | 响应工具 | 大部分 `api/*.ts`、`auth/scopes` |
| `utils/ids.ts` | ID 生成 | 大部分 `db/*.ts`、部分 `memory/*` |
| `utils/time.ts` | 时间工具 | 大部分 `db/*.ts`、部分 `memory/*` |

#### 其他

| 文件 | 用途 | 被谁依赖 |
|------|------|---------|
| `auth/apiKey.ts` | token 认证 | 所有 `api/*.ts` |
| `auth/scopes.ts` | 权限校验 | 大部分 `api/*.ts` |
| `config/keyProfiles.ts` | key 权限定义 | `auth/apiKey`、`guideDog` |
| `queue/producer.ts` | 入队 | `chatCompletions`、`memories API`、`mcp`、`stream*` |
| `queue/consumer.ts` | 消费队列 | `index.ts`、`producer` |
| `proxy/streamAnthropic.ts` | Anthropic 流式（含 role 传递 + tool_call 处理） | `chatCompletions` |
| `proxy/streamOpenAI.ts` | OpenAI 流式（含 role 传递 + tool_call 处理） | `chatCompletions` |

---

## 三、常见修改场景的检查清单

### 改记忆召回逻辑
- [ ] `memory/v2/recall.ts` — 主逻辑 + 角色加权 + BootPackage
- [ ] `memory/filter.ts` — 如果改了过滤/压缩
- [ ] `memory/search.ts` — 如果改了搜索
- [ ] `assembler/blocks.ts` — 如果改了注入格式
- [ ] `utils/role.ts` — 如果改了角色加权逻辑
- [ ] 验证：`node scripts/verify-cache-strategy.mjs` + `npx vitest run`

### 改缓存策略
- [ ] `proxy/anthropicAdapter.ts` — 断点逻辑 + pending 注入
- [ ] `assembler/types.ts` — 块顺序、锚点定义、formatBootStable
- [ ] `assembler/blocks.ts` — 块内容 + 断点计算
- [ ] `assembler/toAnthropic.ts` — 格式转换 + synthetic tool call
- [ ] 验证：`node scripts/verify-cache-strategy.mjs`

### 改做梦/整理流程
- [ ] `memory/dailyDigest.ts` — 主逻辑 + 角色分组 + pending 应用 + baseline 合并
- [ ] `db/v2.ts` — 如果改了数据写入（daily_log/baseline/changelog）
- [ ] `memory/v2/recall.ts` — 如果改了 BootPackage 内容
- [ ] `assembler/types.ts` — 如果改了 `formatBootStable`
- [ ] `utils/role.ts` — 如果改了角色分组逻辑
- [ ] 验证：`npx vitest run test/multirole/`

### 改记忆淘汰规则
- [ ] `memory/retention.ts` — 时间常量、流程
- [ ] `db/retention.ts` — SQL 查询
- [ ] `scripts/verify-assembler.mjs` — 镜像常量和断言

### 改认证/权限
- [ ] `auth/apiKey.ts` — token 匹配逻辑
- [ ] `auth/scopes.ts` — scope 校验
- [ ] `config/keyProfiles.ts` — 各 key 的权限定义
- [ ] 影响所有 `api/*.ts` 端点

### 改 prompt 拼装
- [ ] `assembler/blocks.ts` — 各块内容
- [ ] `assembler/types.ts` — 块顺序、类型定义、PendingChange
- [ ] `assembler/assemble.ts` — tool 消息透传逻辑
- [ ] `proxy/anthropicAdapter.ts` — 如果影响缓存锚点或 pending 注入
- [ ] `proxy/openaiAdapter.ts` — OpenAI 路径的 pending 注入
- [ ] 验证：`node scripts/verify-cache-strategy.mjs`、`node scripts/verify-assembler.mjs`

### 改角色记忆相关
- [ ] `utils/role.ts` — role_scope 计算
- [ ] `utils/roleContext.ts` — Operit 标记解析
- [ ] `db/v2.ts` — role_scope 隔离的 SQL（upsertMemoryByFactKey、supersedeMemory、changelog、baselines）
- [ ] `memory/vectorStore.ts` — Vectorize metadata 中的 role_scope
- [ ] `memory/v2/recall.ts` — 角色加权 + baseline 加载
- [ ] `memory/dailyDigest.ts` — 角色分组整理 + baseline 合并
- [ ] `api/chatCompletions.ts` — 角色提取 + pending 加载
- [ ] `api/mcp.ts` — baseline_change 工具 + 角色参数
- [ ] 验证：`npx vitest run test/multirole/` + `npx vitest run test/utils/`

### 改 MCP 工具
- [ ] `api/mcp.ts` — getTools() 定义 + callTool() 处理
- [ ] `db/v2.ts` — 如果工具调用了新的数据库函数
- [ ] `utils/role.ts` — 如果涉及角色参数
- [ ] 验证：`npx vitest run test/multirole/phaseD/`

### 改 baseline pending
- [ ] `db/v2.ts` — baseline_changelog CRUD（create/list/markApplied/markConflict/markError）
- [ ] `api/mcp.ts` — baseline_change 工具定义 + 校验
- [ ] `memory/dailyDigest.ts` — applyBaselineChanges 合并逻辑
- [ ] `api/chatCompletions.ts` — pending 加载
- [ ] `proxy/anthropicAdapter.ts` + `proxy/openaiAdapter.ts` — pending 注入格式
- [ ] `assembler/types.ts` — PendingChange 类型
- [ ] 验证：`npx vitest run test/multirole/p0/baselinePending`

### 改数据库表结构
- [ ] `migrations/` — 新增迁移文件
- [ ] `db/` 下对应表名的文件 — 更新 SQL
- [ ] 所有引用该 db 文件的上层模块
- [ ] 部署：`npm run deploy:cloudflare`（会自动跑迁移）
- [ ] ⚠️ D1 ALTER TABLE 不支持 IF NOT EXISTS，迁移只能跑一次

---

## 四、数据库表对照

| 表 | 主要操作文件 | migration |
|------|------------|-----------|
| memories | `db/memories.ts`、`db/v2.ts` | 0001、0006（加 role） |
| messages | `db/messages.ts` | 0001、0006（加 role） |
| conversations | `db/conversations.ts` | 0001、0006（加 role） |
| memory_lifecycle | `db/v2.ts` | 0003、0006（加 role_scope） |
| daily_log | `db/v2.ts` | 0004、0006（重建加 role_scope） |
| digest | `db/v2.ts` | 0003 |
| precious | `db/v2.ts` | 0003 |
| glossary | `db/v2.ts` | 0003 |
| longtail | `db/v2.ts` | 0003 |
| memory_candidates | `db/v2.ts` | 0003 |
| memory_changelog | `db/v2.ts` | 0006 |
| long_term_baselines | `db/v2.ts` | 0006 |
| long_term_baseline_snapshots | `db/v2.ts` | 0006 |
| baseline_changelog | `db/v2.ts` | 0007 |
| cache_entries | `db/cacheEntries.ts` | 0001 |
| usage_logs | `db/usageLogs.ts` | 0001、0002 |
| processing_cursors | `db/retention.ts` | 0001 |
| idempotency_keys | `db/idempotency.ts` | 0001 |

---

## 五、验证命令速查

| 改了什么 | 跑什么验证 |
|---------|-----------|
| 缓存/assembler 相关 | `node scripts/verify-cache-strategy.mjs` |
| 记忆/淘汰/assembler 相关 | `node scripts/verify-assembler.mjs` |
| 提取管线 | `node scripts/verify-extract-pipeline.mjs` |
| 多角色/baseline/做梦 | `npx vitest run test/multirole/` |
| Operit 标记解析 | `npx vitest run test/utils/roleContext.test.ts` |
| tool_call 透传 | `npx vitest run test/assembler/` |
| 类型安全 | `npx tsc --noEmit` |
| 全量测试 | `npx vitest run && node scripts/verify-assembler.mjs && node scripts/verify-cache-strategy.mjs` |

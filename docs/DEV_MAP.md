# Aelios 开发者地图

> 改代码之前先查这份文档：找到要改的功能 → 定位文件 → 看影响范围。

---

## 一、按功能找文件

| 我想改… | 主文件 | 可能连带影响 |
|---------|--------|-------------|
| 聊天接口行为 | `api/chatCompletions.ts` | 流式处理 `proxy/stream*.ts`、记忆注入 `memory/inject.ts` |
| 记忆召回/注入 | `memory/v2/recall.ts` | 过滤 `memory/filter.ts`、搜索 `memory/search.ts`、embedding `memory/embedding.ts` |
| 记忆提取（4h cron） | `memory/extractPipeline.ts` | 数据层 `db/v2.ts`、embedding `memory/embedding.ts`、向量库 `memory/vectorStore.ts` |
| 做梦/每晚整理 | `memory/dailyDigest.ts` | 数据层 `db/v2.ts`、`db/memories.ts`、搜索 `memory/search.ts`、向量库 `memory/vectorStore.ts` |
| 记忆淘汰/过期/硬删除 | `memory/retention.ts` | 数据层 `db/retention.ts` |
| 记忆合并/取代 | `memory/merge.ts` | 数据层 `db/v2.ts`、`db/memories.ts`、embedding `memory/embedding.ts` |
| 记忆过滤/压缩 | `memory/filter.ts` | 被 `memory/v2/recall.ts` 和 API 调用 |
| prompt 拼装（9块） | `assembler/blocks.ts` | 类型定义 `assembler/types.ts`、历史预处理 `preset/historyPreprocess.ts` |
| 缓存断点策略 | `proxy/anthropicAdapter.ts` | 格式转换 `assembler/toAnthropic.ts`、类型 `assembler/types.ts` |
| 管理面板页面 | `api/admin.ts` | 无依赖（独立 HTML） |
| MCP 工具 | `api/mcp.ts` | 数据层 `db/v2.ts`、`db/memories.ts`、搜索/过滤/导出 |
| token 认证/权限 | `auth/apiKey.ts` + `auth/scopes.ts` | 所有 `api/*.ts` 都依赖它 |
| 环境变量定义 | `types.ts` | 几乎所有文件 |
| 路由/cron 定义 | `index.ts` | — |
| 数据库表结构 | `migrations/*.sql` | 对应的 `db/*.ts` 文件 |

---

## 二、按文件看影响范围

### 改了这个文件，谁会受影响？

#### 核心层（改了影响面最大，务必谨慎）

| 文件 | 用途 | 被谁依赖 |
|------|------|---------|
| `types.ts` | 全局类型 + Env 定义 | **几乎所有文件** |
| `memory/v2/recall.ts` | V2 召回管线 + BootPackage | `chatCompletions`、`memories API`、`mcp`、`assembler`、`anthropicAdapter`、`extractPipeline`、`dailyDigest`、`maintenance`、`queue/producer` |
| `db/v2.ts` | V2 数据层（digest/precious/glossary/longtail/候选/fact_key） | `memories API`、`mcp`、`extractPipeline`、`dailyDigest`、`merge`、`search`、`recall` |
| `memory/embedding.ts` | 向量嵌入（创建/更新/删除） | `debug`、`db/v2`、`search`、`merge`、`vectorStore`、`extractPipeline`、`export`、`recall` |
| `proxy/openaiAdapter.ts` | OpenAI 兼容 API 调用 | `chatCompletions`、`guideDog`、`anthropicAdapter`、`extract`、`extractPipeline`、`merge`、`filter`、`dailyDigest`、`embedding` |

#### API 层

| 文件 | 用途 | 被谁依赖 |
|------|------|---------|
| `api/chatCompletions.ts` | 聊天主接口 | `index.ts` |
| `api/memories.ts` | 记忆 REST API | `index.ts` |
| `api/mcp.ts` | MCP 工具 | `index.ts` |
| `api/admin.ts` | 管理面板 HTML | `index.ts`（无其他依赖） |
| `api/cache.ts` | KV 缓存 API | `index.ts` |
| `api/debug.ts` | 调试端点 | `index.ts` |
| `api/guideDog.ts` | 导盲犬接口 | `index.ts` |
| `api/health.ts` | 健康检查 | `index.ts` |
| `api/models.ts` | 模型列表 | `index.ts` |

#### Assembler 层

| 文件 | 用途 | 被谁依赖 |
|------|------|---------|
| `assembler/types.ts` | 块定义、排序常量、格式化函数 | `blocks`、`assemble`、`toAnthropic`、`toOpenAI`、`anthropicAdapter`、`openaiAdapter` |
| `assembler/blocks.ts` | 9 块内容生成 | `assemble` |
| `assembler/assemble.ts` | 拼装入口 | `chatCompletions` |
| `assembler/toAnthropic.ts` | 转 Anthropic 格式 | `anthropicAdapter`、`toolAdapters` |
| `assembler/toOpenAI.ts` | 转 OpenAI 格式 | `openaiAdapter` |

#### 记忆层

| 文件 | 用途 | 被谁依赖 |
|------|------|---------|
| `memory/search.ts` | 向量 + 文本搜索 | `memories API`、`mcp`、`stablePack`、`merge`、`export`、`dailyDigest`、`recall` |
| `memory/filter.ts` | reranker + 压缩 | `memories API`、`mcp`、`recall` |
| `memory/inject.ts` | 提取用户文本、格式化补丁 | `chatCompletions`、`memories API` |
| `memory/extract.ts` | LLM 记忆提取（v1） | `maintenance`、`extractPipeline`（类型）、`dailyDigest`（类型） |
| `memory/extractPipeline.ts` | V2 定时提取管线 | `index.ts` |
| `memory/dailyDigest.ts` | 做梦/整理 | `index.ts`、`memories API` |
| `memory/retention.ts` | 淘汰/清理 | `index.ts`、`queue/consumer` |
| `memory/merge.ts` | 合并/取代 | `maintenance` |
| `memory/maintenance.ts` | 增量维护 | `queue/consumer` |
| `memory/stablePack.ts` | 稳定记忆包（legacy） | `anthropicAdapter` |
| `memory/vectorStore.ts` | Vectorize CRUD | `debug`、`mcp`、`extractPipeline`、`dailyDigest` |
| `memory/export.ts` | 批量导出 | `memories API`、`mcp` |

#### 数据库层

| 文件 | 用途 | 被谁依赖 |
|------|------|---------|
| `db/memories.ts` | 记忆 CRUD | `memories API`、`mcp`、`stablePack`、`merge`、`search`、`export`、`dailyDigest`、`maintenance`、`vectorStore` |
| `db/messages.ts` | 消息存取 | `chatCompletions`、`memories API`、`mcp`、`extractPipeline`、`dailyDigest`、`maintenance`、`stream*` |
| `db/conversations.ts` | 会话管理 | `chatCompletions`、`memories API`、`mcp`、`maintenance` |
| `db/usageLogs.ts` | 用量日志 | `chatCompletions`、`stream*` |
| `db/retention.ts` | 清理查询 | `retention`、`extractPipeline`、`dailyDigest` |
| `db/cacheEntries.ts` | KV 缓存 | `cache API` |
| `db/idempotency.ts` | 幂等键 | `maintenance` |

#### 其他

| 文件 | 用途 | 被谁依赖 |
|------|------|---------|
| `auth/apiKey.ts` | token 认证 | 所有 `api/*.ts` |
| `auth/scopes.ts` | 权限校验 | 大部分 `api/*.ts` |
| `config/keyProfiles.ts` | key 权限定义 | `auth/apiKey`、`guideDog` |
| `queue/producer.ts` | 入队 | `chatCompletions`、`memories API`、`mcp`、`stream*` |
| `queue/consumer.ts` | 消费队列 | `index.ts`、`producer` |
| `utils/json.ts` | 响应工具 | 大部分 `api/*.ts`、`auth/scopes` |
| `utils/ids.ts` | ID 生成 | 大部分 `db/*.ts`、部分 `memory/*` |
| `utils/time.ts` | 时间工具 | 大部分 `db/*.ts`、部分 `memory/*` |

---

## 三、常见修改场景的检查清单

### 改记忆召回逻辑
- [ ] `memory/v2/recall.ts` — 主逻辑
- [ ] `memory/filter.ts` — 如果改了过滤/压缩
- [ ] `memory/search.ts` — 如果改了搜索
- [ ] `assembler/blocks.ts` — 如果改了注入格式（dynamic_memory_patch 块）
- [ ] 验证：`node scripts/verify-cache-strategy.mjs`

### 改缓存策略
- [ ] `proxy/anthropicAdapter.ts` — 断点逻辑
- [ ] `assembler/types.ts` — 块顺序、锚点定义
- [ ] `assembler/blocks.ts` — 块内容
- [ ] `assembler/toAnthropic.ts` — 格式转换
- [ ] 验证：`node scripts/verify-cache-strategy.mjs`

### 改做梦/整理流程
- [ ] `memory/dailyDigest.ts` — 主逻辑
- [ ] `db/v2.ts` — 如果改了数据写入
- [ ] `memory/v2/recall.ts` — 如果改了 BootPackage 内容
- [ ] `assembler/types.ts` — 如果改了 `formatBootStable`

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
- [ ] `assembler/types.ts` — 块顺序、类型定义
- [ ] `proxy/anthropicAdapter.ts` — 如果影响缓存锚点
- [ ] 验证：`node scripts/verify-cache-strategy.mjs`、`node scripts/verify-assembler.mjs`

### 改数据库表结构
- [ ] `migrations/` — 新增迁移文件
- [ ] `db/` 下对应表名的文件 — 更新 SQL
- [ ] 所有引用该 db 文件的上层模块
- [ ] 部署：`npm run deploy:cloudflare`（会自动跑迁移）

---

## 四、验证命令速查

| 改了什么 | 跑什么验证 |
|---------|-----------|
| 缓存/assembler 相关 | `node scripts/verify-cache-strategy.mjs` |
| 记忆/淘汰/assembler 相关 | `node scripts/verify-assembler.mjs` |
| 提取管线 | `node scripts/verify-extract-pipeline.mjs` |
| 类型安全 | `npx tsc --noEmit` |
| 全量测试 | `npm run worker:test` |

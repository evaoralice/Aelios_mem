# P5 旧修复兼容审计（fix/logic-review → integration/upstream-v2）

> 方法：只读考古。旧分支五组修复逐项对照当前工作树（P0–P4 已完成）的行为证据，
> 结论分三类：**上游已替代 / 仍缺 / 明确不要**。本包不改任何代码；
> 仍缺项拆成独立实现包（§7），只登记建议触点、测试与优先级。
> 证据格式：`旧分支 commit`（fix/logic-review）+ 当前文件:行号（工作树）。
> 本文同时是 P0 schema manifest 开放项 #4/#5 的裁定依据（见 §6）。

## 0. 结论总表

| # | 审计项 | 旧修复出处 | 当前分支状态 | 结论 |
|---|---|---|---|---|
| 1a | memories MCP `memory_delete` 软删 | 4cc0263 | 仍走 `deleteMemoryV2` 硬删 | **仍缺**（P5-A） |
| 1b | memories REST 删除软删 | （上游自有） | `softDeleteMemory` + FTS/向量清理 | 上游已替代 |
| 1c | precious 软删（status 列） | ee71f87 + 0008 + 4d2b87b | 表无 status 列，REST/MCP 全硬删 | **仍缺**（P5-B，P8 前置） |
| 2a | retention 尊重最近召回时间 | 4882057 (P0-4) | `expireOldMemories` 无 last_recalled_at 条件 | **仍缺**（P5-C，P8 前置） |
| 2b | retention 软删策略（硬删闸门） | 4882057 (P0-3) | 无 MEMORY_AUTO_DELETE 闸门，窗口 30 天无条件物理删 | **仍缺**（P5-C，P8 前置） |
| 2c | 硬删连带 lifecycle 侧车 | 4882057 (P0-3) | `hardDeleteMemoriesBatch` 不清 memory_lifecycle | **仍缺**（并入 P5-C） |
| 3 | filter 失败不落 longtail | 78e2a7e (P2-7) | recall 丢弃 filter meta，失败后仍落 longtail | **仍缺**（P5-D） |
| 4a | 易变时间行移出缓存前缀 | 3e37fb3 (P1-5) | 新架构不重组客户端 system，注入全在客户端锚点之后 | 上游架构已替代 |
| 4b | tail 断点 block_index 失配回退 | dc2afc5 (P1-6) | 服务端断点机器不存在；`lastCacheableBlock` 本就是尾搜式 | 上游架构已替代 |
| 5a | CORS 白名单中间件 | 77e25c0 | 全库无任何 CORS 头逻辑 | **仍缺**（P5-E） |
| 5b | noindex/nofollow | 89c2240 | 无 x-robots-tag、无 meta robots | **仍缺**（P5-F） |
| 5c | workers_dev / preview_urls 关闭 | 5920dd6 + 43dbb4d | `workers_dev=false`、`preview_urls=false` | **已落地**（P5-G，2026-10-25 用户裁定） |

## 1. precious 与普通记忆软删除

### 1.1 普通记忆（memories）

**旧行为**（4cc0263，2026-08-08）：MCP `memory_delete` 从 `deleteMemoryV2`（硬删 D1+向量）
改为 `softDeleteMemory`（status='deleted'，行保留可恢复）+ `deleteVectorMemory` best-effort
（向量删除失败只记日志，D1 已软删不影响主流程）。动机：模型经 MCP 删除不应物理毁行，
与 REST 对齐。

**当前状态**：
- REST：`DELETE /v1/memories/:id` 已是软删（`src/api/memories.ts:1112` 调 `softDeleteMemory`，
  `src/db/memories.ts:350` 置 status='deleted'；`updateMemory` 对 inactive 行顺手清 memory_fts，
  `src/db/memories.ts:336`）。**上游已替代**，与旧分支语义一致且多做了 FTS 清理。
- MCP：`memory_delete` 仍走 `deleteMemoryV2` 硬删（`src/api/mcp.ts:728-748`；
  `src/db/v2/memories.ts:765-798` 物理 DELETE memories + memory_lifecycle + memory_fts，
  向量先删、失败保 D1 tombstone）。上游虽然补了 `memory_archive`（"不确定时优先归档"），
  但 `memory_delete` 一旦被模型调用就是物理毁行——**旧修复丢失，仍缺**。

**已落地（2026-10-11，P5-A）**：MCP `memory_delete` v2 改 `softDeleteMemory` +
  向量 best-effort（与 REST 同款），验收 `tests/mcp-soft-delete.test.ts` 4 用例；
  详见 plan P5-A 完成 banner。

**裁定**：P5-A 恢复软删。注意上游 tombstone 语义（向量删失败返回 false）与软删并不冲突：
软删后 search 层按 status='active' 过滤（`searchMemoriesByText`、
`searchMemoriesWithProvenance` 均只取 active），残留向量不会被复活，
与旧分支"向量删除失败只记日志"的容错等价。

### 1.2 precious（珍贵记录）

**旧行为**（ee71f87 + 4d2b87b）：0008 迁移加 `status TEXT NOT NULL DEFAULT 'active'` +
`idx_precious_namespace_status` 索引；`deletePrecious` = `UPDATE SET status='deleted' WHERE
status='active'`；`getPreciousById`/`listPrecious` 过滤 `status='active'`；4d2b87b 让 INSERT
不显式写 status（走 D1 DEFAULT）。

**当前状态**：precious 表无 status 列（0003 建表即无，P0–P4 未补）；
`src/db/v2/precious.ts:87` `deletePrecious` 是 `DELETE FROM` 硬删；读路径无 status 过滤；
REST `DELETE /v1/precious/:id`（`src/api/memories.ts:613`）直接调它。
MCP 面没有 precious 删除工具（`memory_pin` 只增），所以暴露面只有 REST/admin。

**裁定**：**仍缺**。线上旧库 0008 已应用（值域 active/deleted），存在带 'deleted' 的历史行；
P8 迁移需要落点。对应 schema manifest 开放项 #4 的"仍缺"分支（§6 落账）。
**已落地（2026-10-11，P5-B）**：`0020_precious_status.sql` + `src/db/v2/precious.ts` 软删，
验收 `tests/precious-softdelete.test.ts` 6 用例；详见 plan P5-B 完成 banner。

## 2. retention 对软删除和最近召回时间的处理

**旧行为**（4882057，P0-3/P0-4，2026-08-28）：
- P0-4：`expireOldMemories` 要求 `updated_at < cutoff` **且** `(last_recalled_at IS NULL OR
  last_recalled_at < cutoff)`——每天被召回的记忆不因没人编辑 180 天而过期。
- P0-3：cron 硬删 gated behind `MEMORY_AUTO_DELETE`（Env 声明、默认 off = 只报
  `hardDeleteCandidates` 不删）；窗口 365 天；`hardDeleteMemoriesBatch` 连带删
  memory_lifecycle 侧车。动机原文："data policy is soft-delete everywhere —
  externally soft-deleted memories must not be silently physically destroyed by a
  background job"。

**当前状态**（上游 v2 重写后）：
- `expireOldMemories` **丢掉了 last_recalled_at 条件**（`src/db/retention.ts:101-140`，
  只看 updated_at）。召回记账（`markMemoriesRecalled`，`src/db/memories.ts:447`）和
  180 天窗口与旧分支同构，说明这是重写时的遗漏而非有意变更。
- 硬删**无条件执行**，窗口 **30 天**（`src/memory/retention.ts:28` `MEMORY_HARD_DELETE_DAYS=30`，
  全库无 MEMORY_AUTO_DELETE），`listHardDeletableMemories` 对 status IN
  ('deleted','superseded','expired') 的行到期就物理删除。
- `hardDeleteMemoriesBatch`（`src/db/retention.ts:175-197`）清 memory_fts（上游新增，好）
  但**不清 memory_lifecycle 侧车**——旧分支 P0-3 专门修过这个孤儿问题。
- 上游新增的 message_fts / gateway_exchanges 清理、expire 时 memory_fts 清理是良性增量，保留。

**裁定**：**仍缺**（三处：召回时间条件、硬删闸门+窗口、侧车清理）。
**数据兼容性影响（P8 硬前置）**：本分支部署后，P8 迁入的旧 status='deleted'/'superseded' 行
（版本链数据 superseded_by/supersedes_id 都挂在 superseded 行上）会在 **30 天内被 cron
物理清除**，且软删策略整体失守。P5-C 必须在 P7/P8 前落地。archived 值两侧都不在
硬删名单（`listHardDeletableMemories` 不含 archived），无新风险。

## 3. filter/reranker 失败后的 longtail 行为

**旧行为**（78e2a7e，P2-7）：recall 2.5 步改调 `filterAndCompressMemoriesWithMeta`，
`filterFailed = meta.status === "error" && !meta.fallback_used && memories.length === 0`；
第 5 步长尾兜底条件加 `&& !filterFailed`。动机原文："失败时不允许落 longtail 兜底——
模型故障时给用户注入回收站内容比'没有记忆'更糟（召回要准确，宁缺毋滥）"。
区分"过滤后真空"（status='empty'，允许兜底）与"过滤失败 fail-closed 清空"
（status='error' 无 fallback，禁止兜底）。

**当前状态**：
- 上游 `src/memory/filter.ts` 的 meta 能力等价（status error/empty、`fallback_used`、
  `MEMORY_FILTER_FAIL_OPEN` fail-open 开关，`tests/recall-quality.test.ts:313-332` 已钉
  fail-closed/fail-open 行为）——底层没退化。
- 但 `src/memory/v2/recall.ts:477-480` 用的是**丢 meta 的包装** `filterAndCompressMemories`，
  第 5 步条件 `afterRelation.length === 0 && glossaryHits.length === 0`
  （`recall.ts:565-568`）**没有 filterFailed 检查**——reranker 挂掉（fail-closed 清空）时
  longtail 兜底照落。

**裁定**：**仍缺**，但只是接线缺口（上游 meta 已备，P2-7 的区分逻辑一行可复原）。
明确不要：把旧分支两段式 filter（reranker + LLM compress）搬回来——上游已收敛为 reranker 单段。

**已落地（2026-10-11，P5-D）**：v2 recall 2.5 步切 `filterAndCompressMemoriesWithMeta`，
`filterFailed = status==='error' && !fallback_used && 空结果`，第 5 步加 `&& !filterFailed`；
验收 `tests/recall-filter-longtail.test.ts` 5 用例；详见 plan P5-D 完成 banner。

## 4. 稳定缓存前缀与缓存断点修复

**旧行为**：
- 3e37fb3（P1-5）：`splitClientSystemTexts` 把客户端 system 里的时间/日期"易变行"
  （`isVolatileTimeLine` 正则族 + `VOLATILE_SECTION_HEADER` 分节）拆到
  `client_volatile_context` 动态块，不污染 `client_system` 稳定缓存锚。
- dc2afc5（P1-6）：assembler 的 tail 断点 block_index 在 wire 转换（多模态数组并块、
  同角色消息合并）后可能指向不存在的块——回退到 wire 消息里**最后一个 markable 块**
  （text/tool_result），不静默丢断点（丢了就是整条消息前缀缓存 miss）。

**当前状态**：新架构里**这两台机器都不存在了**。网关不重组客户端 prompt：
- 客户端 system/instructions/messages 的内容与 cache_control 标记原样保留
  （`appendMemory` 追加块不碰原块，`src/gateway/protocol.ts:66`）；
- 服务端注入位置全部在客户端锚点**之后**：固定背景 → system 末尾
  （`src/gateway/background.ts:123`），召回 patch → 最后一条消息尾部
  （`src/gateway/handler.ts:293`），回放判重命中时背景转投动态区（`handler.ts:252`）；
- 唯一的服务端标记落点是 `sanitizeCacheControl`（`src/gateway/protocol.ts:97`，
  在 `prepareGatewayRequest` 内先于 appendMemory 执行）：顶层 cache_control 降级到
  **最后一个可缓存块**——`lastCacheableBlock` 从尾向前搜索，天然就是 P1-6 的
  "fallback to last markable block"实现方式，不存在索引失配问题。

**裁定**：**上游架构已替代**。旧两修复绑定在 v4 assembler 的服务端断点机器上，该机器
连同其失配模式一起消失了；等价关注点（易变内容不进稳定前缀、断点不静默丢）在新架构
由"注入位置在锚点后 + 客户端标记保留 + 尾搜式降级"覆盖。**明确不要**把旧 assembler
断点体系搬回来。附注：工具定义上 cache_control 被某些线路拒绝的场景，上游已有
`UPSTREAM_STRIP_TOOL_FIELDS` 学习式剥离（`src/gateway/settings.ts:69`），无需旧
anthropicAdapter 的开关逻辑。

## 5. CORS、公开索引和私有部署保护

**旧行为**（三组四个 commit）：
- 77e25c0：CORS 白名单中间件。`CORS_ALLOW_ORIGINS` 逗号分隔精确 Origin 列表，
  **opt-in 默认 off**（不配 = 不返回任何 CORS 头，浏览器跨域全拦）；配了之后白名单内
  Origin 加 `Access-Control-Allow-Origin` + `Vary: Origin`，OPTIONS 预检 204 + 完整 CORS 头
  不进业务路由；精确等值比对防 includes() 前缀绕过；10 个专项测试。
- 89c2240：全响应 `x-robots-tag: noindex, nofollow` + admin HTML `<meta name="robots">`。
- 5920dd6 + 43dbb4d：wrangler.toml `workers_dev = false` + `preview_urls = false`
  （防部署自动暴露 *.workers.dev 子域与 preview URL）。
- （4a5614d：observability persist/invocation_logs 关闭——噪音治理，不在 P5 清单，仅附注。）

**当前状态**：
- CORS：全库无 access-control 头逻辑（MCP 的 OPTIONS 204 不带 CORS 头，
  `src/api/mcp.ts:1092`）；浏览器跨域访问无法开启。memoria 前端是从浏览器
  `fetch` 直连 Aelios 的（`memoria/src/bridge.js:43`），这个能力有真实调用方。
- noindex：无任何 x-robots-tag / meta robots（grep 全空）。
- wrangler.toml：无 workers_dev / preview_urls 两行。
- observability：`persist = true` + `invocation_logs = true`（与旧分支噪音治理相反，
  附注不计入 P5 包）。

**裁定**：**仍缺**（5a/5b/5c 三项）。均为传输层/部署配置，无数据兼容影响；
5c 属部署行为变更，须用户知情后随 P12 配置确认落地。

**已落地（2026-10-11，P5-E + P5-F）**：5a/5b 由 `src/index.ts` 单一传输层 wrapper
恢复（fetch 入口 wrapper → routeFetch，业务路由零改动）——CORS 白名单
`CORS_ALLOW_ORIGINS`（types/settings/coverage 同步，/admin 可调且 wrapper 读
applied env）opt-in 默认 off、精确等值匹配、OPTIONS 预检 204；全部响应
`x-robots-tag: noindex, nofollow` + admin 两页 HTML（ui.ts + starmap.ts）meta robots。
验收 `tests/cors-noindex.test.ts` 11 用例；不写死域名，实际 origin 留 P12。
5c（P5-G）已于 2026-10-25 由用户裁定并落地：关闭默认 workers.dev 与预览地址。

## 6. 数据语义结论 → P0 manifest / P7 前置条件（已同步落账）

1. **schema manifest 开放项 #4（precious.status）关闭**：审计确认"仍缺"→ 按预案走
   "0018+ 系列加列（建议编号 0020）+ 原样迁入"。线上旧值域 active/deleted，无第三种值。
2. **开放项 #5（memories.status 软删除值域在 retention 的语义）关闭**：迁移语义维持
   "原样携带"（audit 未发现迁移需改写的值）；新分支 retention 现状违反软删策略（§2），
   以 P5-C 恢复旧行为为准——**P7/P8 前置条件：P5-C 先于迁移落地**，否则迁移入的
   deleted/superseded 行 30 天内被 cron 物理清除。
3. 其余审计项（P5-A/B/D/E/F/G）无 schema 影响，不新增 P7 字段需求。

## 7. 实现包清单（彼此独立，本审计包不实现）

| 包 | 内容 | 触点 | 测试 | 优先级 |
|---|---|---|---|---|
| **P5-A** | MCP `memory_delete` 改软删：`softDeleteMemory` + 向量 best-effort（失败记日志），弃 `deleteMemoryV2` 硬删路径（函数保留，REST 不再经 MCP 面暴露） | `src/api/mcp.ts:728`；行为模板=旧 4cc0263 | MCP delete 后行 status='deleted' 可 get 复核；向量删除失败不阻断且行保留；REST 与 MCP 删除语义一致 | **已落地（2026-10-11）**：`tests/mcp-soft-delete.test.ts` 4 用例全绿；工具面 get 对软删行报 not found（任务单要求"删除后不可见"，与 §7 原文"可 get 复核"以任务单为准）；MCP 与 REST 删除语义一致（plan P5-A 完成 banner） |
| **P5-B** | precious 软删恢复：`0020_precious_status.sql`（ADD COLUMN status TEXT NOT NULL DEFAULT 'active' + idx_precious_namespace_status，旧 0008 同构）；`deletePrecious` 改 UPDATE status='deleted'；`getPreciousById`/`listPrecious` 过滤 active；INSERT 不写 status 走 DEFAULT | `migrations/0020_*.sql`（新）、`src/db/v2/precious.ts`；P8 另写 0021+ 迁移旧值 | 软删后 list/get 不见但行在；重复删除返回 false；DEFAULT active 生效（INSERT 不显式写） | **已落地（2026-10-11）**：`0020_precious_status.sql` + `tests/precious-softdelete.test.ts` 6 用例全绿，P8 前置解除（plan P5-B 完成 banner） |
| **P5-C** | retention 三处恢复：`expireOldMemories` 加 `(last_recalled_at IS NULL OR last_recalled_at < cutoff)`；`MEMORY_HARD_DELETE_DAYS` 30→365 + `MEMORY_AUTO_DELETE` 闸门（默认 off 只报 candidates）；`hardDeleteMemoriesBatch` 连带清 memory_lifecycle。新 env 须同步 settings.ts/types.ts/settings-coverage | `src/db/retention.ts:101,175`、`src/memory/retention.ts:28,124`、`src/types.ts`、`src/gateway/settings.ts`；行为模板=旧 4882057 | 最近召回不过期/召回过期后仍过/never-recalled 过期；gate off 只报不删、gate on 才删；硬删后 lifecycle 无孤儿 | **已落地（2026-10-11）**：`tests/retention-gate.test.ts` 6 用例全绿，P7/P8 retention 前置解除（plan P5-C 完成 banner） |
| **P5-D** | recall 接 filterFailed：2.5 步改 `filterAndCompressMemoriesWithMeta`，`filterFailed = status==='error' && !fallback_used && 空结果`，第 5 步 longtail 条件加 `&& !filterFailed` | `src/memory/v2/recall.ts:477,565`；行为模板=旧 78e2a7e | reranker fail-closed 时不落 longtail；`MEMORY_FILTER_FAIL_OPEN=true` fallback 不阻断；真空（status='empty'）仍落 longtail | **已落地（2026-10-11）**：`tests/recall-filter-longtail.test.ts` 5 用例全绿（fail-closed 不落 / fail-open 正常 / 真空仍落 / disabled 不拦 / 正常选中不变），变异探针 3 支全红后复原（plan P5-D 完成 banner） |
| **P5-E** | CORS 白名单中间件：`CORS_ALLOW_ORIGINS` 精确白名单，opt-in 默认 off，OPTIONS 204，Vary: Origin；env 同步 settings | `src/index.ts` fetch 入口、`src/types.ts`、`src/gateway/settings.ts`；行为模板=旧 77e25c0 | 未配置无 CORS 头/匹配放行/不匹配拦/OPTIONS 204/多域名/前缀绕过防护（旧 10 场景移植） | **已落地（2026-10-11）**：`tests/cors-noindex.test.ts` 11 用例全绿，变异探针 4 支全红后复原（plan P5-E/F 完成 banner） |
| **P5-F** | noindex：全响应 `x-robots-tag: noindex, nofollow` + admin HTML meta robots | `src/index.ts` fetch wrapper、admin HTML 模板；行为模板=旧 89c2240 | 任意路径响应带头；admin HTML 含 meta | **已落地（2026-10-11）**：同上（admin 家族两页 ui.ts + starmap.ts 均含 meta，旧模板只有一页 admin HTML） |
| **P5-G** | wrangler.toml `workers_dev = false` + `preview_urls = false` | `wrangler.toml`（部署配置） | 无（配置项）；P12 配置清单核对 | **已落地（2026-10-25）**：用户确认线上同样关闭，MCP/API 不需要预览入口 |

依赖关系：P5-A/B/C/D/E/F/G 相互独立；仅 P5-B 与 P5-C 影响 P7/P8 排期（§6）。
审计未发现需要"明确不要但代码已在"的清理项；旧 assembler 断点体系（4a/4b）不搬运
属于"不恢复已替代物"，不是清理任务。

## 8. 明确不要清单（防止未来包顺手搬运）

- 旧 v4 assembler 的 block/breakpoint 机器（P1-5/P1-6 载体）：上游架构已替代，不搬。
- 旧两段式 filter（reranker + LLM compress + sanitizeMemoryContent 大正则）：上游已收敛
  单段 reranker + `cleanMessageText`，P5-D 只接线不搬实现。
- 旧 `deleteMemoryV2` 的"向量先删、失败保 tombstone"语义与软删不兼容的部分
  （P5-A 落地后 MCP 面不再走它；函数是否清理留 P12 核对，本包不动）。
- observability persist/invocation_logs 噪音治理（4a5614d）：非 P5 清单项，随 P12
  部署配置确认时用户自行裁定。

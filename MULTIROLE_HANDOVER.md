# 角色记忆改造 — 开发交接文档

> 供后续接手开发的模型/人阅读。确保在上下文缺失时，仅凭本文 + 代码即可完整理解进度并继续。

---

## 一、项目背景

Aelios 是 Cloudflare Workers 上的 AI 记忆代理系统。本次改造目标：给记忆系统加角色维度（role_id/role_scope），让不同角色的记忆互相隔离、可加权召回，并引入长期基线 + 变更日志机制。

**相关文件：**
- `plan/角色记忆方案.md` — 原始方案（只读，不改）
- `plan/角色记忆实施方案.md` — 详细执行细则
- `HANDOVER.md` — 前一轮 5 阶段缓存与记忆改造的交接文档
- `.cc-connect/attachments/Aelios_multirole_fix_checklist.md` — 最新修复清单（P0/P1/行为测试）

**补充修复相关文件（第二轮）：**
- `src/memory/dailyDigest.ts` — 补-P0 分批合并 + 补-P1 写入白名单 + 补-P1 重复 target 真正阻止
- `src/utils/roleContext.ts` — 补-P1 Operit `<aelios_role_context>` 标记解析（`extractOperitRoleContext`）
- `src/api/chatCompletions.ts` — 入口解析标记，顶层优先 + 缺字段才用标记 + 剥离标记消息替换 body.messages
- `src/db/v2.ts` — `getDailyLog` 已存在，被 dailyDigest 新调用
- `test/multirole/p0/batchDailyLogMerge.test.ts` — 补-P0 测试 5 项
- `test/multirole/p0/dreamGroupWriteWhitelist.test.ts` — 补-P1 写入白名单测试 4 项
- `test/multirole/p0/duplicateTargetConflict.test.ts` — 补-P1 重复 target 测试 5 项
- `test/utils/roleContext.test.ts` — 补-P1 Operit 标记解析单元测试 20 项
- `test/multirole/p1/operitRoleContextIntegration.test.ts` — 补-P1 chatCompletions 集成不变量源码扫描 8 项

**Baseline pending 机制相关文件（第三轮）：**
- `migrations/0007_baseline_changelog.sql` — 新建 baseline_changelog 表（独立于 memory_changelog）
- `src/db/v2.ts` — 5 个 CRUD：create / listPending / markApplied / markConflict / markError
- `src/api/mcp.ts` — 新增 `baseline_change` 工具 + 7 条校验；注释掉 `memory_change_add/update/delete`
- `src/memory/dailyDigest.ts` — 去掉做梦 baseline 自动生成（prompt + 写入）；新增 `applyBaselineChanges`（按 scope 分组合并）
- `src/assembler/types.ts` — `PendingChange` 加 `before_content`
- `src/api/chatCompletions.ts` — 查 `baseline_changelog` 拼入 pending 注入（op 加 `baseline_` 前缀）
- `src/proxy/openaiAdapter.ts` + `anthropicAdapter.ts` — pending 注入格式加 before + reason + `[baseline]` 标签
- `test/multirole/p0/baselinePending.test.ts` — 7 项测试

**前置条件：** Phase 1-5 缓存与记忆改造已完成（分支 `feat/cache-memory-tweak`）。

---

## 二、分支与状态

**分支：** `feat/multirole-memory`（基于 `feat/cache-memory-tweak`）
**已推送 commits：**
- `7394c7e` — feat: multirole memory phases A-D
- `c01cd1c` — feat: multirole memory phases E-H + code review fixes
- `51ccfc7` — fix: self-review fixes + follow-up optimizations 1-7
- `eeb4184` — feat: multirole memory P0/P1 fixes + behavior tests
- `67835df` — feat: multirole memory round-2 fixes — batch merge, write whitelist, dup target block, Operit role tag
- `1599ddb` — fix(roleContext): strict Operit role marker parsing per spec
- `8bbd5e1` — docs: add multirole memory design rationale + future-dev tracking notes
- `1f98405` — docs: add pending issues tracker
- `fb03785` — docs: annotate bridge breakpoint design decision
- `fb03627` — feat: baseline pending mechanism — model-submitted baseline changes via MCP
- `1612db0` — fix: baseline pending error handling — keep pending on transient failures, skip on read failure
- `7b9f146` — fix: clear error_message when marking baseline changelog applied
- `af4e449` — docs: update handover with round-3 baseline pending mechanism
- `a9706bd` — debug: log tool_calls returned to client (temp, removed later)
- `89d72d9` — fix: passthrough tool_call/tool_result in history — stop model repeating MCP calls
- `60df148` — fix: preserve tool round order when request ends with tool result

> **规则：不自动推送。等用户检查确认后再推送。**

**验证状态：** typecheck ✅ / vitest 222/222 ✅ / verify-assembler 177/0 ✅ / verify-cache-strategy 15/0 ✅
**本地验证命令：** `npm run typecheck && npx vitest run && node scripts/verify-assembler.mjs && node scripts/verify-cache-strategy.mjs`

---

## 三、清单修复进度

基于 `Aelios_multirole_fix_checklist.md`，修复顺序和依赖关系：

### 已完成

| # | 内容 | 状态 | 说明 |
|---|------|------|------|
| P0-1 | 迁移执行顺序 | ✅ | 真实 wrangler d1 验证：ALTER memory_lifecycle.role_scope 移到 idx_lifecycle_role_fact 之前；空库 0001-0006 全部成功 |
| P0-2 | 彻底关闭自动提取 | ✅ | index.ts gate + extractPipeline 二次保护，返回 `auto_memory_disabled` |
| P0-3 | 做梦前应用 pending | ✅ | applyPendingChanges 前移到读记忆/prompt 之前；模型看到刚应用的变更 |
| P0-4 | 角色做梦分组 | ✅ | 按 computeRoleScope 分组；单一非 shared 角色也触发；超限失败不推进 cursor；跨 scope 修改被校验拦截 |
| P1-1 | baseline 语义 | ✅ | ~~prompt 明确"角色对用户的长期印象"~~ → **第三轮改为 baseline 不再由做梦生成，只通过 `baseline_change` pending 修改** |
| P1-2 | 只注入当前角色 baseline | ✅ | buildBootPackage 只查当前 role_scope baseline；daily_log 同样只查当前 scope |
| P1-3 | 日记写入/读取 | ✅ | applyDreamV2 按 group 分别 upsertDailyLog/upsertBaseline；请求只读当前角色最近两天 |
| P1-4 | boost 后置 | ✅ | 去掉 pre-boost，只在 reranker 后应用完整 boost |
| P1-5 | ROLE_MEMORY_ENABLED 文档 | ✅ | README 加"角色记忆"段落 + 语义说明；types.ts/role.ts 注释更新 |
| P1-6 | 召回去重 | ✅ | dedupeCrossScope 在闸二后按 当前角色>shared>其他 优先级折叠近重复；短内容跳过避免误判；不删数据库记录 |

### 补充修复（第二轮）

| 项 | 内容 | 状态 | 备注 |
|---|------|------|------|
| 补-P0 | 同日分批日记被覆盖 | ✅ | 非首批读取已有 daily_log 喂入 prompt（角色组按 scope 分别读 + 非角色路径读 shared）；prompt 要求模型输出合并版完整 daily_log；baseline 仍按旧 baseline 继承规则，不因分批丢失 |
| 补-P1 | Dream 输出角色组缺写入白名单 | ✅ | applyDreamV2 写 daily_log/baseline 时用 groupScopes 过滤；重复 scope 只接受第一个；不在 allowed scopes 的 group 跳过 + warn |
| 补-P1 | 重复 target 检测只 warn 不阻止 | ✅ | 改为两阶段：先统计每个 target_id 的 op 次数（update + delete 各算一次），只对 op 次数==1 的 target 执行；同 target 同时 update+delete 视为冲突，两个都不执行 |
| 补-P1 | Operit 角色身份标记解析 | ✅ | 新增 `src/utils/roleContext.ts` `extractOperitRoleContext` 严格解析独立 SYSTEM `<aelios_role_context>` JSON 标记；仅识别 string content 独立 SYSTEM 消息；严格 JSON + 字段白名单(role_id/role_name) + ≤200 字符长度限制；多标记拒绝全部回退顶层；解析失败删标记 + warn；**残缺标记（闭合缺失）也删除 + warn 不转发上游**；chatCompletions 入口"顶层优先，缺字段才用标记"（`readString(body.role_id) ?? operitRole?.role_id`），剥离后 body.messages 替换，下游全用清理后 messages |

### Baseline pending 机制（第三轮）

**核心变更：** baseline 不再由做梦自动生成/更新，改为模型对话中通过 MCP `baseline_change` 提交 pending，做梦时统一合并应用。

| 最终规则 | 实现 |
|---|---|
| 1. baseline 只能由 `baseline_change` pending 修改 | ✅ 做梦 prompt 去掉 baseline 输出要求，`applyDreamV2` 删掉 baseline 写入 |
| 2. 普通 dream 不得自行修改 baseline | ✅ prompt 标注"忽略 baseline 字段" |
| 3. baseline pending 独立处理，不随分批重复 | ✅ `applyBaselineChanges` 按 scope 分组一次性处理（第一批处理完后后续批查不到 pending） |
| 4. 每晚每个有 pending 的角色只合并写入一次 | ✅ |
| 5. 没有 pending 就不调用 baseline 模型 | ✅ `pending.length === 0` 直接返回 |
| 6. 生成+写入都成功才标记 applied；失败保留 pending 重试 | ✅ 临时故障（缺模型/调用失败/返回空/写入失败）用 `markBaselineChangelogError`（只记 error 不改 status）；读取旧 baseline 失败跳过该 scope |
| 7. MCP 校验：add 必须有 after / update 必须有 before+after / delete 必须有 before / role_id+reason 必填 / 不允许 shared | ✅ |

**屏蔽原子记忆 pending：** `memory_change_add/update/delete` 从 `getTools()` 注释掉（handler 代码保留），模型看不到。`memory_upsert` 保留（实时写原子记忆）。

**pending 注入格式（对话中防重复提交）：**
- `PendingChange` 加 `before_content` 字段
- baseline pending op 加 `baseline_` 前缀区分
- 注入格式：`[baseline] 修改：原文 → 修改后（理由：...）` / `[baseline] 新增：内容（理由：...）` / `[baseline] 删除：原文（理由：...）`
- 原子记忆 pending 也统一加了 before + reason
- 两个适配器（OpenAI + Anthropic text/toolcall 双模式）同步更新

**新角色首版 baseline：** 模型看到 `<long_term_baselines>` 为空时，通过系统提示引导主动提交首版 `baseline_change`（op=add）。

### tool_call/tool_result 透传修复（第四轮）

**Bug：** `extractHistoryMessages` + `messageToOutput` 过滤了 `role=tool` 消息并丢弃了 assistant 的 `tool_calls` 字段。模型看不到自己的 MCP 调用历史 → 重复 upsert。

**修复：**
- `assemble.ts` — `extractHistoryMessages` 保留 `role=tool`；只在请求以 user 结尾时拆分 current_user（tool result 结尾时不拆，保持原始顺序）
- `blocks.ts` — `messageToOutput` 保留 `tool_calls`/`tool_call_id`；tool message 有 tool_call_id 时即使 content 空也保留；assistant 带 tool_calls 时 content 为 null 也保留
- `types.ts` — 新增 `AssembledMessage` 接口（role 支持 tool）
- `toOpenAI.ts` — 透传 tool_calls + tool_call_id
- `toAnthropic.ts` — tool 消息转 Anthropic tool_result block，assistant+tool_calls 转 tool_use block
- `assemble.ts` — `extractLastUserMessage` 只在最后一条是 user 时返回，不再向后搜索

**测试：** `test/assembler/toolCallPassthrough.test.ts`（8 项）

### 行为测试（12 项全部完成）

清单要求 12 项端到端行为测试。**全部完成**：

| # | 内容 | 状态 |
|---|------|------|
| 1 | 空数据库真实执行 0001～0006 migration | ✅ wrangler d1 --local 全部成功 |
| 2 | 含旧 daily_log 数据的 migration 保留数量与内容 | ✅ 3 条旧数据迁到 shared，数量内容一致 |
| 3 | `ENABLE_AUTO_MEMORY=false` 时 cron 不调用提取模型 | ✅ |
| 4 | 单一 Alice 角色的一天也会生成 Alice 日记和 baseline | ✅ |
| 5 | Alice + Bob 同一天分别生成各自日记和 baseline，不串内容 | ✅ |
| 6 | 当前 Alice 请求只注入 Alice baseline 和 Alice 最近两天日记 | ✅ |
| 7 | pending 在 dream 模型调用前已应用且能出现在模型输入中 | ✅ |
| 8 | Alice 分组输出不能修改 Bob target | ✅ |
| 9 | 超过角色处理上限时 cursor 不越过未处理消息 | ✅ |
| 10 | shared 与 Alice 的近重复原子记忆同时命中时，只注入 Alice 版本，但两条数据库记录都保留 | ✅ |
| 11 | boost 只后置，并输出可观察的命中统计 | ✅ |
| 12 | Anthropic toolcall/text 与 OpenAI 均能看到 pending，且 role 私有字段不转发上游 | ✅ |

> #1/#2 用 `npx wrangler d1 migrations apply DB --local` 真实执行。执行中发现了 P0-1 的真实 bug：之前的"自查修复"只改了 SQL 注释 `#`→`--`，但没真正把 `ALTER TABLE memory_lifecycle ADD COLUMN role_scope` 移到 `CREATE INDEX idx_lifecycle_role_fact` 之前，导致空库执行 0006 报 `no such column: role_scope`。已真正修复 ALTER 顺序。

> 本地验证命令（需 Node 20+ / wrangler 4.x）：
> ```bash
> # 用临时 toml 指向本地 D1
> cat > /tmp/wrangler-local.toml << 'EOF'
> name = "aelios-local-test"
> main = "src/index.ts"
> compatibility_date = "2026-04-01"
> [[d1_databases]]
> binding = "DB"
> database_name = "companion_memory_proxy"
> database_id = "local-test-id"
> migrations_dir = "/home/yyuan/projects/Aelios/migrations"
> EOF
> npx wrangler d1 migrations apply DB --local --config /tmp/wrangler-local.toml
> ```

---

## 四、已完成阶段详情（A-H + 自查 + 后续项）

### 阶段 A-H（8 阶段全部完成）

| 阶段 | 内容 |
|------|------|
| A | 数据库迁移 0006 + 类型定义 + computeRoleScope/isRoleMemoryEnabled |
| B | 消息层角色标签（conversations/messages/chatCompletions + 流式全路径） |
| C | 记忆层 role_scope 隔离（v2.ts/vectorStore.ts/daily_log/changelog CRUD） |
| D | MCP 工具（memory_change_* + role 参数；update/delete 不接受 role） |
| E | 召回加权（role boost post-reranker，gate on ROLE_MEMORY_ENABLED） |
| F | 长期基线 + 变更日志（注入/整理/生成，gate on ROLE_MEMORY_ENABLED） |
| G | 做梦分组整理（applyPendingChanges + 多角色 prompt + 基线生成） |
| H | Vectorize 回填脚本 + 验证 |

### 自查修复（8 个）

1. 迁移文件注释 + fact_key 索引建在 memory_lifecycle
2. listPendingChangelog 不传 roleScope 时查全部
3. 流式/OpenAI/Anthropic 所有路径 assistant 消息传 role
4. applyDreamV2 更新 fact_key 记忆时从 existing 继承 role
5. OpenAI adapter 转发前删除 role_id/role_name 私有字段
6. MCP memory_recall handler 传 role 到 runRecall
7. extractPipeline 从最近 user 消息继承角色
8. ROLE_MEMORY_ENABLED gate 生效

### 后续优化项（7 个，已完成）

6: update/delete 归属继承 | 5: daily_log 角色化 | 1: 多角色做梦分组接入 | 7: DREAM_MAX_ROLES_PER_RUN
2: pending 跨 provider | 3: role boost 后置 | 4: 基线排序 + 8000 字截断

### 第二轮自查修复（4 个）

1. 做梦 groups 输出解析（normalizeDigestResult 解析 groups 并展平）
2. role boost 数学修正（去掉 pre-boost，只在 post-reranker 应用完整 boost）
3. pending changes 注入修复（查 shared + 当前角色并集）
4. OpenAI multimodal pending（array content 时追加新 user message）

---

## 五、测试结构

```
test/
  helpers/d1-mock.ts              — mock D1 + crypto polyfill
  multirole/
    phaseA/          — 16 tests
    phaseD/          — 6 tests
    phaseE/          — 7 tests
    phaseF/          — 10 tests
    phaseG/          — 4 tests
    phaseH/          — 3 tests
    phase6517/       — 10 tests
    phase23/         — 7 tests
    phase4/          — 4 tests
    p0/              — 10 tests (P0-2 自动提取关闭)
      + dreamFlow.test.ts (10) / bootPackageScoping (4) / crossScopeDedup (6)
      + boostPostRerankerStats (6) / pendingAndPrivateFields (6) / autoExtractDisabled (5)
      + batchDailyLogMerge (5) / dreamGroupWriteWhitelist (4) / duplicateTargetConflict (5)
      + baselinePending (7)
    p1/              — 15 tests
      + recallCrossScopeDedup (7) / operitRoleContextIntegration (8)
  utils/
    roleContext.test.ts — 20 tests (Operit 标记解析)
  assembler/
    toolCallPassthrough.test.ts — 8 tests (tool_call/tool_result 透传)
  phase1-4_5/        — 前一轮改造测试
```
**当前总数：38 个测试文件，222 项测试全部通过**

**运行命令：**
```bash
npm run typecheck && npx vitest run && node scripts/verify-assembler.mjs && node scripts/verify-cache-strategy.mjs
```

---

## 六、环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `ROLE_MEMORY_ENABLED` | `false` | 角色记忆行为开关（false 时仍保存 role_id + fact_key 隔离，但不启用 baseline/日记/pending/boost/dream 分组） |
| `RECALL_ROLE_BOOST_EXACT` | `1.3` | role_id 精确匹配加权 |
| `RECALL_ROLE_BOOST_NAME` | `1.1` | role_name 兜底加权 |
| `BASELINE_MAX_CHARS_PER_ROLE` | `2000` | 基线文本 per role_scope 上限 |
| `BASELINE_MAX_CHARS_TOTAL` | `8000` | 基线文本总量上限 |
| `DREAM_MAX_ROLES_PER_RUN` | `5` | 单次做梦最多处理角色数 |
| `ENABLE_AUTO_MEMORY` | （空=开启） | `false` 时彻底关闭自动提取 |
| `MEMORY_FILTER_MODEL` | `workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast` | 召回记忆压缩模型（Cloudflare Workers AI，不走 Gateway） |
| `MEMORY_RERANKER_MODEL` | `workers-ai/@cf/baai/bge-reranker-base` | 召回记忆重排模型（Cloudflare Workers AI，不走 Gateway） |
| `EMBEDDING_MODEL` | `workers-ai/@cf/google/embeddinggemma-300m` | 向量嵌入模型（Cloudflare Workers AI，不走 Gateway） |
| `CHAT_MODEL` | `deepseek/deepseek-v4-pro` | 聊天模型（走 CF Gateway，可用 `custom-{slug}/` 前缀路由到 Custom Provider） |
| `DREAM_MODEL` | `deepseek/deepseek-v4-pro` | 做梦模型（走 CF Gateway） |
| `MEMORY_INJECTION_MODE` | `text` | 召回记忆注入方式：`text`=追加到 user 消息，`toolcall`=伪造 memory_context tool call |

---

## 七、部署清单

1. **数据库迁移（先备份！）**
   ```bash
   wrangler d1 export companion_memory_proxy --output backup.sql
   wrangler d1 migrations apply companion_memory_proxy --local  # 先本地验证
   wrangler d1 migrations apply companion_memory_proxy --remote
   ```
2. **环境变量配置：**
   - `ROLE_MEMORY_ENABLED` = `false`（灰度后再开）
   - `ENABLE_AUTO_MEMORY` = `false`（关闭自动提取）
3. **部署 Worker：** `npm run deploy`
4. **Vectorize 回填：**
   ```bash
   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... \
   D1_DATABASE_NAME=companion_memory_proxy VECTORIZE_INDEX_NAME=memo-kb \
   node scripts/backfill-vectorize-role.mjs --apply
   ```
5. **前端配合：** 聊天请求 body 加 `role_id`/`role_name`
6. **灰度验证：** 确认稳定后开 `ROLE_MEMORY_ENABLED=true`

---

## 八、接手后第一件事

```bash
cd /home/yyuan/projects/Aelios
git checkout feat/multirole-memory
git pull origin feat/multirole-memory
npm run typecheck && npx vitest run && node scripts/verify-assembler.mjs && node scripts/verify-cache-strategy.mjs
```

确认全绿。**全部清单项已完成**（10 项 P0/P1 修复 + 12 项行为测试 + 4 项第二轮补充修复 + baseline pending 机制第三轮 + tool_call 透传修复第四轮），无待做。
下一步是部署（见第七节），部署前必须先备份远程 D1（0006 含 DROP TABLE + RENAME；0007 新建表，安全）。

---

## 九、关键注意事项

1. **D1 ALTER TABLE 不支持 IF NOT EXISTS** — 迁移 0006 只能跑一次
2. **daily_log 重建有数据丢失风险** — 先备份
3. **Vectorize metadata 需要回填** — 部署后跑回填脚本，未回填的视为 shared
4. **前端需传 role_id** — 否则所有记忆落共享区
5. **ROLE_MEMORY_ENABLED 语义** — false 时仍保存 role_id + fact_key 隔离，但不启用角色行为（baseline/日记/pending/boost/dream 分组）
6. **不自动推送** — 等用户检查确认后再推送
7. **update/delete 归属从目标记忆继承** — MCP schema 不接受 role 参数
8. **ENABLE_AUTO_MEMORY=false 彻底关闭提取** — index.ts + extractPipeline 双重保护
9. **role boost 只后置** — reranker 后应用完整 boost，不前移
10. **pending changes 跨 provider** — text 模式 formatDynamicMemoryText，OpenAI formatPendingChangesText，toolcall 模式 buildSyntheticContext
11. **pending 注入查 shared + 当前角色并集** — 不只查当前角色
12. **做梦 groups 输出已解析** — normalizeDigestResult 解析 groups 并展平到 memories_to_update/delete
13. **基线注入只读当前角色** — buildBootPackage 只查 `getBaselines({roleScope})`，不读全部再排序
14. **同日分批日记合并** — 非首批读取已有 daily_log 喂入 prompt，模型输出合并版完整 daily_log
15. **Dream 输出角色组写入白名单** — applyDreamV2 写 daily_log 时用 `groupScopes` 过滤；重复 scope 只接受第一个；不在 allowed scopes 的 group 跳过 + warn
16. **重复 target 真正阻止** — 两阶段检测：统计每个 target_id 的 op 次数（update+delete 各算一次），只对 op 次数==1 的 target 执行；同 target update+delete 视为冲突，两个都不执行
17. **Operit 角色标记解析** — `extractOperitRoleContext` 严格解析独立 SYSTEM `<aelios_role_context>` 标记；顶层优先 + 缺字段才用标记；多标记拒绝全部回退顶层；残缺/解析失败/超长/未知字段一律删标记 + warn 不转发上游
18. **baseline 不再由做梦生成** — 只通过 `baseline_change` MCP pending 修改；做梦 prompt 忽略 baseline；`applyBaselineChanges` 按 scope 分组合并，每 scope 调一次模型
19. **baseline pending 错误处理** — 临时故障（缺模型/调用失败/返回空/写入失败）保持 pending + 记录 error，下次 dream 重试；读取旧 baseline 失败跳过该 scope 不覆盖；applied 时清除 error_message
20. **原子记忆 pending 已屏蔽** — `memory_change_add/update/delete` 从 getTools 注释掉；`memory_upsert` 保留实时写
21. **token 超限自动拆分尚未实现** — 当前依赖 DREAM_MAX_ROLES_PER_RUN 限制
22. **清单要求行为测试** — 不能只用源码正则检查代替端到端测试
23. **wrangler d1 本地验证 migration** — 用临时 toml 指向本地 D1，真实执行 migration 验证 ALTER 顺序（见第三节末尾命令）
24. **tool_call/tool_result 透传** — assembler 不再过滤 tool 消息；请求以 tool result 结尾时不拆分 current_user，保持 `user→assistant(tool_call)→tool(result)` 原始顺序
25. **CF Gateway Custom Provider slug 必须全小写** — 大写 slug 会导致 URL 路径不匹配
26. **压缩/重排/嵌入模型走 Workers AI** — 不经过 CF Gateway，用 `CLOUDFLARE_API_TOKEN` 认证；聊天/做梦模型走 CF Gateway
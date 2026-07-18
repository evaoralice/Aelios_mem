# 角色记忆改造 — 开发交接文档

> 供后续接手开发的模型/人阅读。确保在上下文缺失时，仅凭本文 + 代码即可完整理解进度并继续。

---

## 一、项目背景

Aelios 是 Cloudflare Workers 上的 AI 记忆代理系统。本次改造目标：给记忆系统加角色维度（role_id/role_scope），让不同角色的记忆互相隔离、可加权召回，并引入长期基线 + 变更日志机制。

**相关文件：**
- `plan/角色记忆方案.md` — 原始方案（只读，不改）
- `plan/角色记忆实施方案.md` — 详细执行细则（含消息层补充、4 个问题修复、2 个小建议）
- `HANDOVER.md` — 前一轮 5 阶段缓存与记忆改造的交接文档

**前置条件：** Phase 1-5 缓存与记忆改造已完成（分支 `feat/cache-memory-tweak`）。

---

## 二、分支与状态

**分支：** `feat/multirole-memory`（基于 `feat/cache-memory-tweak`）
**已推送 commit：** `7394c7e` — feat: multirole memory phases A-D
**本地未推送改动：** 阶段 E、F、G、H 的代码改动（等你检查确认后推送）

> **规则：不自动推送。等用户检查确认后再推送。**

**8 个阶段全部完成：**

| 阶段 | 内容 | 状态 |
|------|------|------|
| A | 数据库迁移 + 类型定义 + role_scope 生成函数 | ✅ |
| B | 消息层角色标签 — conversations/messages/chatCompletions | ✅ |
| C | 记忆层 role_scope 隔离 — v2.ts/vectorStore.ts/daily_log | ✅ |
| D | MCP 工具 — memory_change_* + role 参数 | ✅ |
| E | 召回加权 — role boost 逻辑 | ✅ |
| F | 长期基线 + 变更日志 — 注入/整理/生成 | ✅ |
| G | 做梦分组整理 — 消息按角色分组 + 多角色 prompt | ✅ |
| H | Vectorize 回填 + 验证 | ✅ |

**验证状态：** typecheck ✅ / vitest 101/101 ✅ / verify-assembler 177/0 ✅ / verify-cache-strategy 15/0 ✅

---

## 三、已完成阶段详情

### 阶段 A：数据库迁移 + 类型定义

**新增文件：**
- `migrations/0006_role_memory_baseline.sql` — 完整迁移（角色字段 + daily_log 重建 + 3 个新表）
- `src/utils/role.ts` — `computeRoleScope(roleId, roleName)` + `isSharedScope(scope)`

**改动文件：**
- `src/types.ts` — Conversation/MessageRecord/MemoryRecord/MemoryLifecycleRow/MemoryApiRecord 加 role 字段；Env 加 `ROLE_MEMORY_ENABLED`/`RECALL_ROLE_BOOST_EXACT`/`RECALL_ROLE_BOOST_NAME`/`BASELINE_MAX_CHARS_PER_ROLE`/`BASELINE_MAX_CHARS_TOTAL`

**role_scope 生成规则：**
```
有 role_id    → id:<role_id>
无 ID 有名称  → name:<trim + NFKC 规范化名称>
都没有        → shared
```

**迁移注意：** daily_log 重建涉及 DROP TABLE + RENAME，执行前需 `wrangler d1 export` 备份。

### 阶段 B：消息层角色标签

**改动文件：**
- `src/db/conversations.ts` — `getOrCreateConversation` 加 `roleId`/`roleName` 参数，conversation_id 变为 `{namespace}:{roleId ?? "default"}`
- `src/db/messages.ts` — `saveUserMessages`/`saveAssistantMessage` 加 `roleId`/`roleName`，INSERT SQL 加 role_id/role_name 列；`listMessagesByNamespaceInRange` SELECT 加 role_id/role_name
- `src/api/chatCompletions.ts` — 从请求 body 提取 `role_id`/`role_name`，传入 conversation 和消息保存

### 阶段 C：记忆层 role_scope 隔离

**改动文件：**
- `src/db/v2.ts`：
  - `upsertMemoryByFactKey` — WHERE 加 `role_scope = ?`，INSERT 加 role 字段，接受 `roleId`/`roleName`
  - `supersedeMemory` — 默认继承旧记忆的 role_scope/role_id/role_name，INSERT 加 role 字段
  - `getActiveMemoryByFactKey` — WHERE 加 `role_scope = ?`
  - `DailyLogRow` 加 `role_scope` 字段
  - `getDailyLog`/`getRecentDailyLogs`/`upsertDailyLog` — 加 `roleScope` 参数，SQL 按 role_scope 过滤
  - 新增 `createChangelogEntry` + `listPendingChangelog` 函数
  - 新增 `MemoryChangelogRow` 接口
- `src/memory/vectorStore.ts`：
  - `VectorMemoryInput` 加 `roleId`/`roleName`/`roleScope`
  - `toMetadata` 写入 `role_id`/`role_name`/`role_scope` 到 Vectorize metadata
  - `vectorMetadataToMemoryRecord` 读回 role 字段
  - `createVectorMemory`/`updateVectorMemory` 的 normalized 对象加 role 字段

### 阶段 D：MCP 工具

**改动文件：**
- `src/api/mcp.ts`：
  - 新增 3 个工具定义：`memory_change_add`/`memory_change_update`/`memory_change_delete`
  - `memory_upsert` schema 加 `role_id`/`role_name`
  - `memory_search`/`memory_recall` schema 加 `role_id`/`role_name`
  - `callTool` 新增 3 个 memory_change_* 处理逻辑（调 `createChangelogEntry`）
  - `memory_upsert` callTool 透传 `roleId`/`roleName` 到 `upsertMemoryByFactKey`

**工具分工：**
| 工具 | 写入目标 | 谁用 |
|------|---------|------|
| memory_change_add/update/delete | memory_changelog (pending) | 对话模型 |
| memory_upsert | memories (直接写入) | 内部维护/面板/提取 |
| memory_supersede | memories (直接写入) | 内部维护 |

### 阶段 E：召回加权

**改动文件：**
- `src/memory/v2/recall.ts`：
  - 新增 `readRoleBoostExact`(默认 1.3)/`readRoleBoostName`(默认 1.1)/`normalizeName`
  - `RecallInput` 加 `role_id`/`role_name`
  - 在闸三（injection decay）之后、gate-2 去重之前，和 source boost 一起做 role boost
  - 加权规则：role_id 精确匹配 ×1.3；无 ID 时 role_name NFKC+lowercase 匹配 ×1.1；不同 role_id 即使同名不加权；共享记忆不加权
  - 与 source boost 乘法叠加：`score × source_boost × role_boost`
- `src/api/chatCompletions.ts` — 传 `role_id`/`role_name` 到 `runRecall`

**测试文件：** `test/multirole/phaseE/roleBoost.test.ts`（7 个测试）

### 阶段 F：长期基线 + 变更日志

**改动文件：**
- `src/db/v2.ts` — 新增 baseline CRUD + changelog 状态更新：
  - `getBaselines(db, { namespace, roleScope? })` — 读取基线文本
  - `upsertBaseline(db, { namespace, roleScope, content })` — 写入基线，version+1，存快照，保留最近 7 版
  - `markChangelogApplied(db, { id })` — 标记变更已应用
  - `markChangelogConflict(db, { id, errorMessage })` — 标记变更冲突
  - `BaselineRow` 接口
- `src/memory/v2/recall.ts`：
  - `BootPackage` 加 `baselines: Array<{ role_scope, content, version }>`
  - `buildBootPackage` 读取 `long_term_baselines` 表
  - 导入 `getBaselines`
- `src/assembler/types.ts`：
  - `formatBootStable` 扩展，在 `<digest>` 之前渲染 `<long_term_baselines>` 段
  - 共享基线不加 `[shared]` 前缀；非共享加 `[role_scope]` 前缀
  - 新增 `PendingChange` 接口 + `AssembledPrompt.pending_changes` 字段
- `src/proxy/anthropicAdapter.ts`：
  - `buildSyntheticContext` 扩展，接受 `pendingChanges` 参数
  - tool_result 里追加 `=== 待处理变更（今日）===` 段
- `src/api/chatCompletions.ts`：
  - 每轮读 pending changelog（`listPendingChangelog`，limit 10）
  - 设置 `assembled.pending_changes`
  - 导入 `computeRoleScope` 计算请求的 role_scope

**缓存位置：** 基线文本放断点 2-3 之间（boot_stable block 内的 `<long_term_baselines>` 段），每天变一次。

**测试文件：** `test/multirole/phaseF/`（3 个文件，10 个测试）

### 阶段 G：做梦分组整理

**改动文件：**
- `src/memory/dailyDigest.ts`：
  - 新增 `applyPendingChanges(env, namespace)` — 凌晨做梦前先应用 pending 变更（代码执行，不需要模型）
    - add → `upsertMemoryByFactKey`（继承 changelog 的 role_scope）
    - update → `supersedeMemory`（校验 target 存在且 active）
    - delete → `archiveMemory`
    - target 不存在 → `markChangelogConflict`
    - 成功 → `markChangelogApplied`
  - `buildDigestPrompt` 扩展，支持 `roleGroups` 参数
    - 有 roleGroups 时 prompt 按角色分段（`=== [共享] === ... === [Alice] === ...`）
    - JSON 输出结构改为 `{ groups: [...], summary, baseline_texts: { shared: "...", "id:alice-001": "..." } }`
    - 无 roleGroups 时保持原有格式（向后兼容）
  - `runDailyMemoryDigest` 改动：
    - 调用 `applyPendingChanges` 在做梦前
    - 消息按 `role_id` 分组（null = 共享素材）
  - `applyDreamV2` 扩展：
    - 生成基线文本：从 dream 输出的 `baseline_texts` 对象，逐 role_scope 调 `upsertBaseline`
    - 基线文本截断到 `BASELINE_MAX_CHARS_PER_ROLE`（默认 2000）
  - 导入 `computeRoleScope`/`upsertBaseline`/`listPendingChangelog`/`markChangelogApplied`/`markChangelogConflict`
- `src/types.ts` — Env 加 `BASELINE_MAX_CHARS_PER_ROLE`/`BASELINE_MAX_CHARS_TOTAL`

**做梦调用策略：** 单次模型调用处理多角色分组（prompt 分段），不翻倍调用。token 超限时自动拆分（尚未实现自动拆分逻辑，当前依赖 `DREAM_MAX_ROLES_PER_RUN` 限制角色数）。

**测试文件：** `test/multirole/phaseG/dreamGrouping.test.ts`（4 个测试）

### 阶段 H：Vectorize 回填 + 验证

**已完成：**
- 新增 `scripts/backfill-vectorize-role.mjs` — 回填脚本
  - 遍历 D1 memories 表，读 role_id/role_name/role_scope
  - 按 vector_id 从 Vectorize 获取现有向量值
  - 用包含 role 字段的新 metadata 重新 upsert
  - 支持 dry run（默认）和 `--apply` 实际执行
  - 批量处理（100 条/批），带速率限制
- `vectorMetadataToMemoryRecord` 已默认 role_scope = "shared"（向后兼容，未回填的向量正常工作）
- 测试验证 metadata 缺失 role 字段时默认 shared + 有 role 字段时正确读取

**测试文件：** `test/multirole/phaseH/backfillScript.test.ts`（3 个测试）

**部署后回填步骤：**
```bash
CLOUDFLARE_ACCOUNT_ID=... \
CLOUDFLARE_API_TOKEN=... \
D1_DATABASE_NAME=companion_memory_proxy \
VECTORIZE_INDEX_NAME=memo-kb \
node scripts/backfill-vectorize-role.mjs           # dry run 先看
node scripts/backfill-vectorize-role.mjs --apply    # 实际执行
```

---

## 四、改动文件总览

**新增文件：**
- `migrations/0006_role_memory_baseline.sql` — 数据库迁移
- `src/utils/role.ts` — role_scope 生成工具
- `scripts/backfill-vectorize-role.mjs` — Vectorize 回填脚本
- `test/multirole/phaseA/` — 2 个测试文件（16 个测试）
- `test/multirole/phaseD/` — 1 个测试文件（6 个测试）
- `test/multirole/phaseE/` — 1 个测试文件（7 个测试）
- `test/multirole/phaseF/` — 3 个测试文件（10 个测试）
- `test/multirole/phaseG/` — 1 个测试文件（4 个测试）
- `test/multirole/phaseH/` — 1 个测试文件（3 个测试）

**改动文件（源码）：**
- `src/types.ts` — 角色字段 + Env 新变量
- `src/db/conversations.ts` — getOrCreateConversation 加 role
- `src/db/messages.ts` — 消息保存加 role
- `src/db/v2.ts` — role_scope 隔离 + baseline/changelog CRUD
- `src/api/chatCompletions.ts` — 请求提取 role + 传到 recall/conversation/messages + 读 pending
- `src/api/mcp.ts` — 新工具 + role 参数
- `src/assembler/types.ts` — formatBootStable 渲染基线 + PendingChange 接口
- `src/proxy/anthropicAdapter.ts` — buildSyntheticContext 注入 pending 变更
- `src/memory/v2/recall.ts` — role boost + BootPackage baselines + buildBootPackage 读取基线
- `src/memory/vectorStore.ts` — Vectorize metadata 加 role 字段
- `src/memory/dailyDigest.ts` — applyPendingChanges + 多角色 prompt + 基线生成

---

## 五、测试结构

```
test/
  helpers/d1-mock.ts                          — mock D1 + crypto polyfill
  multirole/
    phaseA/
      computeRoleScope.test.ts                  — 9 个测试
      roleTypes.test.ts                         — 7 个测试
    phaseD/
      mcpChangeTools.test.ts                    — 6 个测试
    phaseE/
      roleBoost.test.ts                         — 7 个测试
    phaseF/
      bootBaselines.test.ts                    — 3 个测试
      formatBootStableBaselines.test.ts         — 5 个测试
      changelogInject.test.ts                   — 2 个测试
    phaseG/
      dreamGrouping.test.ts                     — 4 个测试
    phaseH/
      backfillScript.test.ts                    — 3 个测试
  phase1-4_5/                                  — 前一轮改造的测试
```

**运行命令：**
```bash
# 全量
npm run typecheck && npx vitest run && node scripts/verify-assembler.mjs && node scripts/verify-cache-strategy.mjs

# 按阶段
npx vitest run test/multirole/phaseA/
npx vitest run test/multirole/phaseD/
npx vitest run test/multirole/phaseE/
npx vitest run test/multirole/phaseF/
npx vitest run test/multirole/phaseG/
npx vitest run test/multirole/phaseH/
```

---

## 六、环境变量新增

| 变量 | 默认值 | 阶段 | 说明 |
|------|--------|------|------|
| `ROLE_MEMORY_ENABLED` | `false` | A-H | 角色记忆总开关 |
| `RECALL_ROLE_BOOST_EXACT` | `1.3` | E | role_id 精确匹配加权 |
| `RECALL_ROLE_BOOST_NAME` | `1.1` | E | role_name 兜底加权 |
| `BASELINE_MAX_CHARS_PER_ROLE` | `2000` | F/G | 基线文本 per role_scope 上限 |
| `BASELINE_MAX_CHARS_TOTAL` | `8000` | F | 基线文本总量上限 |
| `DREAM_MAX_ROLES_PER_RUN` | `5` | G | 单次做梦最多处理角色数 |

---

## 七、接手后第一件事

```bash
cd /home/yyuan/projects/Aelios
git checkout feat/multirole-memory
npm run typecheck && npx vitest run && node scripts/verify-assembler.mjs && node scripts/verify-cache-strategy.mjs
```

确认全绿即可。全部 8 个阶段已完成，无待做项。

---

## 八、部署清单

部署前需完成以下步骤（按顺序）：

1. **数据库迁移：**
   ```bash
   # 先备份！
   wrangler d1 export companion_memory_proxy --output backup.sql
   # 应用迁移
   wrangler d1 migrations apply companion_memory_proxy --remote
   ```

2. **环境变量配置（Cloudflare Dashboard）：**
   - `ROLE_MEMORY_ENABLED` = `false`（先关着，灰度验证后再开）
   - 其他变量有默认值，可暂不配

3. **部署 Worker：**
   ```bash
   npm run deploy
   ```

4. **Vectorize 回填：**
   ```bash
   CLOUDFLARE_ACCOUNT_ID=... \
   CLOUDFLARE_API_TOKEN=... \
   D1_DATABASE_NAME=companion_memory_proxy \
   VECTORIZE_INDEX_NAME=memo-kb \
   node scripts/backfill-vectorize-role.mjs           # dry run 先看
   node scripts/backfill-vectorize-role.mjs --apply    # 实际执行
   ```

5. **前端配合：** 聊天请求 body 加 `role_id`/`role_name`

6. **灰度验证：** 确认稳定后开 `ROLE_MEMORY_ENABLED=true`

---

## 九、关键注意事项

1. **D1 ALTER TABLE 不支持 IF NOT EXISTS** — 迁移 0006 只能跑一次
2. **daily_log 重建有数据丢失风险** — DROP TABLE + RENAME 中间中断会丢数据，先备份
3. **Vectorize metadata 需要回填** — 部署后跑回填脚本，未回填的视为 shared（向后兼容）
4. **前端需传 role_id** — 聊天请求 body 加 `role_id`/`role_name`，否则所有记忆落共享区
5. **做梦不翻倍调用** — 单次模型调用处理多角色分组（prompt 分段）
6. **ROLE_MEMORY_ENABLED 默认 false** — 灰度发布，确认稳定后再开
7. **不自动推送** — 等用户检查确认后再推送
8. **token 超限自动拆分尚未实现** — 当前依赖 DREAM_MAX_ROLES_PER_RUN 限制角色数，后续需加估算逻辑
9. **supersedeMemory 继承规则** — 修改已有记忆默认保留 role 归属，显式改归属需传新 role 参数
10. **baseline_texts 由模型生成** — 做梦 prompt 要求模型输出 `baseline_texts` 对象，代码逐 role_scope 保存
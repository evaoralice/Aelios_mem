# 角色记忆改造 — 开发交接文档

> 供后续接手开发的模型/人阅读。确保在上下文缺失时，仅凭本文 + 代码即可完整理解进度并继续。

---

## 一、项目背景

Aelios 是 Cloudflare Workers 上的 AI 记忆代理系统。本次改造目标：给记忆系统加角色维度（role_id/role_scope），让不同角色的记忆互相隔离、可加权召回，并引入长期基线 + 变更日志机制。

**相关文件：**
- `plan/角色记忆方案.md` — 原始方案（只读，不改）
- `plan/角色记忆实施方案.md` — 详细执行细则
- `HANDOVER.md` — 前一轮 5 阶段缓存与记忆改造的交接文档

**前置条件：** Phase 1-5 缓存与记忆改造已完成（分支 `feat/cache-memory-tweak`）。

---

## 二、分支与状态

**分支：** `feat/multirole-memory`（基于 `feat/cache-memory-tweak`）
**已推送 commits：**
- `7394c7e` — feat: multirole memory phases A-D
- `c01cd1c` — feat: multirole memory phases E-H + code review fixes
**本地未推送改动：** 8 个自查修复 + 7 个后续优化项

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

**验证状态：** typecheck ✅ / vitest 121/121 ✅ / verify-assembler 177/0 ✅ / verify-cache-strategy 15/0 ✅

**全部完成，无待做项。**

---

## 三、改动详情

### 8 个自查修复

1. 迁移文件 `#`→`--` + fact_key 索引建在 memory_lifecycle 而非 memories
2. listPendingChangelog 不传 roleScope 时查全部（不再默认 shared）
3. 流式/OpenAI/Anthropic 所有路径的 assistant 消息都传 role（streamOpenAI/streamAnthropic/chatCompletions 非流式 OpenAI）
4. applyDreamV2 更新 fact_key 记忆时从 existing 继承 role_id/role_name
5. OpenAI adapter 转发前删除 role_id/role_name 私有字段
6. MCP memory_recall handler 传 role_id/role_name 到 runRecall
7. extractPipeline 从最近 user 消息继承角色，传给 upsert/supersede/createVectorMemory/getActiveMemoryByFactKey
8. ROLE_MEMORY_ENABLED 真正生效 — isRoleMemoryEnabled() gate 在 role boost、baselines、pending changelog、baseline 生成

### 7 个后续优化项

| # | 内容 | 状态 |
|---|------|------|
| 6 | update/delete 归属语义 — MCP schema 去掉 role 参数；从目标记忆继承 | ✅ |
| 5 | daily_log 角色化闭环 — upsertDailyLog 传 roleScope；buildBootPackage 读 shared+当前角色 | ✅ |
| 1 | 多角色做梦分组接入 — roleGroups 在 buildDigestPrompt 调用前计算并传入 | ✅ |
| 7 | DREAM_MAX_ROLES_PER_RUN — 加入 Env 类型 + dailyDigest 读取 | ✅ |
| 2 | pending_changes 跨 provider — text 模式 formatDynamicMemoryText + OpenAI formatPendingChangesText | ✅ |
| 3 | role boost 前移 — reranker 前 sqrt(boost) 预boost + reranker 后 sqrt(boost) 后boost = 总boost | ✅ |
| 4 | 基线注入当前角色优先 — baselines 排序 shared→当前角色→其他；formatBootStable 8000字总量截断 | ✅ |

---

## 四、测试结构

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
    phase6517/       — 10 tests (后续项 6/5/1/7 测试)
    phase23/         — 7 tests (后续项 2/3 测试)
    phase4/          — 4 tests (后续项 4 测试)
  phase1-4_5/        — 前一轮改造测试
```

**运行命令：**
```bash
npm run typecheck && npx vitest run && node scripts/verify-assembler.mjs && node scripts/verify-cache-strategy.mjs
```

---

## 五、环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `ROLE_MEMORY_ENABLED` | `false` | 角色记忆总开关 |
| `RECALL_ROLE_BOOST_EXACT` | `1.3` | role_id 精确匹配加权 |
| `RECALL_ROLE_BOOST_NAME` | `1.1` | role_name 兜底加权 |
| `BASELINE_MAX_CHARS_PER_ROLE` | `2000` | 基线文本 per role_scope 上限 |
| `BASELINE_MAX_CHARS_TOTAL` | `8000` | 基线文本总量上限（写入+注入双重生效） |
| `DREAM_MAX_ROLES_PER_RUN` | `5` | 单次做梦最多处理角色数 |

---

## 六、部署清单

1. **数据库迁移（先备份！）**
   ```bash
   wrangler d1 export companion_memory_proxy --output backup.sql
   wrangler d1 migrations apply companion_memory_proxy --remote
   ```
2. **环境变量配置：** `ROLE_MEMORY_ENABLED` = `false`（灰度后再开）
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

## 七、接手后第一件事

```bash
cd /home/yyuan/projects/Aelios
git checkout feat/multirole-memory
npm run typecheck && npx vitest run && node scripts/verify-assembler.mjs && node scripts/verify-cache-strategy.mjs
```

确认全绿即可。全部完成，无待做项。

---

## 八、关键注意事项

1. **D1 ALTER TABLE 不支持 IF NOT EXISTS** — 迁移 0006 只能跑一次
2. **daily_log 重建有数据丢失风险** — 先备份
3. **Vectorize metadata 需要回填** — 部署后跑回填脚本，未回填的视为 shared
4. **前端需传 role_id** — 否则所有记忆落共享区
5. **ROLE_MEMORY_ENABLED 默认 false** — 所有角色功能 gate 在此开关
6. **不自动推送** — 等用户检查确认后再推送
7. **update/delete 归属从目标记忆继承** — MCP schema 不接受 role 参数
8. **daily_log 角色化闭环** — 写入默认 shared，读取合并 shared + 当前角色
9. **DREAM_MAX_ROLES_PER_RUN** — 限制单次做梦处理的角色分组数
10. **token 超限自动拆分尚未实现** — 当前依赖 DREAM_MAX_ROLES_PER_RUN 限制
11. **role boost 双段应用** — reranker 前 sqrt(boost) + reranker 后 sqrt(boost) = 总 boost
12. **pending_changes 跨 provider** — text 模式 formatDynamicMemoryText，OpenAI formatPendingChangesText，toolcall 模式 buildSyntheticContext
13. **基线注入排序** — shared → 当前角色 → 其他角色；总量 8000 字截断
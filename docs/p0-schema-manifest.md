# P0 Schema Manifest：旧 D1 → 新分支字段对照与处置

> 线上来源：`feat/memory-dimensions`（已应用迁移 0001–0010）对照新分支 `integration/upstream-v2`（当前迁移 0001–0020）。
> `fix/logic-review` 的 0001–0010 与线上分支逐字一致，仅作为线上分支之后的行为修复考古来源；无需先部署该中间分支。
> 本文件只对照 schema 形状，**不读取、不引用任何真实记忆正文**。
> 处置只有四类：**原样迁移 / 转换 / 可重建 / 明确弃用**；标 **待裁定** 的字段不得进入迁移 SQL（P7/P8 依据本表开工）。
> 上游迁移与新自定义迁移编号错位（两侧 0006–0010 同号不同物），**禁止在新库直接播放旧分支任何迁移**；结构补列已使用 0018–0020，P8 正式数据迁移一律另写 0021+。
>
> **P8 执行记录（2026-10-24）**：正式迁移落为 `migrations-p8/0021–0025`（刻意**不进** `migrations/`——引用旧库
> 独有的 role_scope/role_id 列，全新库与 tests 播放会 fail-loud，防误播）。线上同库升级顺序由账本引导承载
> （0018–0020 同构列已存在，先登记名字再让 `d1 migrations apply` 跳过），orchestrator
> `scripts/migration-p8.ts` 在一次性真实副本上完整演练并验收通过（两轮 findings=0、结果一致）。
> 原样迁移表全等、超界/公式不一致值原样、E 轴 NULL、孤儿只入报告；详见
> `docs/p0-migration-acceptance.md` §3/§4 勾选与 plan P8 完成块。

## 0. 全局规则（P1 验收已裁定，2026-10-10）

1. **存量 `weight` 原样保留**，不拿移植公式（`src/extensions/memoryWeight.ts`）重算覆盖；浮点差异会把迁移变成数据改写。新写入/更新才用移植公式。
2. **历史超界值（四维 >1 或 weight>1）只报告、不修改、不重算**；新入口继续"MCP 拒绝 / Dream 收敛"双层规则，公式内不 clamp。
3. **四维默认值不统一**：0.5（create）/ 0.6（fact_key upsert）/ 0.7（digest 归一化）/ 0.65（extract 归一化），迁移不涉及默认值。
4. **supersede 恒继承、updateMemory 仅显式提供四维字段才重算**：迁移不触碰这些语义。
5. 没有裁定的字段不得进入迁移 SQL；迁移中发现的每处冲突必须报告等裁定，**不得静默合并或覆盖**。

## 1. role_scope → namespace 映射（带 role 维度的行）

旧 `role_scope` 由 `computeRoleScope` 生成，取值只有三种（旧 src/utils/role.ts）：

| 旧 role_scope | 新 namespace | 说明 |
|---|---|---|
| `id:<role_id>` | `<role_id>`（去前缀原样） | role_id 是权威值 |
| `name:<NFKC 规范化名>` | `<规范化名>`（去前缀） | 仅名称无 ID 的角色 |
| `shared` | `shared` | 共享空间 |

规则：**带 role_scope 的行，新 namespace 完全由 role_scope 决定，旧 namespace 列丢弃**（仅记入迁移统计）。
新 namespace 必须能对上部署时 Gateway identity 的 namespace（slug），`shared` 是独立 namespace，是否可见由 identity 的 `readNamespaces` 授权，迁移只管归属正确。

**撞行规则**：多个旧 (namespace, role_scope) 映射到同一新 namespace 时——
- 基础行数不撞（memories/lifecycle 逐行迁，无约束问题）；
- PK 型表（daily_log、long_term_baselines）会撞主键：**冲突行先报告清单（含新旧键与行数），等用户裁定合并/取舍，SQL 不得带静默 dedupe**。

## 2. role-less 表的 namespace 规则（待裁定，开放项 #1）

以下表只有 namespace 列、没有 role_scope 可参照：`digest`、`precious`、`glossary`、`longtail`、`memory_candidates`。
处置：**行内容全部原样迁移**；namespace 映射**待 P7 输出各表 distinct namespace 统计后，用户按部署 identity 清单裁定**（选项：原样保留 / 映射 shared / 逐值映射）。迁移 SQL 用参数化映射表，不写死任何值。

## 3. 逐表对照

### 3.1 memories（核心表）

新分支目标列 = 0001 核心 + 0007（fact_key/version_status/superseded_by）+ 0011（authored_by/response_tendency）；**四维列由 P2 的 0018+ 迁移补建**。

| 旧列 | 处置 | 说明 |
|---|---|---|
| id / type / content / summary / confidence / status / pinned / tags / source / source_message_ids / vector_id / last_recalled_at / recall_count / created_at / updated_at / expires_at | 原样迁移 | 0001 同构 |
| importance | 原样迁移 | 不重算 weight 的输入之一 |
| namespace | 转换 | 按 §1 role_scope 映射重写 |
| role_id / role_name / role_scope | 转换后弃置 | role_scope 算出新 namespace 后旧列不进新表；映射统计（旧值→新值→行数）写入迁移报告 |
| emotional / recurrence / unresolved / weight | 原样迁移 | **等 P2 的 0018+ 建列后迁入**；weight 不重算（全局规则 1）；超界值只报告（规则 2） |
| ——新列 fact_key | 转换 | 从旧 `memory_lifecycle.fact_key` 回填（与 0007 回填逻辑一致） |
| ——新列 version_status | 转换 | `status='superseded'` → `superseded`，其余 → `current`（对齐 0007 的 UPDATE） |
| ——新列 superseded_by | 转换 | 从旧 `memory_lifecycle.superseded_by_id` 回填 |
| ——新列 authored_by / response_tendency | 置 NULL | 旧无来源，不伪造；E 轴只许亲手写，置 NULL 即"非亲笔" |
| status 值域（active/deleted/superseded/archived/low_confidence…） | 原样迁移 | 迁移原样携带（P5 审计确认，2026-10-11，`docs/p5-legacy-fix-audit.md` §2）。**注意：新分支 retention 现状会 30 天无条件物理删 deleted/superseded/expired 行**——P5-C（恢复 MEMORY_AUTO_DELETE 闸门 + 365 天窗口 + last_recalled_at 过期条件）是 P7/P8 硬前置，不修则迁移入的软删/版本链数据部署后 30 天内被毁 |

### 3.2 memory_lifecycle（侧车表）

| 旧列 | 处置 | 说明 |
|---|---|---|
| memory_id / fact_key / supersedes_id / superseded_by_id / review_reason / valid_as_of / last_seen_at / seen_count / last_injected_at | 原样迁移 | 0003 同构 |
| namespace | 转换 | 按对应 memory 的新 namespace（必须与 memories 行一致，迁移顺序 memories 先行） |
| role_scope | 转换后弃置 | 同 §1 |

### 3.3 messages / conversations（消息归属）

| 项 | 处置 | 说明 |
|---|---|---|
| messages 0001 核心列（id…raw_usage_json/created_at） | 原样迁移 | 同构 |
| messages.namespace / conversations.namespace | 待裁定（开放项 #2） | 建议：行有 role_id 时按 §1 同规则映射（`id:<role_id>`→新 namespace）；无 role_id 时保留旧 namespace 原值（宁可见性沉默，不丢归属）。待确认后进 SQL |
| messages.role_id / role_name、conversations.role_id / role_name | 转换后弃置 | 同 §1，只留映射统计 |
| messages.client_message_hash | 转换：置 NULL | 新 0010 已废除旧格式（无时间桶、跨时间重复文本会碰撞），存量 hash 与新格式不兼容；置 NULL 保留行、释放唯一索引，语义与新库启动时一致 |
| ——新列 seq | 转换 | 按 role 回填 user=0 / assistant=1 / 其他=2，对齐 0015 的 UPDATE |
| conversations.id/namespace/created_at/updated_at | 原样迁移 | record.ts 持续写入此表 |

### 3.4 daily_log

新分支目标形状 = 0004（namespace+date PK、title、summary、updated_at）+ 0013（source_message_ids）+ **0019（affect_chord，P4 已建列）**。

| 旧列 | 处置 | 说明 |
|---|---|---|
| date / title / summary / updated_at | 原样迁移 | |
| (namespace, role_scope) | 转换 | 按 §1 合成新 namespace；新 PK (namespace, date) 撞行 → §1 冲突规则 |
| affect_chord | 原样迁移 | P4 已建列（0019，旧 0009 同构），带/不带 chord 均可往返（P4 验收已过） |
| ——新列 source_message_ids | 置 NULL | 旧日记无来源标注，不伪造 |

### 3.5 Baseline 三表（旧 0006/0007 → 新 0017）

| 旧表 → 新表 | 处置 | 说明 |
|---|---|---|
| long_term_baselines (namespace, role_scope, content, version, generated_at) → 新表（PK namespace） | 转换 | content/version/generated_at 原样；(namespace, role_scope) → 新 namespace；同新 namespace 多行 = PK 冲突 → 报告清单等裁定，**不静默合并**（整组保留语义见 plan 阶段 3） |
| long_term_baseline_snapshots (+role_scope) → 新表 | 转换 | 同上映射；version/content/created_at 原样 |
| baseline_changelog (+role_scope/role_id/role_name) → 新表（op CHECK add/update/delete） | 转换 | op/before/after/reason/status/error_message/applied_at/created_at 原样（旧 op 值域同为 add/update/delete）；role 三列弃置；namespace 按 §1 |

### 3.6 软删除与审核队列

| 表/列 | 处置 | 说明 |
|---|---|---|
| precious 核心列（0003 同构） | 原样迁移 | |
| precious.status（旧 0008 软删除列） | **已落地（P5-B，0020，2026-10-11）**：`0020_precious_status.sql` 建列 `TEXT NOT NULL DEFAULT 'active'` + `idx_precious_namespace_status`，旧 0008 同构 | 读路径只见 active；删除走 `UPDATE status='deleted'` 行保留；INSERT 走 DEFAULT；新库已由 0020 建好落点，**P8 原样迁入旧值（值域 active/deleted，数据迁移文件 0021+）** |
| memory_candidates（0005 同构） | 原样迁移 | pending 审核队列语义保留（plan 边界 9）；namespace 待开放项 #1 |

### 3.7 其余表

| 表 | 处置 | 说明 |
|---|---|---|
| usage_logs（含 0002 两列） | 原样迁移 | 统计数据不丢；两侧同构 |
| memory_events | 原样迁移 | 新分支活跃使用（retention/dream/admin）；namespace 转换 = 对应 memory 的新 namespace，孤儿事件保留原 namespace 并报告 |
| digest | 原样迁移 | 每行小表；namespace 待开放项 #1 |
| glossary / longtail | 原样迁移 | namespace 待开放项 #1 |
| summaries | **原样迁移并归入 `shared`（2026-10-24 用户裁定）** | P7 实库仅 1 行，但 content 非空且覆盖 362 条消息，可能承载旧模型生成的重要历史摘要；即使新分支暂不读取也必须保留 |
| processing_cursors | **明确弃用（2026-10-24 用户裁定）** | P7 实库 224 行；仅为旧处理任务的游标/进度状态，不是知识正文。迁入陈旧游标既无读取方，也可能在未来复用时错误跳过任务。**P8 落法（线上同库路径）**：不迁移 = 清空该表（`0024` DELETE，224 条数量入迁移报告）——与"全新库从零开始"的语义对齐 |
| users / cache_entries / idempotency_keys | **明确弃用（2026-10-24 用户裁定）** | P7 实库均为 0 行，无数据可迁；只保留统计结论 |
| memory_changelog（旧 0006，原子记忆 pending，工具已停用） | **明确弃用（2026-10-24 用户裁定）** | P7 实库 0 行；不迁移数据，只保留统计结论 |

### 3.8 新分支独有表（旧无来源，不迁移）

`dream_runs`、`memory_relations`、`perception_cache`、`weekly_log`、`monthly_log`、`gateway_config`、`gateway_exchanges`、`message_fts`、`memory_fts`、`memory_triggers`。
其中 weekly_log / monthly_log 属**可重建索引**（P10 从 daily_log 生成，不抢迁移）；message_fts / memory_fts 由新分支 `backfillFts` 重建。

### 3.9 Vectorize（不在 D1，单列防遗漏）

旧向量 **不迁移、不信任旧 metadata**。P9 以迁移后 D1 为真源按新 namespace 重建/回填。D1 迁移不因 Vectorize 失败回滚。

## 4. 开放项（没裁定不进迁移 SQL）

1. ~~**role-less 表 namespace 映射**~~ **已关闭（2026-10-24 用户裁定）**：digest/precious/glossary/longtail/memory_candidates 全部先归入 `shared`；迁移后用户可按实际角色手动调整。SQL 仍集中参数化，不散落写死。
2. ~~**消息/对话归属映射**~~ **已关闭（2026-10-24 用户裁定）**：有 role_id 走 §1 同规则，无 role_id 保留旧 namespace。
3. ~~**旧六表处置**~~ **已关闭（2026-10-24 用户裁定）**：summaries 原样迁移并归入 `shared`；processing_cursors 不迁；users/cache_entries/idempotency_keys/memory_changelog 实库均为空且不迁。详见 §3.7。
4. ~~**precious.status**~~ **已关闭并落地（2026-10-11）**：P5 审计裁定仍缺 → P5-B 已实施（`0020_precious_status.sql`，旧 0008 同构，`tests/precious-softdelete.test.ts` 6 用例）+ P8 原样迁入（0021+）；见 §3.6 与 `docs/p5-legacy-fix-audit.md`。
5. ~~**memories.status 软删除值域在新分支 retention 的语义**~~ **已关闭（2026-10-11 P5 审计）**：迁移原样携带不变；retention 行为缺口（硬删闸门丢失、30 天窗口、expire 不看 last_recalled_at、lifecycle 侧车孤儿）由 P5-C 恢复旧行为，**P5-C 为 P7/P8 硬前置**；见 §3.1 与 `docs/p5-legacy-fix-audit.md` §2/§6。
6. ~~**usage_logs 体量**~~ **已关闭（2026-10-24 用户裁定）**：P7 实库 582 行，体量正常，全量原样迁移。

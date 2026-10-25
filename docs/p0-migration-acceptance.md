# P0 迁移验收清单（P7 演练 / P8 真实迁移共用）

> 配套 `p0-schema-manifest.md` 使用。执行原则：**dry-run 默认、真源不回写、副本可重复、冲突只报告**。
> 所有检查只涉及 schema/计数/哈希，不输出记忆正文。

## 1. 迁移前（P7 只读统计，线上或线上导出副本）

- [x] 线上来源确认：当前生产部署应为 `feat/memory-dimensions`，迁移账本应为 0001–0010；其 DDL 与 `fix/logic-review` 的 0001–0010 逐字一致，因此无需先部署 `fix/logic-review`。若分支或迁移账本出现偏离，停止迁移并重审（2026-10-24 inspect 已确认账本 10 条、形状一致）
- [x] 逐表行数清单（21 张旧表全量）（inspect 报告，本地 `.migration-work/`）
- [x] role_scope 取值分布（memories/lifecycle/daily_log/baseline 三表各值 × 行数）——§1 映射的输入
- [x] role-less 表 distinct namespace 清单：P7 已核对；用户裁定统一先归 `shared`
- [x] messages/conversations role_id 非空计数：P7 已核对；有 role_id 随角色映射，无 role_id 保留旧 namespace
- [x] 四维非空/非默认值计数；超界值计数与样例值域（只报数值不报内容）（已裁定：只报告不修改；P8 验收确认原样保留）
- [x] weight>1 / weight 与四维明显不一致的行数（报告用，不重算不修）（498 条不一致原样）
- [x] daily_log.affect_chord 非空计数（P4 迁入量预期）（55 行 35 非空，P8 逐字迁入）
- [x] baseline 三表 (namespace, role_scope) 分布 + 映射后 PK 撞行清单（实库冲突 0）
- [x] daily_log 映射后 (namespace, date) 撞行清单（实库冲突 0）
- [x] memory_lifecycle 孤儿行计数（memory_id 不在 memories 中）（6 条，P8 只入报告未迁入）
- [x] 迁移后新增列的来源核对：fact_key / superseded_by（来自 lifecycle）、version_status（来自 status）、seq（来自 role）（fact_key 回填 195、superseded_by 0、version_status 全 current、seq 24/22）

## 2. 演练可重复性（P7 验收）

- [ ] 同一副本第二次演练：不重复复制、不破坏数据、前后校验结果一致
- [ ] dry-run 与真实执行逻辑分离，工具默认 dry-run
- [ ] 真实执行需要显式开关 + 输出执行日志

## 3. 迁移中（副本演练，P8 已执行）

- [x] 迁移顺序：memories → memory_lifecycle →（P2 列建好后）四维列迁入 → daily_log → baseline 三表 → 其余行表（P8 落法：memories/侧车=0021，daily_log=0022，baselines=0023，其余=0024，role 列收尾=0025；四维列线上已由旧 0010 同构存在，账本引导跳过新 0018）
- [x] 每表 INSERT 用显式列名清单（禁止 `INSERT INTO t SELECT *`，防上游加列后错位）（0021–0023 全部显式列名）
- [x] 旧分支迁移文件（0006–0010）不在新库播放；结构补列使用现有 0018–0020，P8 正式数据迁移从 0021+ 新写（0021–0025 在 `migrations-p8/`，不进 `migrations/`——引用旧库独有列，全新库播放会 fail-loud）
- [x] weight 全程不重算（已裁定）；四维/超界值原样拷贝（947 行逐行哈希验证，weight 统计前后一致）
- [x] 所有撞行/冲突走报告表落盘，无一例静默合并或覆盖（实库冲突 0；orchestrator 预检非空即拒绝）
- [x] summaries 原样迁移并归 `shared`；processing_cursors 不迁（线上同库路径 = 清空该表，224 条数量入报告）；四张空旧表不生成数据行
- [x] usage_logs 582 行全量原样迁移；6 条 lifecycle 孤儿只进报告、不迁入目标侧车（0021 删除，pre/post 计数与 ID 清单入报告）

## 4. 迁移后逐表校验（副本上先跑通，再谈线上）

> P8 已在 `/tmp/aelios-latest.sql` 的一次性真实副本上完成两轮验收（2026-10-24），`migrations-p8/` + orchestrator 产出：

- [x] 逐表行数：原样迁移表前后一致；转换表差异逐行可解释（映射统计表）（counts.post vs expected 全过；lifecycle 781→775 = 6 孤儿、cursors 224→0、memory_changelog 删除）
- [x] 字段非空计数：四维、weight、affect_chord、fact_key、tags、source_message_ids 前后一致（置 NULL 项按预期递减并注明）（client_message_hash 24→0=新 0010 语义；fact_key 195=lifecycle 非孤儿非空源；source_message_ids 全 NULL）
- [x] 抽样哈希比对：每表随机抽样（不含弃用表），行内容哈希迁移前后一致；weight 原样值参与哈希（P8 用**全表逐行**哈希替代抽样：携带列 map 逐表全等）
- [x] namespace 映射审计：每行新 namespace ∈ 允许集合（identity 清单 + shared），无一行落回旧 namespace（role 行）（行级归属 map 0 偏差；identity 白名单核对留部署时按最终清单复核）
- [x] PK 完整性：daily_log/baseline/memories 主键无冲突残留；lifecycle.memory_id 全部可关联（孤儿 post=0）
- [x] 软删除值域统计：status 各值迁移前后行数一致（precious active/deleted、memories 值域分布前后一致）
- [x] 回滚演练：副本可回滚到迁移前状态（0018+ 的逆操作或重放副本），回滚后校验通过（落法：一次性副本从源导出可重复重建，`--force` 重跑两轮结果一致；线上回滚依赖迁移前 `wrangler d1 export` 备份，见报告 runbook）

## 5. 迁移后运行期验收（线上执行后，配合阶段 1–3 已有验收）

- [ ] baseline 注入：各 assistant 只看到自己 namespace 的 baseline；无 baseline 不报错
- [ ] 日读取：`daily_log_read` 能翻到迁移过来的历史日期；其他 namespace 读不到
- [ ] 旧角色记忆：`readNamespaces` 配置后可授权召回；同等相关性下本 ns 记忆排 shared 前（boost）
- [ ] 四维：迁移行 weight 与四维原样可见（P2/P3 完成后）
- [ ] affect_chord：带 chord 的旧日记往返无损（P4 完成后）
- [ ] Vectorize：P9 重建后向量命中可落到 D1 真实行，无孤儿向量

## 6. 报告产物（每轮演练落盘，命名含日期与副本标识）

1. 迁移前统计（§1 全项）
2. 映射统计表（旧 namespace/role_scope → 新 namespace × 行数）
3. 冲突清单（PK 撞行、孤儿、超界值，等裁定）
4. 逐表校验结果（§4）
5. 弃用表行数统计（users/summaries/cache_entries/processing_cursors/idempotency_keys/memory_changelog）

> P7 产物：`.migration-work/aelios-latest.*`（inspect/rehearse）；P8 产物：`.migration-work/p8/aelios-latest.rN.*`
> （未脱敏一次性副本 + 验收报告 + runbook）。均属本地敏感文件（gitignored），不可提交、不可外发。

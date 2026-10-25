# Aelios 开发指南

## 分支

- 当前开发分支：`integration/upstream-v2`（基于上游 `v2.0.0`，本地尚未推送；集成方案见 `../plan/Aelios-upstream-v2-baseline-integration.md`，按 plan 的 commit_policy 整体完成后一起提交）
- 旧分支 `fix/logic-review` 保留不动，不合并
- 上游：`https://github.com/wusaki0723/Aelios.git`（remote `upstream`）

## 本地运行

```bash
nvm use 22          # 需要 Node >= 22（node:sqlite）；无 nvm 时 export PATH=/home/agent/.nvm/versions/node/v22.23.1/bin:$PATH
npm ci --ignore-scripts
npx wrangler dev    # 本地开发服务器
```

## 测试

改代码后跑测试（目前 384 个测试，node:test + tsx）：

```bash
npm test                                        # 全量测试
node --import tsx --test tests/baseline.test.ts # baseline 闭环（阶段 1–3）
npx tsc --noEmit                                # 类型检查（npm run typecheck 含 tests 配置）
npm run verify                                   # typecheck + 全量测试 + 4 个 verify 脚本
```

## 部署

- **自动部署**：push 到 GitHub 触发 Workers Builds
- 手动部署见 README；**不要在本分支未经用户确认时推送**（会触发自动部署）
- 部署时必须设 `ENABLE_DIARY_WRITER=false`（否则 Dream 代写日记，覆盖模型手写路径）和 `CANDIDATE_JUDGE_ENABLED=false`（集成方案边界 7）

## 注意事项

- baseline/日记固定背景注入在 `src/gateway/background.ts`；三种协议落点不同（system / instructions / chat 首条 system 消息），改动注入格式时三协议和 `tests/baseline.test.ts` 一起验
- MCP 工具面对模型只暴露 `daily_log_read`（功能并集）；上游 `diary_get` 从列表隐藏但 callTool 仍兼容直调
- **方案 D（namespace 归属）**：`baseline_change` / `daily_log_write` / `daily_log_read` 无 namespace 参数，归属由 endpoint URL 决定——`/mcp/<identity>` 强制绑定该 identity 写入空间；全局 `/mcp` 上这些工具报错不回退 default。identity.keys 现允许 MEMORY_MCP_API_KEY（`gateway/config.ts` KEY_NAMES）。前端对接说明见 `docs/UPDATE-v2-baseline-mcp.md`
- 迁移已到 0020（0018 四维权重列 = 旧分支 0010 同构；0019 daily_log.affect_chord = 旧分支 0009 同构；0020 precious.status = 旧分支 0008 同构）。线上 D1 来源是 `feat/memory-dimensions` 的重号迁移 0001–0010；其迁移 DDL 与 `fix/logic-review` 逐字一致，**无需先部署 `fix/logic-review`**。P8 旧数据迁移必须另写 0021+，禁止直接播放上游或旧分支的 0006–0010
- **迁移契约（P0 产物）在 `docs/p0-schema-manifest.md`、`docs/p0-migration-acceptance.md`、`docs/p0-touchpoint-manifest.md`**：P2/P4/P7/P8 开工前先读处置与开放项；没裁定的字段不进迁移 SQL；四维公式只准调 `src/extensions/memoryWeight.ts`
- **affect_chord（P4）**：daily_log 可选情绪和弦，规则（归一/渲染/工具描述）集中在 `src/extensions/affectChord.ts`，日志层只存/返回；语义 = 旧分支：新值替换、省略保留（DB 层 COALESCE）、无运行期格式校验、注入渲染独立一行 `♪ <chord>`；唯一模型写入口是 MCP `daily_log_write`
- **adaptive thinking（P6）**：messages 协议主模型的 thinking 策略在 `src/extensions/adaptiveThinking.ts`（模型识别 4.6+/Fable/Mythos 5+、manual/adaptive 模式、effort 缺省补全、budget→effort **不换算**——旧分支复核裁定）；唯一入口是 `applyThinkingPolicy`（protocol.ts，prepareGatewayRequest 调一次，P6 前调用签名多了可选 env 参数）；四项设置 ANTHROPIC_THINKING_MODE/EFFORT/BUDGET/ENABLED 全不配时请求逐字节透传
- **P5 审计（2026-10-11）**：旧分支五组修复的"上游已替代/仍缺"结论在 `docs/p5-legacy-fix-audit.md`；仍缺项拆成 P5-A～G 独立实现包，**P5-A（MCP 软删，`tests/mcp-soft-delete.test.ts`）、P5-B（precious 软删，0020 迁移 + `tests/precious-softdelete.test.ts`）、P5-C（retention 保护，`tests/retention-gate.test.ts`）、P5-D（filter 失败不落 longtail，`tests/recall-filter-longtail.test.ts`）与 P5-E/F（CORS 白名单 + noindex，`tests/cors-noindex.test.ts`）均已落地（2026-10-11）**——P7/P8 的 retention 与 precious 前置全部解除。MCP `memory_delete` 与 precious 删除均不再物理毁行（status='deleted' 行保留）；MCP `memory_get` 对软删行报 not found（REST GET 保留可读供核查）；v2 recall 的 reranker fail-closed 失败不再落入 longtail 兜底（`filterFailed` 接线，fail-open/真空/disabled 不拦）。传输层（P5-E/F）：fetch 入口单一 wrapper 接 CORS + x-robots-tag，业务路由不动——`CORS_ALLOW_ORIGINS`（types/settings/coverage 同步，/admin 可调）不配 = 无任何 CORS 头，配了才精确等值匹配（不吃通配/前缀）；全部响应带 `x-robots-tag: noindex, nofollow`，admin 两页 HTML 另有 meta robots。**P5-G 已由用户裁定并落地：`workers_dev=false`、`preview_urls=false`，不暴露默认 workers.dev 与预览地址**。MCP 与 REST 删除语义一致；`src/index.ts` 的 fetch 入口现为 wrapper → `routeFetch`，改动路由时认准 routeFetch
- **P5-H 审计（2026-10-11）**：`docs/p5h-historical-behavior-gap-audit.md`，全史行为缺口扫描；新发现拆 P5-H1～H6（时间锚渲染、persona/precious/glossary 注入位置、proxy 规则、SOURCE_BOOST、user_id）。**P5-H1 已落地（2026-10-18）**：`src/memory/surface.ts` 召回渲染恢复旧 2efa467 的 `- [kind][YYYY-MM-DD] 正文`；日期只取 `recordedDate`（created_at）前 10 位，缺日期只省略日期标签、缺 kind 仍按原逻辑丢弃条目不伪造。H2～H6 仍未实现，多数需用户先裁定注入位置
- **四维读取/排序规则（P3 裁定）**：D1 是四维与 weight 的唯一真源，**不写进 Vectorize metadata**（旧版如此，排序前各路径都能回读 D1）；**`getVectorMemory` 读取顺序 = D1 先于 Vectorize metadata**（有 D1 本体必返 D1 完整记录，仅 D1 查不到才返回孤儿 metadata 记录，ref_id 对得上 D1 时仍以 D1 为准）；召回排序公式只准调 `src/extensions/memoryRanking.ts` 的 `memoryRankScore`（旧版 `score + importance*0.05`，weight 不参与排序），不得在上游散落复制
- **迁移预演工具（P7）**：`scripts/migration-rehearsal.ts`（`npm run migration:inspect` / `migration:rehearse`，模块在 `scripts/migration/`）。默认 inspect（dry-run 零写入）；rehearse 只写脱敏副本（正文列确定性掩码）+ `.meta.json` 溯源。源库 readOnly 打开 + 前后 sha256/计数比对；冲突行（daily_log/baselines 撞新键）**原样保留等裁定**，不映射不合并；未知 role_scope 同样只报告。重复运行复用副本且字节不变。**隐私口径（2026-10-11 收口）**：stdout 只打表名与数量（namespace/role_scope/角色名/冲突键/allowlist 值只进本地 JSON 报告）；掩码列含 affect_chord、fact_key、raw_usage_json、游标值等任意内容列（结构键原样保留）；`--copy`/`--report` 缺省一律落 `.migration-work/`（已 gitignore）。**副本与报告即使经掩码仍属本地敏感文件，不可提交或外发**；处置完可整体删除 `.migration-work/`。测试 DDL 在 `tests/fixtures/old-branch-schema.sql`（由 `fix/logic-review` 0001–0010 生成，但与线上 `feat/memory-dimensions` 逐字一致）。
- **P8 正式迁移（2026-10-24，已接入自动部署链）**：SQL = `migrations-p8/0021–0025`（memories 映射+侧车回填→daily_log 重建→baselines 重建+memory_changelog 弃置→role-less/消息/游标→role 列收尾），每个文件**末尾自带 `INSERT INTO d1_migrations`**（wrangler `d1 execute --file` 整文件单事务，记账与数据同事务；构建中断重跑按账本跳过已完成步骤）。**不进 `migrations/`**——引用旧库才有的 role_scope/role_id 列，全新部署/测试会撞 no such column，fail-loud 防误播。**线上部署 = 推 GitHub，不再逐条手跑 wrangler**：`npm run deploy` 的 setup 阶段（`scripts/setup-cloudflare.mjs` → `scripts/p8-deploy.mjs`）自动识别远端 D1 谱系——全新库只走普通 migrations/；旧 `feat/memory-dimensions` 库自动执行"账本引导 0018–0020 → 普通迁移剩余（0006–0017，0017 是结构 no-op）→ 0021–0025 → P8 post-verify"；已完成 P8/全新谱系跳过特殊升级。无法识别或结构矛盾 → 立即失败、**不部署 Worker**（`npm run deploy` 的 `&&` 短路）。
  **上线前置条件（用户自理，脚本不备份）**：用户已主动 `wrangler d1 export` 备份线上 D1 并确认恢复点。
  **写入冻结 = 两阶段 Git 发布（旧库升级必须照做）**：迁移发生在部署之前，正在跑的旧 Worker 无法被"同一次构建"冻结，所以拆两次推送：①**stage 1 冻结推送**——把 `wrangler.toml [vars]` 里常驻的 `MAINTENANCE_MODE = "false"` 改为 `"true"` 后 push；构建识别旧库+维护态 → 跳过全部 D1 变更，只部署维护态 Worker（`fetch` 除 `/health` 全 503、`scheduled` 跳过、`queue` retryAll 不消费），确认构建成功后线上写入已冻结；②**stage 2 解冻推送**——把 `MAINTENANCE_MODE` **显式改回 `"false"`**（**勿删行**：deploy 用 `--keep-vars`，不在 toml 里的远端 plain_text 变量会被保留，删行解不了冻、服务会永久 503；在 toml 里的键部署时总是覆盖远端同名值）后 push；此时线上无写入，setup 自动完成全部迁移 + post-verify，随后部署正常 Worker。MAINTENANCE_MODE 行必须**常驻 `[vars]`**（默认 `"false"`），缺键/拼错/空值会让 setup 直接构建失败（`resolveMaintenanceMode`，`scripts/p8-deploy.mjs`）——防止"删行解冻"这类静默锁死。MAINTENANCE_MODE 是部署时变量（读 `deployed`，/admin 不可覆盖），注册在 `tests/settings-coverage.test.ts` 的 INTERNAL。
  **未来迁移规则（P8 后新增普通迁移）**：编号从 0026 起（0021–0025 被 P8 保留）；classify 对已完成库只看"旧 10 + P8 5"是否齐，新增普通迁移（含未应用）不会把库误判回 unknown/legacy-pending，由 `d1 migrations apply` 续跑；但**旧库升级序列**（legacy-pending 路径）遇 migrations/ 编号 >0020 的文件会中止构建——0026+ 是为 P8 后形状写的，不能先于 0021–0025 应用，等所有旧环境完成 P8 后再加入。
  **失败恢复边界**：P8 文件单事务 + 自带记账 → 中断后重推只补未记账文件；普通迁移（0006–0017）由 wrangler 自己的事务/账本语义负责，半应用的非幂等文件（如 0007 的 ALTER）需从备份恢复。post-verify 失败（role 列残留/账本缺项/游标未清/形状不对）同样中止构建——**fail-closed：账本齐全只证明"执行过"，不证明"验证过"**：postVerify 全部成功后部署链才写持久验证标记表 `p8_verification`（单条 CREATE TABLE、单语句事务；应用代码不读它，线上升级过的库比全新部署多这一张表）。"P8 五条已记账但缺标记"的库（post-verify 从未成功，或验过→写标记之间中断）在下次构建被**强制重跑 post-verify**，失败即不部署——不会出现"验证失败 → 重推 → 跳过校验部署坏库"；修复（备份恢复或手工修）后重推，重验通过补写标记才放行，此后恢复正常 legacy-done 路径（标记在则不重验：processing_cursors 清空是迁移时刻不变量，正常运行会重新写入）。**发布前验收**：离线 orchestrator `scripts/migration-p8.ts`（`npm run migration:p8 -- --source <导出>`，模块 `scripts/migration/p8.ts`）在未脱敏一次性真实副本上跑同一份 SQL 做全量 P0 §4 验收（真实导出两轮 findings=0、结果一致）。Vectorize 重建属 P9，不在本包
- `wrangler.toml` 的 `[vars]` 每次部署覆盖 Dashboard 同名变量，敏感值只放 secrets
- **P9 迁移后索引修复（2026-10-25；同日 P9-DS 修订）**：`/v1/p9-reindex` 与 `/v1/fts-reindex` 是**单 namespace** 入口——每次请求只处理一个 namespace、一个有界批次，返回 pending/converged，调用方逐 namespace 重复到收敛；**无任何全空间操作**。namespace 鉴权走与全部 memory 端点相同的 `resolveNamespace`：chooseNamespace=false 的 key 钉死绑定空间（请求他空间无效），省略 namespace 落回 profile 默认。`vectorBackfill` stale 判定纳入 **namespace**（P8 漂移缺口）；**扫描与修复计入同一份保守子请求预算**（900，修复次数 = min(limit, 剩余预算/2)，测试可直接传 `subrequestBudget`）；队头持续失败堵批次时用 `skip` 游标跳过（失败项仍留在 pending 上报）；active 行 > 5000 触 `scan_truncated` blocker，不得声称 converged。FTS：backfill/rebuild 的**顶层 D1 查询失败与 rebuild 清空失败都进 fatal → ok:false/converged:false/500，不伪装成功**（清空失败不继续重建）；**不可分词内容**（"..."、emoji、单停用词）写 `fts_body=''` 空标记行成稳定终态，单独统计 `unindexable`、不阻止收敛、不参与搜索，内容更新成正常文本时由正常写入路径替换（`upsert*Fts` 布尔语义不变，业务调用方零改动）；`fts limit` 是跨 messages/memories 的**总**上限（硬上限 100，见下条）；rebuild 显式指定 namespace 时清两层（本 ns 行 + D1 归属本 ns 但 fts 行停在旧 ns 的迁移残留），**P8 后每 namespace 首个 rebuild 必做**。`vectorDoctor` 存在性查找不按 namespace 过滤（漂移向量判 backed_* 不误删）且样本不带 content_preview。**runbook 见 `docs/p9-runbook.md`**（含 P12 待验证项：Vectorize 同 ID 跨 namespace 真实行为不凭猜测承诺）。p9/fts 输出只含计数、无正文；doctor cleanup 仍只认显式 `true`。测试 `tests/p9-reindex.test.ts` 21 用例 + `tests/vector-backfill.test.ts` 8 用例
- **P9 最终收口（2026-10-25，DS 二轮）**：①三个旧向量维护入口（`/v1/vector-doctor`、`/v1/vector-backfill`、`/v1/debug/vector_reindex`）统一 key profile 鉴权（`resolveStrictNamespace`，复用 `resolveNamespace` 不新增鉴权机制）——chooseNamespace=false 的 key 显式请求非绑定 namespace 直接 **403，发生在任何扫描/写入/删除之前**；省略 namespace 用绑定空间；chooseNamespace=true 显式跨空间行为保留。P9/FTS 两个入口维持首轮裁定的"钉绑定空间"语义不变（维护工具拒绝得响、P9 单批入口钉得住，两套行为都有测试钉死）。②`purgeOrphanFts` **限定当前 namespace**（跨空间 orphan 留给各自空间的 backfill；无 namespace 的调用直接跳过 purge）；purge 删除失败进 `fatal`（不再只 console.error）；迁移残留仍归 rebuild 两层清空，不与 orphan 混。③vectorBackfill 扫描按 **MAX_SCAN+1 探测**：恰好 5000 条不误判 truncated，5001 才触发 blocker。④FTS 单次总上限收紧为**硬上限 100**（`FTS_BACKFILL_MAX_LIMIT`：写放大最坏 6 子请求/行 ≈ 604 < Workers 1000；cron 的 400 同样在内部 clamp），响应带 `requested_limit`/`effective_limit`。runbook 同步：全端点强制 key profile（无"可选"表述）、输出"无正文但 ID 可能出现=敏感运维输出"、P12 三项待实测。测试 `tests/p9-reindex.test.ts` 28 用例
- 运行期改设置走 `/admin`（存 D1，优先于 Worker 变量）；新环境变量必须同步 `src/gateway/settings.ts`、`src/types.ts` 和 `tests/settings-coverage.test.ts`，否则 coverage 测试挂
- `biome lint .` 会扫到 `.backups/`（工作区快照目录）报错，属于已知噪音；新代码 lint 用 `npx biome lint <文件>` 单查

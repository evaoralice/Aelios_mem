# P5-H 历史行为缺口扫描（fix/logic-review 全史 → integration/upstream-v2）

> 方法：只读考古。脱离 P5 既有清单，以 `fix/logic-review` 的完整 Git 历史
> （9d38d0b..c662210，共 ~180 commit）为锚，辅以旧分支文档（`plan/遗留待解决问题.md`）、
> 旧测试（test/phase1-5、vitest 系列）和实际调用链，系统寻找更早的缓存与召回
> 行为是否在当前工作树（P0–P6 已完成）丢失。
> 证据格式：`旧分支 commit` + 当前 `文件:行号`。本包不改任何代码；
> 真实缺口只拆独立实现包（§6），与 P5-A～G 去重（§5）。
> 分类口径：**当前仍保留 / 上游新架构替代 / P0–P6 已覆盖 / 当前确实丢失**；
> 需实验项为附属（挂靠对应行为项，不单独成类）。

> **实施状态（2026-10-18）**：P5-H1 已完成并验证（`src/memory/surface.ts`
> 渲染 `- [kind][YYYY-MM-DD] 正文`，仅取 `recordedDate`，缺日期省略标签、
> 缺 kind 维持丢弃；正文与召回管线不变）。H2～H6 仍未实施。本文其余内容保持
> 2026-10-11 审计原状。

## 0. 扫描范围与结论总表

### 扫描的历史范围

- 全量 `git log fix/logic-review --oneline --no-merges`（9d38d0b 发布 → c662210 最后一笔）
- 已剔除（P5/P6/P0–P4 审计过）：4cc0263、ee71f87、4d2b87b、4882057、78e2a7e、
  3e37fb3、dc2afc5、77e25c0、89c2240、5920dd6、43dbb4d、540f0c8、4a5614d（附注）、
  b71c941、6f0b2cf、d123991、f7a5da4、efb77b5、4360579、2efa467 的 chord 部分、
  fb03627/1612db0/7b9f146、95fe33e/bbe82ff/a6df98f/0e81928 的主体（阶段 1–3 接管）
- 本轮逐个看 diff/正文的行为 commit：ac0ee56、8fcf434、8f5ed75、0088746、cf811d5、
  34111ec、f67e4f6、3d86d56、52adf2a、a1d1ee1、6969cbb、a73e0de、188e314、
  032555f、4eaeb8d、c7f5477、cc429bd、63d2cbb、3990cd0、69cffd2、51ccfc7、a959ecd、
  8d5e411、4616652、0fe49e7、150b887、d1930b2、084a83d、860136b、96d765f、2660af4、
  60404bf、d245ff0、5d6b87f、fecb6cf、e3179af、c40d375、084a83d、a1677ac、3a51ee1、
  e0ba0bf、89d72d9、60df148、9d05677、ba51200、5f02be5、acd8579、c662210、1f98405，
  以及 filter 调优系列（4aadcde、3387784、1e4126a、bdc4d61、729d2d5、79ee3bb、
  710e4cb、c213346、937a772、f1aea82、999d26b、4a2bb02）与 docs 系列
- 旧文档专项：`plan/遗留待解决问题.md`（1f98405 + c662210 两版全文）

### 结论总表

| # | 行为单位（用户/模型可观察） | 旧出处 | 当前分支证据 | 结论 |
|---|---|---|---|---|
| 1 | recall 分数地板 RECALL_MIN_SCORE=0.15 + MCP `min_score` 参数 + floored meta | 032555f + 4eaeb8d | `src/memory/v2/recall.ts:68,405-416,575-630`；`src/api/mcp.ts:811`；`settings.ts:19`；REST 同款（memories.ts:259） | **当前仍保留** |
| 2 | vectorTopK 钳 50（Vectorize returnMetadata 硬上限，防 500） | cc429bd | `src/memory/search.ts:289-291`（注释逐字同款） | **当前仍保留** |
| 3 | legacy（无过滤）向量查询要求 metadata 显式匹配 namespace | 63d2cbb | `src/memory/vectorStore.ts:645-649`（注释同款） | **当前仍保留** |
| 4 | unfiltered fallback 强制过滤跨 namespace + status≠active 记录 | 3990cd0 | `src/memory/search.ts:294-312` | **当前仍保留** |
| 5 | 消息稳定 hash 幂等去重（conversationId+role+归一 content，重试不重存） | 188e314 | `src/db/messages.ts:26-59,85` | **当前仍保留** |
| 6 | 注入衰减闸三（last_injected_at 窗口降权，30min/0.5 可配） | a959ecd 系前史 | `src/memory/v2/recall.ts:46-57,485-495`（且上游 #37 修正：降权不参与地板判定——增强） | **当前仍保留** |
| 7 | `daily_log_write` 服务器端日期 + title 保留 + summary 追加 + 长度校验 | a6df98f | `src/api/mcp.ts:1006-1028`（合并上限 2000 为上游增量） | **当前仍保留** |
| 8 | `memory_list` type/status 过滤（默认 active） | 4616652 + 0fe49e7 | `src/api/mcp.ts:649-653`（listMemoriesPage D1 路径） | **当前仍保留** |
| 9 | 侧车/批量查询分批（SQLITE_BIND_BATCH_SIZE=100 / FETCH 90） | 150b887 + 084a83d.5 | `src/db/v2/shared.ts`、`src/db/v2/memories.ts:159,820-833`、`src/db/memories.ts:176` | **当前仍保留** |
| 10 | Vectorize metadata 数组走 JSON.stringify | e3179af | `src/memory/vectorStore.ts:88-89` | **当前仍保留** |
| 11 | 写工具错误结构化返回（toolError(error.message)） | c40d375 | `src/api/mcp.ts:879-881`（memory_upsert 同款） | **当前仍保留** |
| 12 | `memory_ingest` / direct search API | ffb0fbf + 55272d5 + 48a1fee | `src/api/mcp.ts:752`、`src/api/memories.ts:1157` | **当前仍保留** |
| 13 | v2 升级无损（MEMORY_LIFECYCLE_ENABLED 总闸、默认开） | 60404bf + b46e9c8 | `src/memory/v2/recall.ts:33-34`、mcp.ts 各工具 gate | **当前仍保留** |
| 14 | legacy 向量与 namespace 向量并查 | d1930b2 | `src/memory/vectorStore.ts:620-623`（Promise.all） | **当前仍保留** |
| 15 | dream digest 解析容忍 reasoning_content | f1aea82 | `src/memory/dream/extractPhase.ts:175-177`（content‖reasoning） | **当前仍保留** |
| 16 | 向量记忆持久化 D1（向量与 D1 同写） | d245ff0 + 5d6b87f | `insertMemoryRecord`/`updateMemoryRecord`（vectorStore.ts） | **当前仍保留** |
| 17 | namespace 写进向量 metadata | fecb6cf | `src/memory/vectorStore.ts:77` | **当前仍保留** |
| 18 | dream 自动链不毁 pinned/亲笔记忆 | 084a83d.1（state.ts 层） | `src/memory/dream/lifecyclePhase.ts:147`（pinned DB 级跳过）+ `extractPhase.ts:61`（prompt 级）+ `helpers.ts:265`（短空清理跳过 pinned）+ `HandAuthoredProtectedError`（E 轴，上游增强，db/v2/memories.ts:451-453） | **上游新架构替代**（守卫位置从 sync 层移到 dream 链/DB 层，主动删除面两侧均无守卫——行为一致） |
| 19 | 写时 embedding 判重限定同 scope（跨角色召回是特性、写时不误杀） | 69cffd2.2 | `src/memory/dedupGate.ts:11-40`（findSimilarActiveMemory 限 namespace）+ 63d2cbb 防护 | **当前仍保留**（role_scope→namespace 映射） |
| 20 | extract 按 role_scope 分组（混合窗口不误归属、组失败不推 cursor） | 69cffd2.1 | 消息表按 namespace 第一维存储（`src/db/messages.ts:64,170-173`），Dream 按 namespace 循环 | **上游新架构替代**（结构性消除混归属问题） |
| 21 | digest 手动 backfill 端点 | a1677ac | `src/index.ts:84-86`（runDreamBackfill 进 scheduled 维护序列，自动补跑） | **上游新架构替代**（自动序列强于手动端点） |
| 22 | `memory_search` 假 role 参数 / 返回压缩文本 / ingest 缺角色 | c662210（旧分支自认缺口，未修） | 方案 D endpoint 绑定（mcp.ts:596-606 返回 searchMemories **原文**，无 filter 压缩） | **上游新架构替代**（旧分支自己没修的五个问题在新架构下 #1/#4/#5 结构性消解，#2/#3 由单 ns 搜索 + Gateway boostNamespace 覆盖） |
| 23 | v1 两段式 filter 调优（reranker+compress prompt 规则、单候选也跑、nullish 跳过等） | 4aadcde、3387784、1e4126a、bdc4d61、729d2d5、79ee3bb、710e4cb、c213346、937a772、999d26b、b756a6c | 上游 `filter.ts`（v2/recall.ts:479 在用）+ reranker 单段 | **上游新架构替代**（P5 §8 已裁定不搬；P5-D 只接线 filterFailed） |
| 24 | v1 队列 extract 50 消息窗口 / v1 long-term summaries / v1 文本搜索降级链 | 2660af4、7e7ded2、a0e1eed、68118dd、ee612ae、e264b4b、f2d0496、95acc38、bc921ab | 上游 v2 体系（dream 按天窗口、baseline+impressions、queryShape 词面 + FTS） | **上游新架构替代** |
| 25 | dream digest 调优（batch/prompt/时长约束） | 065ceef、62d1ecd、6b0394a、14db343、2097bb2、d97db04 | 上游 dream 管线 + 阶段 2/3 裁定（日记由模型写） | **上游新架构替代** |
| 26 | D1+Vectorize 统一 state/sync 层（reindex 安全、sync retry） | 860136b、d34a1da、084a83d.2/.3 | vectorStore 写路径一致性 + vectorDoctor/vectorBackfill（P9 域） | **上游新架构替代** |
| 27 | tool_call/tool_result 历史保序、防重复 MCP 调用、stream 空保存跳过 | 89d72d9、60df148、9d05677、ba51200、5f02be5 | 透传网关：客户端组装消息，服务端不重组；重复保存由 #5 hash 幂等覆盖 | **上游新架构替代**（assembler 时代的服务端重组问题不存在） |
| 28 | baseline REST 审核面（list/apply/conflict/reopen） | bffd3fa、4325db8 | — | **P0–P6 已覆盖**（plan 阶段 3 裁定：本轮不移植，阶段 4 后单独决定） |
| 29 | 迁移拆分原则（已应用迁移不追加表） | e0ba0bf | P0/P7/P8 设计（另写 0020+，不播放重号 0006–0010） | **P0–P6 已覆盖**（原则吸收进迁移策略） |
| 30 | **召回注入时间锚 + 类型标签** | 2efa467（RecallHit.created_at → `[type][YYYY-MM-DD]`） | 审计时 `src/memory/surface.ts` 只渲染 `- content`；kind/recordedDate/eventDate 字段在 `SurfaceEntry` 里存在但**从不渲染** | **当前确实丢失**（P5-H1，**2026-10-18 已落地**） |
| 31 | **persona/identity 类型记忆固定注入**（persona_pinned 块，每轮在场） | 0088746/assembler + 494e6f2（tool fallback 补注入） | Gateway 主链无特殊处理，与普通记忆同进动态召回竞争（handler.ts recallPatch） | **当前确实丢失**（P5-H2，注入位置待裁定） |
| 32 | **precious + 全量 glossary 固定注入（boot_stable）** | a959ecd P1/P5 + buildBootPackage 前史 | 自动注入面：precious 词面相关前 5（`queryShape.ts:152-164` limit 5，handler.ts:66,77-78）+ glossary 仅词面命中；**memory_boot 主动查询面保留**（top20 + 全量，mcp.ts:783-797 + v2/recall.ts:202-232） | **当前确实丢失**（自动面；P5-H3，注入位置待裁定） |
| 33 | **proxy 静态行为规则**（4 行，用户两轮调优措辞） | blocks.ts:89-94 + 9ebff8a + 426214b | 无对应物；surface header 仅"[Aelios 记忆：仅供本轮参考，可能已经过时]"（弱化版，只覆盖第 4 条） | **当前确实丢失**（P5-H4） |
| 34 | **输出风格双层（preset_lite prompt 规则 + CONTENT_RULES 正则，破折号替换为用户硬性要求）** | blocks.ts PRESET_LITE_TEXT + acd8579 | 透传网关无输出处理层，preset 目录不存在 | **当前确实丢失**（P5-H4 附注；非缓存/召回域，但用户可观察输出行为） |
| 35 | RECALL_SOURCE_BOOST（source=model/mcp 的 opt-in 召回加权，默认 1.0） | a959ecd P2 | 全库无此 env；关注点部分被上游 `MEMORY_AUTHORED_BOOST`（E 轴，默认 1.15，v2/recall.ts:68-71）替代，**维度不同**（source vs authored_by） | **当前确实丢失**（opt-in 能力；P5-H5，低优先级） |
| 36 | metadata.user_id 服务端补注（ANTHROPIC_CACHE_USER_ID） | 6969cbb.2 + a73e0de.3 | 客户端自带则透传（`request.ts:82,222`），服务端不从 env 补注 | **当前确实丢失**（opt-in；P5-H6，收益需实验） |
| 37 | ANTHROPIC_AUTO_CACHE_ENABLED（服务端自动加缓存断点，默认 true） | 051d39e（docs）+ cf811d5 前史 | 无 env；服务端只处理客户端自带标记（`sanitizeCacheControl`，protocol.ts:97） | **上游新架构替代**（P5 4a/4b 延伸：服务端不再主动断点，客户端不带 cache_control 则无服务端缓存优化——**成本行为差异记录在案**） |
| 38 | client_volatile_context 缓存失效隐患（遗留待解决问题 #1） | 1f98405（旧分支自记，assembler 机器） | assembler 不存在，注入全在客户端锚点后 | **上游新架构替代**（隐患连同机器一起消失） |
| 39 | shared 原子记忆不做 dream 自动整理（遗留待解决问题 #3，旧分支接受现状） | 1f98405 | 上游 dream 按 namespace 循环整理（写入 ns） | **上游新架构替代**（shared 作为独立 ns 同样被 dream 覆盖） |
| 40 | recall role_scope 标签注入（遗留待解决问题 #2，旧分支未实施） | 1f98405 | surface 渲染不带 namespace（与 #30 同根） | **旧分支同样没有**（非丢失；若做 #30 可一并考虑） |

### 各分类数量

| 分类 | 数量 |
|---|---|
| 当前仍保留 | 19（#1–#17、#19、#40） |
| 上游新架构替代 | 12（#18、#20–#27、#37–#39） |
| P0–P6 已覆盖 | 2（#28、#29） |
| 当前确实丢失 | 7（#30–#36） |

> 合计 40 项（19 + 12 + 2 + 7 = 40）。#40（注入不带 namespace 标签）旧分支从未
> 实施、新分支同样没有——两侧一致的现状归"保留"，旧分支自认未修的缺口（#22
> 消解为替代、#40 现状一致）不计入丢失。
> **"需实验 2"（#36-E1、#32-E1）是附属实验**，分别挂在 #36/#32 项下决定其排期
> 取舍，不额外计入 40 项。

## 1. 缓存域详查（前缀 / cache_control / 断点 / 动态隔离）

P5 4a/4b 已裁定 assembler 断点机器不搬（旧载体：cf811d5 v4 assembler → 34111ec
四断点 → f67e4f6 persona_pinned 锚 → 3d86d56 索引偏移 → 52adf2a client_system 锚 →
dc2afc5 尾断点回退；易变隔离前史：ac0ee56 → 3e37fb3；动态记忆隔离：8f5ed75；
rolling marker：8fcf434 → 6969cbb → a73e0de）。P5-H 增量结论：

1. **服务端自动缓存（#37）**：旧 `ANTHROPIC_AUTO_CACHE_ENABLED` 默认 true，
   服务端主动给 Anthropic 请求排断点；新架构客户端不排则服务端不排
   （唯一服务端落点 `sanitizeCacheControl` 只做降级）。这是成本行为差异，
   属架构选择的自然结果，记录在案、不单独立包。
2. **metadata.user_id（#36）**：旧服务端从 env 补注（跨会话缓存路由）；
   新架构只透传客户端值。归 P5-H6。
3. **易变时间行识别扩展（6969cbb.3）**、**marker 均布（6969cbb.1/a73e0de.1）**：
   绑定在 assembler 上，与 P5 4a/4b 同裁，不搬。
4. **消息历史保序（89d72d9/60df148）**：assembler 重组问题，透传架构无此面（#27）。

## 2. 召回域详查（查询 / 筛选 / 排序 / 去重 / longtail / 触发器 / 失败降级）

- **地板/闸门**：RECALL_MIN_SCORE、floored meta（#1）、注入衰减（#6）全保留，
  上游另修了"降权 × 地板相乘拉黑"问题（v2/recall.ts #37 注释）。
- **namespace 隔离**：legacy 泄漏防护（#3）、unfiltered fallback 过滤（#4）逐字保留。
- **vectorTopK 50**（#2）：旧分支因 CC hook top_k=50 崩过 /v1/memory/search，
  当前同款 clamp 在位。
- **触发器召回**：当前分支 `src/memory/triggers/`（68fbfd1，默认 off）为上游 v2
  新增，旧分支 v2/recall 无对应——**上游新增，非丢失**。
- **E 轴 authoredBoost**：上游新增（MEMORY_AUTHORED_BOOST=1.15），关注点与旧
  RECALL_SOURCE_BOOST（#35）相近但维度不同（authored_by vs source）。
- **longtail / filter 失败降级**：P5-D 已裁定接线缺口，本轮无新增。
- **写时判重 scope**（#19）与 **extract 分组**（#20）：P2-8 两个行为点分别保留与结构性替代。
- **memory_list 过滤**（#8）、**批量查找**（#9）：保留。

## 3. 自动注入 vs 模型主动查询

旧架构 9 块 BLOCK_ORDER（proxy_static_rules → persona_pinned → preset_lite →
client_system → boot_stable → volatile → RAG patch → vision → history）整体消失，
新架构拆为：固定背景（baseline+两日日记+pending 回执，`src/gateway/background.ts`）
+ 每轮召回（`handler.ts:recallPatch` → runRecall + precious/quote/glossary →
round-robin → selectRecall 全局 rerank → assembleRecallSurface）+ 主动查询工具
（memory_boot/memory_recall/memory_search）。逐块对照：

| 旧块 | 新去处 | 结论 |
|---|---|---|
| proxy_static_rules | 无（surface header 弱化版） | **丢失 #33** |
| persona_pinned | 动态召回竞争 | **丢失 #31** |
| preset_lite | 无 | **丢失 #34**（范围外附注） |
| boot_stable 的 baseline+daily_log | background.ts 固定背景 | 阶段 1/2 覆盖 |
| boot_stable 的 digest（L1） | baseline + impressions 替代 | 架构裁定覆盖 |
| boot_stable 的 **precious top20** | 自动面词面相关 5；memory_boot 主动面 top20 保留 | **丢失 #32（自动面）** |
| boot_stable 的 **全量 glossary** | 自动面词面命中；memory_boot 全量保留 | **丢失 #32（自动面）** |
| RAG patch 的 `[type][date]` 时间锚 | surface 渲染丢失 | **丢失 #30** |
| volatile context | P5 4a 已裁定 | 替代 |
| pending 回执 | background.ts | 阶段 1 覆盖 |

## 4. 旧文档线索（plan/遗留待解决问题.md）

- 问题 #1（volatile context 缓存失效）：assembler 机器，连同隐患消失（#38）。
- 问题 #2（recall role_scope 标签）：旧分支从未实施，非丢失；与 #30 同根可一并考虑。
- 问题 #3（shared 不做 dream 整理）：新架构 dream 按 ns 循环，覆盖（#39）。
- 问题 #4（baseline pending）：阶段 3 完整实施，覆盖。
- 问题 #5（memory_search 假参数/压缩返回）：新架构消解（#22）——注意其中
  "返回压缩文本掩盖原文"在新分支**反向**成立：memory_search 现在返回原文，
  旧分支才是压缩的。这是行为改进，非回归。

## 5. 与 P5-A～G 去重

P5-A～G 全部在删除路径（A/B）、retention（C）、recall 接线（D）、传输层/部署
配置（E/F/G）域。P5-H 的 7 项新发现（#30–#36）全部在**注入渲染与配置能力**域，
无重叠。P5-A～G 维持原优先级不变。

## 6. 实现包清单（彼此独立，本审计包不实现）

| 包 | 内容 | 触点 | 最低必要测试 | 优先级 |
|---|---|---|---|---|
| **P5-H1** | 召回注入渲染恢复 `[kind][date]` 时间锚：`assembleRecallSurface` 渲染行加 `[- ${kind}${dateTag}]`（kind/recordedDate/eventDate 字段已备，纯渲染接线）；是否带 namespace 标签与旧遗留问题 #2 一并裁定 | `src/memory/surface.ts:76`（1 处渲染 + header 措辞）；行为模板=旧 2efa467 formatRecallPatch | surface 渲染断言（kind+date 出现、无 date 字段的条目不渲染日期标签）；handler 集成断言注入文本含时间锚 | **已完成（2026-10-18）**；namespace 标签仍未做 |
| **P5-H2** | persona/identity 类型记忆固定注入（裁定后实施）：旧 persona_pinned 每轮在场 → 建议挂 background 固定背景（与 baseline 同通道），或裁定为"检索策略调整"。**先裁定再拆包** | `src/gateway/background.ts` + 查询 persona/identity 类型的 listMemoriesPage 过滤；行为模板=旧 blocks.ts formatPersonaPinned（`- [type][importance]` 行） | 注入断言（persona 记忆三协议在场）+ 无 persona 时逐字节不变回归 | **中高**（身份漂移风险；依赖用户裁定注入位置） |
| **P5-H3** | precious/glossary 自动注入位置（裁定后实施）：选项 A=维持动态（现状）；选项 B=precious 固定 top-N 进 background；选项 C=放宽词面 limit（现 5→N）/glossary 全量进 background。**先裁定，成本随选项差一个量级** | `src/gateway/background.ts` 或 `src/memory/queryShape.ts:152-164`；行为模板=旧 buildBootPackage/formatBootStable | 按选项定；任何选项都需"无对应数据时输出不变"回归 | **中**（模型可观察但主动查询面已兜底 memory_boot） |
| **P5-H4** | proxy 静态规则 + preset_lite 恢复（裁定后实施）：4 行规则（用 426214b 最终版措辞）+ 输出风格块是否恢复/以何种形式（prompt 注入 vs 不管）。**范围超出缓存/召回，一并交用户裁定** | `src/gateway/background.ts`（若恢复注入）；行为模板=blocks.ts:89-94（9ebff8a+426214b 调优版）+ PRESET_LITE_TEXT | 注入断言 + 无配置时不变回归 | **中低**（措辞历史有据，实施成本低，但需裁定） |
| **P5-H5** | RECALL_SOURCE_BOOST（可选）：若裁定 E 轴 authoredBoost 已覆盖关注点则关闭本项；若要 source 维度，按旧实现移植（v2 recall scored map 一处乘子）+ env 同步 settings/types/coverage | `src/memory/v2/recall.ts`、`src/types.ts`、`src/gateway/settings.ts`；行为模板=旧 a959ecd P2（default 1.0） | boost>1 时 source 命中排序前移、default 行为不变 | **低**（opt-in 能力丢失，默认行为无差异；先与 authoredBoost 去重裁定） |
| **P5-H6** | metadata.user_id 服务端补注（可选）：ANTHROPIC_CACHE_USER_ID 存在时为 messages 协议请求补 metadata.user_id（客户端已带则不覆盖） | `src/gateway/protocol.ts`（applyThinkingPolicy 附近接缝）+ settings/types/coverage；行为模板=旧 a73e0de.3 | env 配置时注入、客户端自带优先、无 env 透传不变 | **低**（需先实验 #36-E1） |

依赖关系：六包相互独立；P5-H2/H3/H4 有**前置裁定**（注入位置/是否恢复），
P5-H1/H5/H6 无前置。均不依赖 P5-A～G，也不被 P7/P8 依赖。

## 7. 对 P5-B、P5-C、P7、P8 实施顺序的影响

**无影响。** 7 项新发现全部是注入渲染、prompt 文本、opt-in 配置域，
不触碰 schema、删除路径、retention、迁移数据。既有顺序约束不变：

- P5-C 仍是 **P7/P8 硬前置**（不修则迁移入的软删/版本链行 30 天内被物理清除），
  优先级维持最高；
- P5-B 是 **P8 硬前置**（precious status 列须先由 0020 建好，P8 迁移线上
  旧值才有落点；P5-B 未落地前 P8 不开工）；
- P5-H 不改变上述顺序；P5-H1–H6 与 P7/P8 可任意穿插；若希望迁移后立刻恢复
  旧观感，建议 P8 完成后、P12 验收前实施 P5-H1（时间锚），其余按裁定排期；
- 本审计不新增任何 schema 需求（schema manifest 开放项无变化）。

## 8. 附属实验（无法确认项，不计入 40 项分类）

| 实验 | 目的 | 方法 |
|---|---|---|
| #36-E1 metadata.user_id 缓存收益 | 决定 P5-H6 是否值得做 | 同一会话形态下，Anthropic 请求带/不带 metadata.user_id 的缓存命中率对比（Anthropic prompt cache 为 5 分钟滑动 TTL，跨会话路由收益可能有限） |
| #32-E1 precious 词面过滤实际覆盖率 | 给 P5-H3 裁定提供数据 | 部署后统计：listPrecious 80 条中 selectRelevantPrecious 命中的比例、droppedPrecious 的重复出现率（handler.ts 已有 droppedPrecious 数据面，加日志即可）——**非阻塞，线上观察项** |

## 9. 明确不要清单（增量，P5 §8 之外）

- 旧 BLOCK_ORDER 的块序机器与合成 tool_use 注入（a959ecd P4 的
  MEMORY_INJECTION_MODE/toolcall）：透传架构下无对应生态位，不搬。
- 旧两段式 filter 的 prompt 规则文本（79ee3bb 等）：上游 reranker 已收敛，不搬。
- `scripts/deep-clean-memories.mjs` 系列（b2e9737/7c2de29/2bb7bcb）：历史一次性
  运维脚本，P9 vectorDoctor 覆盖重建需求，不迁移。
- v1 队列消费者 extract 窗口（2660af4）：上游 dream 按天窗口替代，不搬。
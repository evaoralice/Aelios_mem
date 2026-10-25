# P5-H3 + P5-H6 决策审计（2026-10-18）

> 工作树：`Aelios/`，分支 `integration/upstream-v2`。本包**只做审计与实验设计**，
> 不改任何业务代码、测试、迁移或现有 plan，不提交、不推送、不切分支。
> 上游审计文档：`docs/p5h-historical-behavior-gap-audit.md`（#32 / #36，P5-H3 / P5-H6 条目）；
> 总 plan：`../plan/Aelios-upstream-v2-baseline-integration.md` P5-H 段。
>
> 隐私口径：本报告只含条数、字符长度等聚合值；不含任何正文、namespace、
> 角色名或凭证。合成估算一律标注。

---

## 第一部分 P5-H3：precious/glossary 注入策略

### 1. 考古：旧版与当前实现核对

#### 1.1 旧版（fix/logic-review，最终形态）

旧架构里 precious 和 glossary 是 **9 块 BLOCK_ORDER 中的两个固定 system 块**，
每轮无条件在场（加法式注入），且都落在缓存稳定前缀内（a959ecd P5：boot_stable
带 cache_control 5m 断点，persona_pinned 位于 client_system 锚之前）：

| 内容 | 旧载体 | 证据 | 每轮固定成本 |
|---|---|---|---|
| **precious top20** | `persona_pinned` 块 | `fix/logic-review:src/assembler/blocks.ts` personaPinnedBlock content_fn：`ctx.boot.precious` 映射为 type="precious"、importance=1，与 persona/identity pinned 记忆合并，排序 type asc / importance desc / id asc，渲染 `- [type][importance=X.XX] 正文` | 20 条全文 |
| **glossary 全量** | `boot_stable` 块 | `fix/logic-review:src/assembler/types.ts` formatBootStable（约 179–217 行）：baselines（≤8000 字符）+ digest + recent_logs(2) + `boot.glossary.map(g => `${g.term}: ${g.definition}`)` **无条数上限** | 全部词条 |
| 数据来源 | `buildBootPackage` | `fix/logic-review:src/memory/v2/recall.ts`（约 234–299 行）：`listPrecious(limit 20)`（按 created_at 取最新 20，展示升序）、`listAllGlossary`（全量） | — |

注意两点：
- 旧版 **baselines 也在 boot_stable 里**（`[role_scope]` 标记，≤8000 字符），precious
  与 persona 记忆在 persona_pinned 里——即旧版每轮固定注入 = baseline + digest +
  2 日记 + **precious top20** + **glossary 全量**，动态 RAG 命中再叠加在其上。
- 旧版 RAG 动态面（formatRecallPatch，同文件 219–230 行）**不查 precious**（闸一把
  precious 移出每轮 query 召回池）——"固定面供给 + 动态面不重复"在旧架构里是自洽的。

#### 1.2 当前自动面（integration/upstream-v2，每轮被动注入）

| 行为 | 证据 | 语义 |
|---|---|---|
| precious 候选 | `src/gateway/handler.ts:66-67`：`listPrecious(limit 80)` → `selectRelevantPrecious(precious, shaped.lexicalTokens)` | 词面相关前 **5** 条（`src/memory/queryShape.ts:152-165`，limit 默认 5）；入选条件 `score>0 && isPreciousRelevant`（≥2 个 token 命中，或 ≥1 个"显著 token"：长度 ≥4 / 英数 ≥3 / 含 CJK 的 ≥2 字 token，`queryShape.ts:139-150`） |
| glossary 候选 | `src/memory/v2/recall.ts:419-428` → `matchGlossary`（`src/db/v2/glossary.ts:140-163`） | **仅当词条/别名（≥2 字符）逐字出现在本轮查询文本**（thin 查询时拼最近消息，`recall.ts:419-421`）；SQL `instr(lower(query), lower(term))` |
| 全局竞争 | `handler.ts:123-131` round-robin → `selectRecall` → `assembleRecallSurface` | precious/glossary/quote/普通召回/周记**一起竞争一个全局预算** |
| 实际注入上限 | `src/memory/recallSelector.ts:179`：`limit = min(input.maxItems, purpose==="answer" ? 2 : 1)` | **普通闲聊整轮最多注入 1 条，evidence 查询最多 2 条**。线上配置 `MEMORY_FILTER_MAX_OUTPUT="2"`（`wrangler.toml:39`），`MEMORY_FILTER_MAX_CONTENT_CHARS="240"`（:40；`src/memory/filter.ts:54-69` 缺省同值） |
| 注入记账 | `handler.ts:143-147`：markMemoriesInjected 明确排除 precious/glossary/quote/impression | 自动面 precious 不记 `last_injected_at`，不参与注入衰减闸三 |
| 调试数据面 | `handler.ts:103-105,195-197`：`droppedPrecious`（未入选的取前 12 条）写入 `memory_events` 的 `recall_explain` payload | H3 裁定可用，见 §4 |

#### 1.3 当前主动查询面（memory_boot）

`src/api/mcp.ts:793-805`：MCP `memory_boot` → `buildBootPackage`
（`src/memory/v2/recall.ts:202-269`）：

- precious **top20**（`listPrecious limit 20`，展示按 created_at 升序，`recall.ts:229-232`）
- glossary **全量**（`listAllGlossary`，`recall.ts:218,261`）
- 另含 impressions 阶梯（daily/weekly/monthly）+ spontaneous（`recall.ts:214-265`）
- Worker isolate 内 60s 缓存（`BOOT_CACHE_TTL_MS`，`recall.ts:199-200`）
- 调用后 off-response-path 记账 `markPreciousInjected`（`mcp.ts:803`）

即：**旧 boot_stable 的 precious/glossary 供给没有消失，只是从"每轮自动在场"
降级为"模型主动查询才在场"**——模型必须意识到需要并花一次工具往返。

#### 1.4 现状与旧版的行为差异（核对结论）

审计文档 #32 的判断成立，且**实际差距比"5 vs 20"更大**：

1. 旧版是**加法式**：precious 20 条 + glossary 全量每轮必然在场，动态 RAG 叠加其上；
   当前自动面是**竞争式**：全部候选类别争 `min(maxItems, 1~2)` 个名额——普通轮
   即使 precious 命中 5 条、glossary 命中 3 条，也最多注入 1 条（且常被普通召回挤掉）。
2. 词面匹配是**保守闸**：改写、代词引用（"那个暗号"、"我们说好的那件事"）、thin
   续话（"嗯"、"继续"）在自动面一律零命中——precious 需要查询含显著词，glossary
   需要词条逐字出现。
3. 主动面（memory_boot）保留旧口径（top20 + 全量），是当前架构对"固定供给"的
   功能替代，代价是依赖模型自觉 + 一次工具往返。

### 2. 本地数据与估算口径

**本地无 v2 数据库**：`memory/d1-backup-20260629.sql` 是 v1 旧 schema（仅
memories/messages 等 10 表，无 precious/glossary 表）；`.wrangler/` 无本地 D1；
`.migration-work/` 无副本（且其掩码副本的长度分布不可代表真实值）。

可用的**真实锚点**（v1 备份 memories 表 367 行，只取 content 列长度聚合）：

| 指标 | 值（字符） |
|---|---|
| 条数 | 367 |
| 均值 | 247 |
| P50 | 232 |
| P90 | 402 |
| P95 | 516 |
| P99 | 910 |
| max | 1148 |

**precious/glossary 无本地数据，以下为公式 + 合成估算（明确标注）**：

- 中文文本 token 折算取 0.7–1.0 token/字符（Claude tokenizer 对中文的常见区间，
  混排英文偏低端）。
- 合成假设（**无真实依据，仅量级推演**）：precious 条均长度按 v1 memories 分布
  P50≈230 / P95≈520 字符（同为用户长期记忆文本，风格相近）；glossary 词条按
  `term(≈4) + ": " + definition(合成 30–60) + 换行` ≈ 37–67 字符/条，取 50。

| 方案 | 每轮固定字符 | 每轮固定 token（估） |
|---|---|---|
| 旧版实况（参考） | precious 20×232 ≈ 4.6k + glossary G×50（G=50 → 2.5k）+ baseline ≤8k + digest/2 日记 ≈ **15k+** | ≈ 10k–15k（可吃缓存读 0.1x） |
| A 现状 | **0 固定**；动态注入受 maxItems=2、单条 240 字符截断约束，普通轮实际 ≤1 条 | ≈ ≤250 token（且只在词面命中时发生） |
| B：precious top-N=10 进固定背景 | 10×232 ≈ **2.3k**（P95 上界 10×516 ≈ 5.2k） | ≈ 1.6k–5k |
| C：B + glossary 全量 | B + G×50（G=50 → +2.5k；G=100 → +5k） | ≈ 4k–10k |

### 3. A/B/C 方案行为矩阵与评估

| 维度 | **A：维持动态注入（现状）** | **B：precious 固定 top-N，glossary 保持动态** | **C：precious 固定 top-N + glossary 全量固定** |
|---|---|---|---|
| 每轮固定 token | **0** | ≈1.6k–5k（N=10） | ≈4k–10k+（随 G 线性涨，无上限设计） |
| 漏召回风险 | 中：改写/代词/thin 查询零命中；命中后还要在全局竞争中胜出（普通轮 ≤1 席） | top-N 内无词面漏召回（恒在场）；**N 之外仍漏**（listPrecious 按 created_at 排，"top"=最新 N，不是最重要 N——precious 无 importance 维度，老条目永久出局固定面）；glossary 仍需词面命中 | precious 同 B；glossary 零漏召回 |
| 重复注入 | 低（无固定面）；但同一条 precious 可连续多轮词面命中重复注入（自动面不记 last_injected_at，`handler.ts:143-147`） | **高**：固定面每轮在场 + 自动面 `selectRelevantPrecious` 仍会选同一条 → 需要接线去重（handler.ts:66-67 改动），否则同一内容一轮双份 | 同 B，且 glossary 固定面与自动面 matchGlossary 命中完全重复 |
| 过期信息风险 | 低：入选内容至少与当轮词面相关 | 中：top-N 中任何过期/被取代条目**每轮**在场直到人工清理；P5-B 软删可挡 deleted 行但挡不住"语义过时但未删" | 同 B + glossary 定义变更前旧定义逐字滞留 |
| 与 baseline 重叠 | 低：baseline=身份稳定态，precious=事实，边界清晰 | 中：baseline 与 precious 内容可语义重叠（旧版两处都注入即有此问题） | 同 B |
| 与动态召回重叠 | 无结构性重叠 | 需主动拆面：普通召回（runRecall）不查 precious（闸一，`v2/recall.ts:430-431`），但 handler 词面通道要处理 | 同 B |
| 与 memory_boot 重叠 | **低（当前设计即为此）**：boot=完整兜底，自动面=精准点射，职责正交 | 中：boot 的 precious 段与固定面完全重复 | **高**：boot 的 precious+glossary 两段全部冗余，工具边际价值只剩 impressions/spontaneous——主动查询面设计被架空 |
| 最小代码触点 | **0** | `background.ts`（loadBackgroundContext+formatBackgroundBlock 加 precious 读取与渲染）、`handler.ts:66-67`（自动面去重或关闭）、新 env（`PRECIOUS_BOOT_TOP_N` 之类）同步 `types.ts`+`gateway/settings.ts`+`tests/settings-coverage.test.ts`；三协议注入断言 + "无数据时逐字节不变"回归 | B + glossary 读取/渲染；同套 env/测试负担；另需裁定 boot 是否瘦身 |
| 合并上游维护成本 | **零**（不动任何文件） | 中：触点全在我们自己的扩展文件（background.ts/handler.ts 均非上游产物，`git cat-file` 核实），但每轮 prompt 体积变化会波及三协议注入回归 + 缓存观察 | 同 B 略高（glossary 段还会进入 memory_boot 一致性讨论） |

补充观察（不属于本包裁定，记录在案）：若只把 `selectRelevantPrecious` 的 limit 5
调大，**普通轮实际注入仍是 ≤1 条**——真正的闸在 `recallSelector.ts:179` 的
`purpose==="association" ? 1` 常量。任何"增强自动面"的讨论都绕不开这层，
但这属于召回预算域（H2/H3 之外的行为裁定），本报告不展开。

### 4. 推荐方案

**推荐 A（维持现状动态注入）**，附条件升级路径：

1. **先观察，不动代码**。`#32-E1` 所需的数据**已经在采**：`recall_explain`
   payload（`memory_events` 表）含 `channels.precious_selected`、
   `droppedPrecious`（前 12 条未入选）与全局 `selection.decisions`
   （含 `precious_not_relevant` 排除原因，`handler.ts:195-197`）。部署后跑
   1–2 周即可用聚合查询回答："precious 词面命中率多少？被普通召回挤掉多少？
   dropped 的重复出现率多少？"——零新代码。
2. **若数据显示词面通道长期空转、且用户体感"它不记得重要的事"**：选 **B**，
   N 取小值（5–8），glossary 保持动态（C 的全量固定与个人用 token 哲学相悖，
   glossary 的设计语义本来就是"词条被提到时才需要定义"）。
3. **不默认恢复旧架构**（C）：旧 boot_stable 的 15k+ 字符固定前缀是在"9 块
   assembler + 服务端断点"的缓存机器下成立的选择；当前透传架构没有服务端
   断点（P5 4a/4b 裁定，#37 记录在案），固定注入的 token 是**裸价**而非
   0.1x 缓存价——把旧方案的量级照搬进新架构，每轮成本会高于旧版实跑成本。

---

## 第二部分 P5-H6：metadata.user_id 收益核查

### 1. 考古：旧实现与当前协议路径

**旧实现（fix/logic-review）**：

- `6969cbb`（2026-06-28）在 `src/proxy/anthropicAdapter.ts` 的两个请求构造函数
  里加 `metadata: { user_id: "operit-user" }`（硬编码）。commit message 原文：
  *"Add metadata.user_id to Anthropic requests to enable persistent prompt cache
  across sessions"*——**这是假设，不是验证结论**。
- `a73e0de`（同日）review 修正：从 env 读——
  `...(input.env.ANTHROPIC_CACHE_USER_ID ? { metadata: { user_id: input.env.ANTHROPIC_CACHE_USER_ID } } : {})`，
  并在 `src/types.ts` 加了 env 类型。仍与断点机器同处一个 commit 系列。

**当前实现（integration/upstream-v2）**：

- `src/gateway/request.ts:82`：messages 协议 allowlist 里 `pick(body.metadata,
  fields("user_id"), "metadata")` ——**客户端带了 user_id 就透传**；
- `request.ts:222`：校验 `metadata.user_id` 必须为 string；
- `src/gateway/record.ts:33`：`metadata.session_id`（客户端值）只用于本地
  exchange 记账，不上行；
- 全库 **无 `ANTHROPIC_CACHE_USER_ID`**（grep 核实）——服务端从不补注。
- 接缝：若要恢复旧行为，落点在 `prepareGatewayRequest`
  （`src/gateway/upstream.ts:117-138`，`applyThinkingPolicy` 同一管道）。

### 2. 官方文档核查（只引用 Anthropic 官方文档）

**(a) metadata.user_id 的正式用途** —— Messages API 参考
（https://platform.claude.com/docs/en/api/messages ，metadata.user_id 字段，2026-10-18 抓取）：

> "An external identifier for the user who is associated with the request.
> This should be a uuid, hash value, or other opaque identifier. **Anthropic
> may use this id to help detect abuse.** Do not include any identifying
> information such as name, email address, or phone number."（maxLength 512）

官方定位：**滥用检测 / 请求归因**。API 参考的 metadata 段没有任何缓存相关表述。

**(b) 是否影响 prompt cache 命中、缓存路由、跨会话复用** —— Prompt caching 文档
（https://platform.claude.com/docs/en/build-with-claude/prompt-caching ，2026-10-18 抓取）：

- 命中机制："Prompt caching references the **entire prompt: `tools`, `system`,
  and `messages` (in that order)**, up to and including the block designated
  with `cache_control"——命中 = 前缀**逐字节一致**的哈希匹配；写入只发生在
  断点处；读取向后找最多 20 个 block 的历史写入。
- **全文没有任何一处把 `metadata`（或 user_id）列为命中条件、路由因子或作用域
  划分**。缓存失效表（tool 定义/系统/消息变更等 9 行）亦无 metadata 行。
- Rate limits 文档（https://platform.claude.com/docs/en/api/rate-limits ）：
  限额在 **organization 级**强制，`cache_read_input_tokens` 不计 ITPM（除
  Haiku 3.5）——同样没有 user_id 维度的配额或路由。
- **结论：没有任何官方证据支持"user_id 影响缓存"。** 旧 commit message 的
  "persistent prompt cache across sessions"是未经验证的假设；跨会话复用
  实际只取决于：同前缀逐字节复现 + TTL 窗口内。同一组织凭据下这本来就发生，
  与 user_id 无关。

**(c) prompt caching 的真实命中条件与 TTL**（同 caching 文档）：

- TTL：默认 **5 分钟滑动**（"refreshed for no additional cost each time the
  cached content is used"，计时从请求开始而非响应结束）；可选 1h（写入 2x 价）。
- 最低可缓存长度：新一代模型（Fable 5.1/Mythos 5.1/Opus 5.5/Sonnet 5.5/Haiku
  5.5 等）**512 token**，旧型号 1024–4096；不足则静默不缓存（usage 两字段
  皆为 0 可判别）。
- 价格：写 1.25x（5m），读 0.1x（最新代 0.025x/0.05x）。
- 新观察（顺带记录，不属 H6）：API 现已支持顶层 `cache_control`（自动断点，
  移动到最后可缓存块）与 `diagnostics.previous_message_id`
  （`cache_miss_reason` 诊断字段）——未来若评估"服务端缓存策略"（P5 4a/4b
  后续）可用，本报告不展开。

### 3. 裁定

**与缓存无关，建议关闭 P5-H6。**

依据：
1. 官方文档中 user_id 的唯一正式用途是滥用检测归因；
2. 缓存命中机制的官方表述完全是前缀哈希 + TTL，无 user_id 参与；
3. 旧实现的收益声明（跨会话缓存持久化）与官方机制矛盾：5 分钟滑动 TTL 意味着
   "跨会话持久缓存"本来就不存在，无论带不带 user_id；
4. 现状（客户端透传保留，`request.ts:82`）已覆盖所有残余价值——若某天某客户端
   想带 user_id 做归因，透传路径现成；个人单用户场景下服务端补注无收益。
5. 不实施意味着零代码、零 env、零 settings-coverage 负担；关闭比保留一个
   "低优先级待实验"的悬置项干净。

### 4. 若仍需真实实验（仅设计，不执行）

由于官方文档已足够裁定，以下仅作"如果要证伪隐性路由"的最小实验存档：

- **请求变量**：`metadata.user_id` 三水平——A=缺省不发送；B=固定 opaque 值
  （如 `sha256(标识)[:32]`）；C=每请求换随机值。其余逐字节一致（同 model、
  同 tools/system/messages 前缀、同 cache_control 位置与 TTL）。
- **对照组设计**：前缀 ≥1024 token（确保超最低可缓存长度），先发一次写缓存，
  再在 60s 内复发（保 TTL）。
- **观察字段**：响应 `usage.cache_read_input_tokens` /
  `cache_creation_input_tokens` / `input_tokens`；`diagnostics.cache_miss_reason`
  （若带 previous_message_id）。
- **次数与成本**：每水平 30 次复请求 × 3 水平 = 90 次，前缀 ~1.5k token →
  合计 ~135k input token。用 Haiku 5.5（$0.10/MTok 基价、读 $0.01/MTok），
  估算 **< $0.05**。变量 C 若真有 per-user 路由，命中率应显著低于 B；
  A/B 差异则检验"有 user_id 是否改变路由"。
- **判定**：三水平命中率无统计差异 → 官方口径完全成立，H6 关闭归档。

---

## 总表

| 项目 | 建议实施/放弃/暂缓 | 理由 | 后续工作包 |
|---|---|---|---|
| P5-H3（precious/glossary 注入面） | **暂缓（维持 A 现状），B 为条件升级路径，C 否决** | 个人使用优先减 token；旧固定面量级在无服务端断点的新架构下是裸价；主动查询面 memory_boot 已保留旧口径兜底；漏召回是否真发生无数据支撑 | 观察包（零代码）：聚合查询 `memory_events`/`recall_explain` 的 precious_selected / droppedPrecious / decisions 命中率（1–2 周）→ 若词面通道长期空转且体感缺失，再立 B 的最小实现包（background.ts + handler.ts:66-67 + env 三同步 + 回归） |
| P5-H6（metadata.user_id 服务端补注） | **放弃（关闭）** | 官方文档明确 user_id=滥用检测归因；缓存命中=前缀哈希+5m 滑动 TTL，与 user_id 无关；旧 commit 收益声明与官方机制矛盾；客户端透传已覆盖残余价值 | 无实现包。可选：若用户想留档证伪，按 §II.4 最小实验设计（<$0.05，Haiku）执行后归档；`p5h-historical-behavior-gap-audit.md` 的 #36-E1 实验项可随裁定关闭 |

---

## 附录：证据索引

**P5-H3**：
- 旧版：`fix/logic-review:src/assembler/blocks.ts`（personaPinnedBlock 含
  ctx.boot.precious 映射；PROXY_STATIC_RULES 同文件）；`fix/logic-review:src/assembler/types.ts` formatBootStable（~179–217）；`fix/logic-review:src/memory/v2/recall.ts` buildBootPackage（~234–299，listPrecious limit 20 / listAllGlossary）
- 当前自动面：`src/gateway/handler.ts:66-67,103-109,123-131,143-147,195-197`；
  `src/memory/queryShape.ts:139-165`；`src/memory/v2/recall.ts:419-428`；
  `src/db/v2/glossary.ts:140-163`；`src/memory/recallSelector.ts:179`；
  `src/memory/filter.ts:54-72`；`wrangler.toml:39-40`
- 当前主动面：`src/api/mcp.ts:793-805`；`src/memory/v2/recall.ts:199-269`
- 固定背景对照：`src/gateway/background.ts:41-67`
- 真实长度锚点：`memory/d1-backup-20260629.sql`（v1，367 行 memories content
  聚合统计，仅提取长度，未读取正文）

**P5-H6**：
- 旧实现：commit `6969cbb`（anthropicAdapter.ts，硬编码 user_id + 收益声明）；
  commit `a73e0de`（env 化 + types.ts）
- 当前路径：`src/gateway/request.ts:82,222`；`src/gateway/record.ts:33`；
  `src/gateway/upstream.ts:117-138`；`src/gateway/protocol.ts:99`
- 官方文档（2026-10-18 抓取）：
  - https://platform.claude.com/docs/en/api/messages （metadata.user_id 定义）
  - https://platform.claude.com/docs/en/build-with-claude/prompt-caching （命中机制/TTL/最低长度/失效表）
  - https://platform.claude.com/docs/en/api/rate-limits （组织级限额/ITPM 口径）

**本包未修改任何文件**（除本报告自身为新建文档）。
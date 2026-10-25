# P5-H5 决策审计：RECALL_SOURCE_BOOST 是否值得移植（2026-10-18）

> 工作树：`Aelios/`，分支 `integration/upstream-v2`。本包**只做审计**，不修改业务
> 代码、测试、迁移和现有 plan；不提交、不推送、不切分支。
> 依据：`DEV.md`、`docs/p5h-historical-behavior-gap-audit.md`（#35 / P5-H5）、
> `docs/p5h3-h6-decision-audit.md`、总 plan P5-H 段。
>
> 隐私口径：本报告只含 source/authored_by 的条数聚合，不含正文、namespace、角色名
> 或凭证。未读取 `.env`、`wrangler.toml` 或线上配置，因此**无法确认旧版线上实际
> 是否启用过 `RECALL_SOURCE_BOOST`**。

---

## 0. 结论摘要

| 项 | 内容 |
|---|---|
| 主裁定 | **放弃 H5（不移植 `RECALL_SOURCE_BOOST`）** |
| 一句话理由 | 旧 boost 想表达的“模型/亲手写的记忆优先”已由 E 轴 `MEMORY_AUTHORED_BOOST` 承接；`source` 是自由文本、当前已漂移且会被调用方覆盖，不适合作为新的长期排序依据。 |
| 阻塞项 | 无。不影响 P5-A～G、P7/P8、P12 排期。 |
| 额外结论 | 原 H5 条目“v2 recall scored map 一处乘子”的触点估算**不成立**：当前 Gateway 最终注入顺序由 `recallSelector` 的二次重排决定，只在 `runRecall` 加乘子无法复现旧的可观察行为。 |

---

## 1. 旧行为考古（`fix/logic-review`，引入 commit `a959ecd`）

### 1.1 定义与匹配集合

```ts
// fix/logic-review:src/memory/v2/recall.ts:51-54
function readSourceBoost(env: Env): number {
  const raw = Number(env.RECALL_SOURCE_BOOST ?? "1.0");
  return Number.isFinite(raw) && raw >= 1 ? raw : 1;
}
```

```ts
// fix/logic-review:src/memory/v2/recall.ts:460
const sBoost = sourceBoost > 1 && (m.source === "model" || m.source === "mcp") ? sourceBoost : 1;
```

| 属性 | 旧值 | 证据 |
|---|---|---|
| env 名 | `RECALL_SOURCE_BOOST` | `fix/logic-review:src/types.ts:40-41` |
| 默认值 | `1.0`（即默认关闭） | 同上 |
| 匹配 source | **仅 `"model"` 和 `"mcp"`** | `recall.ts:460` |
| 取值规则 | 有限数且 `>= 1`；**没有上限**（填 100 也生效），`<1`/`NaN`/非法值回落 1 | `recall.ts:52-53` |
| 无效时不降权 | 是，只做 `> 1` 的加成 | `recall.ts:460` |

### 1.2 计算位置与乘法顺序

旧管线顺序：搜索 → 过滤/重排（`filterAndCompressMemoriesWithMeta`）→ **闸三降权 +
source 加成 + role 加成** → 闸二去重 → 闸四地板 → 排序并 `slice(0, k)`。

```ts
// fix/logic-review:src/memory/v2/recall.ts:457-472
const scored: RecallHit[] = memories.map((m) => {
  const decay = decayForLastInjected(m.last_injected_at ?? null, windowMs, factor);
  const sBoost = sourceBoost > 1 && (m.source === "model" || m.source === "mcp") ? sourceBoost : 1;
  ...
  score: (m.score ?? 0) * decay * sBoost * rBoost,
```

- 乘法顺序：`原始分 × 注入衰减 × source 加成 × role 加成`，数学上可交换。
- **乘的是重排后的分**（reranker 开启时是 reranker 分），不是 RRF 分。
- 发生在闸二去重之前，但去重是布尔判断，boost 不改变去重结果，只影响之后的排序。

### 1.3 地板与截断

```ts
// fix/logic-review:src/memory/v2/recall.ts:520-528
const beforeFloor = [...afterDedup, ...longtailHits].sort((a, b) => b.score - a.score);
const allHits = beforeFloor
  .filter((hit) => {
    if (hit.score >= minScore) return true;   // 判的是 boost 之后的 score
    ...
  })
  .slice(0, k);
```

旧版地板判的是 **boost 之后**的 `score`，因此 source 加成可以把一条原始分略低于
`RECALL_MIN_SCORE` 的记忆**抬过地板**（例：`0.13 × 1.2 = 0.156 ≥ 0.15`）。这是旧
行为的一部分，但和当前 #37 的裁定（地板只判原始相关性分，加成/降权不参与地板）
直接冲突。

### 1.4 旧版意图与证据

- commit message：`Phase 2 — Source tagging & recall boost: RECALL_SOURCE_BOOST env
  var (default 1.0) for model/mcp source weighting; Applied after injection decay,
  before gate-2 dedup`（`a959ecd`）。
- `HANDOVER.md:108-118`：旧版把 `source: "model"` 用于 changelog 应用的模型提案
  （`dailyDigest.ts` 的 `upsertMemoryByFactKey` / `supersedeMemory`），`mcp` 用于 MCP
  直写；`extractPipeline.ts` 明确保持 `source: "extract"`，`dailyDigest` 的 dream
  更新保持 `source: "dream"`。旧测试同样只断言 `model`/`mcp` 加成、
  `extract`/`dream` 不加成（`test/phase2/recallSourceBoost.test.ts:57-173`）。
- 旧交接建议部署时设 `RECALL_SOURCE_BOOST="1.2"`（`HANDOVER.md:237`），但这是
  “建议配置”，不是仓库内可验证的线上值；本审计未读取部署配置，无法确认。
- 旧 meta 只暴露 `role_boosted_ids`，**没有 `source_boosted_ids`**；该加成长期缺少
  可观测性。

**考古结论**：它解决的具体问题是“模型自己写/亲手写入的记忆，应比自动抽取的记忆
更容易被召回”，不是“按任意来源做通用排序”。`model` 指模型提案被 changelog 应用
的产物，`mcp` 指 MCP 直写。

---

## 2. 当前来源字段映射表

### 2.1 写入路径 → source / authored_by

| 写入路径 | 最终 `memories.source` | 能否带 `authored_by` | 证据 |
|---|---|---|---|
| MCP `memory_upsert` | `args.source`，缺省 `"mcp"` | 仅当 source ∈ `mcp/manual/api/remember_now` 且显式传值 | `src/api/mcp.ts:436-445,883-886` |
| MCP `memory_create`（旧直写） | `args.source`，缺省 `"mcp"` | 该路径不写 E 轴 | `src/api/mcp.ts:632` |
| MCP `memory_supersede` | 固定 `"mcp"` | 可带 | `src/api/mcp.ts:910-913` |
| MCP `memory_ingest` | `args.source`，缺省 `"mcp"` | 不适用（写消息，不写记忆） | `src/api/mcp.ts:771` |
| REST `POST /v1/memory`（v2 fact_key 分支） | `body.source` 或 API key profile 的 source | 仅亲手 source 且显式传值 | `src/api/memories.ts:106-111` |
| REST `POST /v1/memory`（legacy 分支） | `body.source` 或 profile source | legacy `createMemory` 无 E 轴参数 | `src/api/memories.ts:126-137` |
| REST `POST /v1/memory/ingest` | `body.source` 或 profile source | 不适用（写消息） | `src/api/memories.ts:135` |
| REST 候选 approve / supersede | `"review"` | 否（非亲手集合） | `src/api/memories.ts:898,939,1017` |
| `remember_now` 代写 | `"remember_now"` | **不写**（调用未传 authoredBy） | `src/memory/rememberNow.ts:70-75` |
| Dream 候选：新增 / 更新 / 抽取 / 删除 | `"dream_add"` / `"dream_update"` / `"dream_extract"` / `"dream_delete"` | 否 | `src/memory/dream/lifecyclePhase.ts:78,133,158`；`judgePhase.ts:99` |
| Dream 直接 supersede（world_fact） | `"dream"` | 否 | `src/memory/dream/lifecyclePhase.ts:106` |
| 候选自动审核批准 | `"judge"` | 否 | `src/memory/candidateJudge.ts:317` |
| `supersedeMemory` 未显式传 source | `"supersede"` | 否 | `src/db/v2/memories.ts:425-427` |
| debug 接口 | `"debug"` | 否 | `src/api/debug.ts:221` |
| GitHub 日报 ingest | `"github-daily"` | 不适用 | `src/memory/githubDaily.ts:13,179` |
| 孤儿向量兜底 | `"legacy_vectorize"` | 否 | `src/memory/search.ts:364` |
| 从旧库迁移（P8 设计域） | 原样复制旧 `source` | **旧 schema 无 `authored_by` 列**，迁移后为 NULL，除非另做回填 | `tests/fixtures/old-branch-schema.sql`；`migrations/0011_e_axis_authored.sql:5` |

### 2.2 E 轴写入闸

```ts
// src/db/v2/memories.ts:103-125
const HAND_AUTHOR_SOURCES = new Set(["mcp", "manual", "api", "remember_now"]);
...
if (!isHandAuthorSource(input.source)) return { authoredBy: null, responseTendency: null };
```

- `authored_by` 不是 source 的自动衍生值：**source 是 mcp 但没传 `authored_by` 时，
  该列仍为 NULL**（`upsertMemoryByFactKey` 的 `eAxisFieldsForWrite`；REST/MCP 均如此）。
- 反过来，`manual/api/remember_now` 只有显式传值时才有 E 轴。
- `memory_upsert` 的工具描述已经在鼓励传 `authored_by`（`src/api/mcp.ts:410-411`），
  但它是可选项，不是默认。

### 2.3 source 字段的可信度

- **自由文本**：MCP schema 只写 `type: "string"`（`src/api/mcp.ts:436-440`），REST
  接受 `body.source`（`src/api/memories.ts:106,135`）；没有 enum 校验。
- 调用方可以自报 `source: "mcp"` / `"model"` 等值，因此 source 是“标签”，不是
  “可信来源证明”。
- 当前 source 词表已经漂移：旧版的 `"model"` 在新管线中不再产生（dream 分支改为
  `dream_add/dream_update/dream_extract/dream/judge/review`）；把旧匹配集合原样搬
  过来只会命中 mcp 一半语义。
- `source` 也用于注入标签分类（`handler.ts:25-29`：remember_now/authored → authored，
  dream/judge/extract → distilled），但 dream_add/dream_update/dream_extract 这些
  新值并不在 `"dream"` 的精确匹配里；这进一步说明 source 是历史标签集合，不是稳定
  的排序维度。

---

## 3. 两种 boost 的差异矩阵

| 维度 | 旧 `RECALL_SOURCE_BOOST` | 当前 `MEMORY_AUTHORED_BOOST` |
|---|---|---|
| 触发条件 | `source === "model" \|\| "mcp"` | `authored_by` 非空 |
| 维度 | 来源标签（provenance label） | 亲笔署名（E 轴，显式授权） |
| 默认 | `1.0`（关闭） | `1.15`（开启） |
| 取值范围 | `>= 1`，无上限 | `1..2`，越界回落 1.15 |
| 计算位置 | 闸三，同 `decay`/role 相乘 | 闸三，同 `decay` 相乘 |
| 地板 | 判 boost 后 `score`，可抬过地板 | 判 `raw_score`，**不影响地板**（#37） |
| 最终 Gateway 注入顺序 | 旧架构中 recall 顺序即注入顺序，boost 直接生效 | `recallSelector` 二次重排后才定注入；boost 只影响候选池顺序/截断 |
| MCP `memory_recall` 顺序 | 直接生效 | 直接生效（`runRecall` 返回序） |
| 与 namespace boost 关系 | 不同阶段（旧 role boost 与 source 同阶段相乘） | 不同阶段：namespace boost 在 selector 的 `rank` 上乘（`recallSelector.ts:235-244`） |
| 与 importance 关系 | 乘在 `score + importance×0.05` 之后的排序分上 | 同位置；importance 加法因子在 search 阶段（`extensions/memoryRanking.ts:14-16`） |
| 与 RRF/rerank 关系 | 乘 reranker 分 | Gateway 自动召回关闭 reranker，乘混合检索原始分；MCP 召回乘 reranker 分 |
| 可观测性 | 无 `source_boosted_ids` | 无 `authored_boosted_ids` |
| 维护成本 | 新 env（settings/types/coverage）+ 语义随 source 词表漂移 | 已落地，仅需写入端署名 |
| 调用方可控性 | source 可被 MCP/REST 调用方自由覆盖 | authored_by 也可自报，但只限亲手 source，且是显式“亲笔”声明 |

### 3.1 覆盖范围：谁被谁加成

| 记忆类别 | 旧 source boost | 当前 authored boost | 说明 |
|---|:---:|:---:|---|
| `source=mcp` 且 `authored_by` 非空 | ✓ | ✓ | 唯一重叠区 |
| `source=mcp` 且 `authored_by` 为空 | ✓ | ✗ | 旧行为覆盖、当前不覆盖的主要缺口 |
| 旧 `source=model`（模型提案） | ✓ | ✗ | 当前无此值；对应 dream/judge 产物均无 E 轴 |
| `manual/api/remember_now` 且有署名 | ✗ | ✓ | 旧 boost 没覆盖，当前覆盖 |
| `dream/dream_add/dream_update/dream_extract/judge/review/extract/chatbox/im/debug/...` | ✗ | ✗ | 两侧都不加成 |

### 3.2 同时启用是否重复加权

若把 H5 原样移植，且 `source=mcp` 的记忆同时带 `authored_by`：

```
score = raw × decay × 1.2(source) × 1.15(authored) = raw × decay × 1.38
```

相对只开 authored boost 的 `1.15`，这是重复加成。若再按“忠实复现旧行为”把 source
boost 放进 selector 与 namespace boost 同层，则还会再乘 `RECALL_ROLE_BOOST`（默认
1.3），形成三层叠加。旧架构里 source 与 role 本来就相乘，所以“三层”本身不是错误，
但当前 E 轴已经占了“亲笔优先”的位置，再叠 source 会让同一语义被计两次。

### 3.3 对 RRF / importance / namespace boost 的相对位置

- **RRF** 发生在 search 的 `mergeHybridRanks`（`src/memory/search.ts:428-435`），它
  决定候选池顺序；返回的数值 `score` 是通道原始分（向量分或词面分），不是 RRF 分。
  因此对这个 `score` 乘 boost 再排序，会部分覆盖 RRF 顺序；这是旧版和当前 E 轴都
  存在的近似，不是 H5 独有。
- **importance** 的加法因子 `score + importance×0.05` 只在
  `memoryRankScore`（`src/extensions/memoryRanking.ts:14-16`）中出现，位于 search
  排序/legacy 兜底阶段；`runRecall` 的 boost 乘在 `m.score` 上，能够覆盖由 importance
  产生的先后。旧版相同。
- **reranker**：MCP/REST 的 `memory_recall` 会先重排再乘 boost
  （`src/memory/filter.ts:193-199`）；Gateway 自动召回显式关闭 reranker
  （`src/gateway/handler.ts:69`），乘的是混合检索原始分，之后再由
  `recallSelector` 的 bge 重排重新决定最终注入。
- **namespace boost**：只在 selector 的最终 `rank` 上乘
  （`src/memory/recallSelector.ts:235-244`），不经过 `runRecall`。它与
  source/authored boost 不在同一层，无法用一个乘子“顺便”覆盖。

---

## 4. 最小排序算例

假设：两条记忆原始分同为 `0.50`，注入衰减 `1.0`，无 role/namespace 加成；
旧 source boost `1.2`，当前 authored boost `1.15`。

| 场景 | 旧版（source boost） | 当前（authored boost） |
|---|---|---|
| A：`source=mcp`，无署名；B：`source=chatbox`，无署名 | A = `0.60`，B = `0.50` → A 在前 | A = `0.50`，B = `0.50` → 同分（靠后续 RRF/rerank 决定） |
| A：`source=mcp` 且有署名；B：`source=mcp` 无署名 | A = `0.60`，B = `0.60` → 同分 | A = `0.575`，B = `0.50` → A 在前 |
| A：`source=model`；B：`source=extract` | A = `0.60`，B = `0.50` → A 在前 | 当前无 `model`；dream/judge 产物都不加成，两侧同分 |
| 地板：`source=mcp`，原始分 `0.13`，地板 `0.15` | `0.13 × 1.2 = 0.156` → 过地板 | 无署名：`raw_score=0.13` → 被地板拦；有署名：`score=0.1495` 但 `raw_score=0.13` → 仍被拦 |

结论：旧 source boost 的两个独有效果是（a）覆盖未署名的 mcp 写入，（b）能抬过地板。
当前 E 轴两者都做不到；但（b）正是 #37 明确要修掉的行为，（a）则应该由“写入时补
`authored_by` / 迁移回填”解决，而不是恢复一个粗粒度的 source 乘子。

---

## 5. 本地数据核对（只取聚合）

本地没有 v2 数据库：`.wrangler/` 无 D1，`.migration-work/` 为空，唯一可用的是
`memory/d1-backup-20260629.sql`（v1 schema，367 条 memories）。

| 指标 | 值 |
|---|---|
| 总条数 | 367 |
| `source=mcp` | 327（89.1%） |
| `source=chatbox` | 40（10.9%） |
| `source` 为空 | 0 |
| `source=model/extract/dream/...` | 0 |
| `authored_by` 列 | 不存在（v1 schema） |

注意口径：该备份日期 **2026-06-29**，早于旧 boost 的引入 commit `a959ecd`
（2026-07-12），所以它**不能**代表 boost 时代的完整来源分布，也无法统计旧 `model`
条目或当前 E 轴覆盖率。它只能说明：在这份早期真实数据里，mcp 已经占绝对多数；
一旦对 mcp 整体加权，约九成记忆会获得同一个乘子，区分度很低。

`authored_by` 在本地完全不可测；迁移后的覆盖率必须在 P8 之后从 v2 库统计，属于
后续观察项，不在本包展开。

---

## 6. 主裁定及理由

### 裁定：**放弃 H5**

理由按强度排序：

1. **语义已经被 E 轴取代，而且 E 轴更精确。** 旧 boost 真正表达的是“模型/亲手写的
   记忆优先”。当前 `authored_by` 是显式、逐条的“亲笔”声明，并且有写入闸（只许
   mcp/manual/api/remember_now）和防蒸馏覆盖保护（`HandAuthoredProtectedError`）。
   把 source=mcp 重新加成，等于用更粗的标签重复同一个维度。
2. **`source` 不适合作为长期排序依据。** 它是自由文本、无 enum、调用方可覆盖；
   词表已经随架构演进漂移（旧 `model` 消失，新增 `dream_add/dream_update/
   dream_extract/judge/review` 等）。按 source 排序需要不断维护一张“哪些值算好来源”
   的名单，且名单本身不可信。
3. **旧行为的另一半（`model`）不应该恢复。** 旧 `model` 是模型提案被 changelog
   应用后的产物；当前对应物是 dream/judge 的蒸馏链。把这些自动产物加成，会和
   E 轴“亲笔高于蒸馏”的方向相反。只恢复 mcp 半边则又只是 E 轴的重复。
4. **原实现触点估算不成立。** 旧版 recall 顺序就是注入顺序；当前 Gateway 在
   `runRecall` 之后还有一次 `recallSelector` 全局重排，最终注入由 bge 分（加
   namespace boost）决定。只在 `runRecall` 加乘子，用户可观察的自动注入顺序几乎
   不变；要忠实复现，必须把 `source` 暴露到 `SurfaceEntry` 并接进 selector 的
   `rank`，这是新开一条排序通路，不是“一处乘子”。
5. **旧 boost 默认关闭、无观测、且与 #37 地板哲学冲突。** 旧版默认 `1.0`，meta
   没有 source 命中统计；它还能把记忆抬过地板，而当前 #37 已裁定地板只判原始
   相关性分。若要移植，必须先重新裁定这个冲突，收益不足以支撑。

### 这不是“E 轴已完全覆盖旧 source boost”

严格说，当前 E 轴**不覆盖**未署名的 mcp 写入，也不覆盖旧 `model` 产物。但正确的
补救方向不是恢复 source 乘子，而是：

- 写入端：确认 MCP 调用方在写“亲笔记忆”时传 `authored_by`（工具描述已鼓励）；
- 迁移端：若旧库 mcp 记忆需要保留亲笔地位，那是一次 E 轴回填/打标决策，属于
  P8/E 轴范围，应由用户另案裁定（本包不设计）。

若未来出现“亲笔记忆明显被蒸馏记忆压过”的实际体感，应先检查 E 轴在 selector 的
接线与署名覆盖率，而不是复活 `RECALL_SOURCE_BOOST`。

---

## 7. 若用户改判“实施 H5”：最小边界（备查，未实施）

| 方案 | 触点 | 效果 | 测试范围 |
|---|---|---|---|
| R1：只在 `runRecall` 加乘子 | `src/memory/v2/recall.ts:495-514`；`src/types.ts`；`src/gateway/settings.ts`；`tests/settings-coverage.test.ts` | 只改变 MCP/REST `memory_recall` 的返回顺序与 Gateway 候选池顺序；**不改变最终自动注入顺序** | 默认 1 逐字节不变；boost>1 时 mcp 命中排序前移；不匹配 source 不变；地板仍判 `raw_score` |
| R2：忠实复现旧可观察行为 | R1 + `SurfaceEntry` 增加 `source`、`handler.ts` 填充、`recallSelector.ts:239-244` 在 `rank` 上乘 source 因子 | 能影响最终注入；但与 authored/namespace 叠加，需要明确优先级 | 三协议注入断言；source/authored/namespace 三者叠加算例；无 source 时不变 |

无论哪个方案，都需要先裁定：

- 匹配集合是否仍为 `model/mcp`，还是改为当前词表（`mcp` + 哪些 dream/judge 值）；
- 是否设上限（建议 2，与 authored 一致）；
- 地板是否仍按 #37 判 `raw_score`（建议是；这样就不是旧行为的 1:1 移植）。

本包不建议实施；以上仅作为用户改判时的最小边界记录。

---

## 8. 证据索引

**旧分支（fix/logic-review）**

- `src/memory/v2/recall.ts:51-54`：`readSourceBoost` 默认/取值。
- `src/memory/v2/recall.ts:448-472`：source + role + decay 的乘法与位置。
- `src/memory/v2/recall.ts:520-528`：地板判 boost 后分数。
- `src/types.ts:40-41`：env 声明。
- `src/memory/dailyDigest.ts:905-940, 1205-1237`：`source: "model"` 与 `source:
  "dream"` 的写入语义。
- `test/phase2/recallSourceBoost.test.ts:57-173`：6 个行为测试。
- `HANDOVER.md:108-118, 237`；`README.md:269, 390`：旧意图与部署建议。

**当前分支（integration/upstream-v2）**

- `src/memory/v2/recall.ts:61-66, 495-518, 577-592`：authored boost、评分、地板。
- `src/gateway/handler.ts:25-35, 69-79, 132-136`：memoryKind、Gateway runRecall
  参数（k=12、reranker off）、selector + namespace boost。
- `src/memory/recallSelector.ts:45, 179, 235-244`：候选上限 16、每轮 1–2 条、
  selector 最终 rank。
- `src/memory/surface.ts:6-22`：`SurfaceEntry` 不含 source。
- `src/db/v2/memories.ts:103-125, 425-427`：亲手来源闸、E 轴裁剪、supersede 默认来源。
- `src/api/mcp.ts:436-445, 632, 771, 883-886, 910-913`：MCP source/authored_by。
- `src/api/memories.ts:106-111, 135, 898, 939, 1017`：REST source/authored_by。
- `src/memory/dream/lifecyclePhase.ts:78, 106, 133, 158`；
  `src/memory/dream/judgePhase.ts:99`；`src/memory/candidateJudge.ts:317`；
  `src/memory/rememberNow.ts:70-75`：当前来源词表。
- `src/memory/search.ts:428-435, 364`：RRF 与 legacy 来源。
- `src/memory/filter.ts:193-199`：reranker 重写 score。
- `src/extensions/memoryRanking.ts:14-16`：importance 加法因子。
- `migrations/0011_e_axis_authored.sql:1-5`：E 轴列。
- `memory/d1-backup-20260629.sql`：v1 聚合来源（仅计数）。

---

## 9. 未修改确认

- 本包只新增本文件与窗口交接文档；未修改业务代码、测试、迁移、`DEV.md` 或现有 plan。
- 未提交、未推送、未切分支。
- 未读取/输出凭证、环境变量、`wrangler.toml`、线上记忆正文。

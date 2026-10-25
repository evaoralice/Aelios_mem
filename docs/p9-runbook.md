# P9 Runbook · 迁移后索引重建与向量修复（P9-DS 修订版 · 二轮收口）

> 以 P8 迁移后的 D1 为唯一真源，修复 Vectorize 索引并重建 FTS。
> P9 只写 Vectorize 与 FTS 索引表（`memory_fts` / `message_fts`），
> **业务表（memories / daily_log / messages / …）全程只读**——索引修复失败不回滚、
> 不影响已验证的 D1 数据；所有步骤可重复运行、幂等；不以 Vectorize/FTS 反向覆盖 D1。
> 代码入口：`src/api/debug.ts` 的 `handleP9Reindex` / `handleFtsReindex`，
> 审计与修复逻辑全部复用 `src/memory/vectorBackfill.ts` / `vectorDoctor.ts` / `fts.ts`。

## 核心口径（与第一版的差异）

- **单 namespace 执行**：每次请求只处理一个 namespace、一个有界批次，返回
  `pending` / `converged`，调用方逐 namespace、逐批次重复执行到收敛。
  没有（也不允许）一次调用扫描/重建全部空间的操作。
- **namespace 走统一鉴权规则**（与全部 memory 端点相同的 `resolveNamespace`）：
  `chooseNamespace=false` 的 key 永远钉在自己的绑定 namespace，请求别的 namespace
  无效（实际只会操作绑定空间）；`chooseNamespace=true` 的 key 显式指定；
  **省略 namespace 落回 profile 默认，绝不会变成全空间操作**。
  三个旧向量维护入口（`/v1/vector-doctor`、`/v1/vector-backfill`、
  `/v1/debug/vector_reindex`）同规则但**拒绝得响**：pinned key 显式请求非绑定
  namespace 直接 403，且发生在任何扫描/写入/删除之前（维护工具操作者明确
  指了某个空间，静默改操作别的空间比报错更危险）。
- **同一份子请求预算**：扫描（D1 列表 + getByIds 批）与修复（每次 = 1 embedding +
  1 upsert = 2 个子请求）计入同一个保守预算（900，Workers 上限 1000 留余量），
  不是只算修复。预算只封顶不追吞吐，修不完的留 `pending`，重复调用继续。
- **失败 fail-closed**：FTS 顶层 D1 查询失败、rebuild 清空失败、orphan purge 删除
  失败都进 `fatal` → `ok:false` / `converged:false` / HTTP 500，绝不伪装成功；
  rebuild 清空失败后不继续重建。
- **不可分词内容是稳定终态**："..."、纯 emoji、单停用词等分词为空的内容写入
  `fts_body=''` 的空索引标记行，单独统计为 `unindexable`：不参与搜索、不阻止收敛、
  不会每轮重复失败；内容以后更新成正常文本时，正常写入路径会替换标记行。
- **FTS limit 是总上限且硬上限 100**：一次请求跨 messages/memories 共用一份额度，
  且 clamp 到 100（单行 FTS 写入最坏 6 个 D1 子请求，100 行 ≈ 604，明显低于
  Workers 每请求 1000 上限）；响应报 `requested_limit` / `effective_limit`。
- **FTS orphan 清理限定当前 namespace**：每轮 backfill 顺带清 orphan 行，但只删
  当前请求 namespace 的行——其他空间的 orphan 留给该空间自己的 backfill。

## 前置

- P8 已完成：部署链 post-verify 通过、`p8_verification` 标记已写。
- `MAINTENANCE_MODE` 已回 `"false"`（P9 在线上正常服务中运行即可，修复只补/重写索引）。
- 一把带 `memory:write` scope 的 API key（下称 `$KEY`）。
  **所有端点（p9-reindex、fts-reindex、vector-doctor、vector-backfill、
  debug/vector_reindex）都强制执行同一套 key profile 规则**，不是建议：
  `chooseNamespace=false` 的 key（im/mcp）只能操作绑定 namespace，显式请求其他
  namespace 直接 403（扫描/写入/删除发生之前）；省略 namespace 用绑定空间。
  跨空间逐 namespace 修复**必须**用 `chooseNamespace=true` 的 key（chatbox/debug
  profile）。
- vector doctor 的 `/list` 枚举另需 `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN`
  secrets（原有要求，非 P9 新增）。
- namespace 清单：P8 验收报告里的新 namespace 映射统计。本 runbook 对**每个** namespace
  重复 §1–§3；不存在自动遍历。

## 1. 向量：逐 namespace 先 dry-run 审计（默认）

```bash
curl -sS -X POST https://<host>/v1/p9-reindex \
  -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"namespace": "<ns>"}'
```

- 响应该 namespace 的 `counts`（ok / missing / stale / no_vector_id）、
  `unchecked`、`pending`、`converged`、`blockers`、`errors`、`subrequests`，
  **不含记忆正文或样本**；失败恢复所需的 ID（如 `repair.failed` 的记忆 id）
  可能出现，属于**敏感运维输出：不可外发、不可提交**。
- `stale` 含 namespace 漂移：P8 把 D1 namespace 从旧 role_scope 改写为新值后，
  停在旧值的向量对 namespaced query 永远召回隐身，repair 会按 D1 当前 namespace 重写。

## 2. 向量：同 namespace 显式修复，重复运行直到收敛

```bash
curl -sS -X POST https://<host>/v1/p9-reindex \
  -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"namespace": "<ns>", "dry_run": false}'
```

- 重复执行直到 `converged === true`（`pending` 清零且无 `unchecked` / `errors` /
  未触扫描上限）。批大小 `limit` 默认 20、上限 200；扫描与修复共用保守子请求预算，
  修不完的留 `pending`，下一轮继续。
- **Vectorize 写入异步生效**：修完立刻审计可能仍显示少量 missing/stale，重跑一轮再判。
- 收敛后再跑是幂等的：零 embedding、零写入。
- **队头持续失败时用 `skip` 游标**：失败项会按 D1 排序钉在修复队列头部，堵住后续
  条目。此时传 `{"skip": <已明确失败的条数>, "dry_run": false}` 跳过它们，让后续
  合法条目得到处理机会；被跳过的失败项仍在 `pending` 里明确上报，不会消失。
  最后回到 `skip: 0` 收尾——若失败项永远修不好，`converged` 保持 false，
  把 `repair.failed`（id + 错误，无正文）作为阻塞项报告。
- **`blockers.scan_truncated`**（active 记忆**超过** 5000 时触发；恰好 5000 条
  不触发，扫描按 5001 条探测边界）：只审计/修复了前 5000 条，后面的状态未知，
  `converged` 必为 false——把该 namespace 拆批（先按 id/时间范围处理子集，或
  人工裁定）后再继续，不得声称完成。

## 3. 向量：repair 后对该 namespace 运行 vector doctor（清理必须显式）

```bash
# 只清点（不带 cleanup）：
curl -sS -X POST https://<host>/v1/vector-doctor \
  -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"namespace": "<ns>"}'

# orphan / backed_inactive 需要“明确显式选择”才清理：
curl -sS -X POST https://<host>/v1/vector-doctor \
  -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"namespace": "<ns>", "cleanup": true}'
```

- `cleanup` 只认显式布尔 `true`；不传或传其他值**永远不会删除**。
- doctor 只删 Vectorize 向量，不碰 D1；漂移未修的活向量判 `backed_*`，不会被误删。
- doctor（以及 `/v1/vector-backfill`、`/v1/debug/vector_reindex`）与 P9 两个入口
  强制同一套 key profile 规则（见前置），没有"可选 namespace key"一说。
- （可选）对 P8 前的旧 namespace 值（role_scope 原值，见 P8 验收报告的映射统计）
  各跑一次 doctor：收敛后仍留在旧 namespace 的向量只剩迁移前残留
  （orphan / inactive-backed），可显式清理。

## 4. FTS：迁移后首个 rebuild 必做，之后 backfill 到收敛

**每个 namespace 都要执行一次 rebuild**——迁移前旧 namespace 的 FTS 行
（P8 改写过 D1 namespace，这些行 backfill 的 LEFT JOIN 够不到、也永远不会被重写）
只有 rebuild 清得掉；不做 rebuild，backfill 会对这些被旧行遮蔽的记忆**假报收敛**。

```bash
# ① 首个 rebuild（显式指定 namespace，一次即可）：
curl -sS -X POST https://<host>/v1/fts-reindex \
  -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"namespace": "<ns>", "rebuild": true}'

# ② 之后循环 backfill，直到 converged=true：
curl -sS -X POST https://<host>/v1/fts-reindex \
  -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"namespace": "<ns>"}'
```

- rebuild 清两层：本 namespace 的行 + D1 归属在本 namespace、FTS 行仍停在旧
  namespace 的迁移残留，再从 D1 重建。**rebuild 的清空失败会直接 fatal**
  （`ok:false` / `converged:false` / HTTP 500）且不继续重建——修好 D1/FTS 问题后
  重跑同一命令（DELETE 幂等）。反复 rebuild 不收敛（每轮先清空），rebuild 一次后
  回到 backfill 循环。
- backfill 的顶层 D1 查询失败同样 fatal，不会把"查不到"当"没有待处理"。
- `limit` 是本次请求的总处理上限（messages+memories 共用），**默认/硬上限 100**
  （单行 FTS 写入最坏 6 个 D1 子请求——3 次重试 × DELETE+INSERT——100 行 ≈ 604，
  明显低于 Workers 每请求 1000 的子请求上限；scheduled cron 的 `limit:400` 同样
  在内部被 clamp 到 100）。请求更大的值会 clamp，响应的 `requested_limit` 是
  请求值、`effective_limit` 是实际生效值；一轮处理了行就不会报 `converged`，
  空轮才算收敛。大量行持续写失败时 `failed>0` → `ok:false`/`converged:false`，
  先修环境再重跑，不会自动绕过。
- 每轮 backfill 顺带清理 orphan FTS 行（引用已不存在 message/memory 的行），
  **但只删当前请求 namespace 的行**——其他空间的 orphan 留给该空间自己的
  backfill；purge 删除失败同样进 `fatal`。迁移残留（停在旧 namespace 的行）
  不是 orphan，仍由首个 mandatory rebuild 的两层清空处理（规则不变）。
- `unindexable`（"..."、纯 emoji 等分词为空）是稳定终态：写入空标记行、单独统计，
  不参与搜索、不阻止收敛；内容以后更新成正常文本时由正常写入路径替换。
- FTS 失败只影响 fts 表本身，不会删除或回滚 memories、daily_log 等业务数据。

## 5. 验收口径（逐 namespace）

- `/v1/p9-reindex`：`converged === true` 且 `blockers.no_vector_id === 0` 且
  `blockers.scan_truncated === false`。
- `/v1/vector-doctor`：该 namespace `orphan === 0`（或残留已显式清理）。
- `/v1/fts-reindex`：rebuild 已执行一次 + backfill `converged === true`。
- 全部输出**不含正文、不含标签内容**；失败恢复所需的 ID（`repair.failed` 的
  记忆 id、doctor 样本的 `vector_id`/`ref_id` 等）可能出现——**敏感运维输出，
  不可外发、不可提交**。

## 阻塞与异常处理

- **`blockers.no_vector_id > 0`**：p9 工具不修（不编造 vector_id、不写 D1）。
  真实数据预期 0（P8 迁移保全 vector_id 列）；非 0 时**停下来作为阻塞项报告**，等裁定。
- **`blockers.scan_truncated`**：见 §2——不得声称收敛，拆批或人工裁定。
- **`unchecked > 0` 或 `errors` 非空**：Vectorize 抖动导致该批既不算 ok 也不算
  missing；重跑同一条命令即可（幂等，不会因抖动重刷整库）。
- **部分修复失败**（`repair.failed`）：失败项留 `pending` 下轮续修；队头持续失败用
  `skip` 游标放行后续项（见 §2）；连续失败先查 embedding 服务
  （`/v1/debug/vector_health`）再重跑。
- **FTS `fatal`**：查询/清空失败——先修环境（如 fts 表缺失），重跑同一命令；
  绝不把 fatal 当成功。
- 本 runbook 不涉及任何凭证、远程 D1 写或部署操作；不执行远端写命令。

## 已知未验证项（P12 处理）

- **Vectorize 同一 vector_id 跨 namespace 的真实行为**（旧 namespace 副本在
  repair 重写后是否残留、何时可见）：**留待 P12 线上 dry-run/doctor 实测**，
  本 runbook 不凭猜测承诺。doctor 的 `backed_*`/orphan 清点与 §3 的显式 cleanup
  是届时观察与处置的工具；实测结论出来前，不要对旧 namespace 副本做批量删除。
- **Vectorize 写后可见性的真实节奏**：§2 的"异步生效"在生产的实际延迟
  （修复后多久 dry-run 能看到），P12 用 `/v1/debug/vector_health` 与连续
  dry-run 实测，校准"修完立刻审计仍显示 missing"的重跑等待。
- **实际规模数据**：真实 `no_vector_id`、`unindexable` 计数与各 namespace 的
  active 记忆规模——决定 `scan_truncated`（>5000）是否实际会触发、批大小
  与预算参数是否需要调整。P12 逐 namespace 实测后回填。
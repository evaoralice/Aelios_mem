# Aelios 改造归档文档

> 记录从原版 Aelios 到当前版本的所有功能变更、设计决策和已知注意事项。
> 用于后续追溯和 bug 修复参考。
> 最后更新：2026-07-27

---

## 一、改造概览

共经历两大阶段：

| 阶段 | 分支 | 内容 |
|------|------|------|
| Phase 1-5 | `feat/cache-memory-tweak` | 缓存结构调整 + 记忆日志改造 + 来源加权 + 伪造 tool call 注入 |
| 多角色记忆 | `feat/multirole-memory` | 角色隔离 + 长期基线 + baseline pending + tool_call 透传修复 + 数值校验 |

---

## 二、Phase 1-5 缓存与记忆改造

### Phase 1：日志改造

| 改动 | 详情 |
|------|------|
| 做梦输出格式 | 一句话 summary → 分条列点（≤800 字） |
| daily_log 存储 | 同日覆盖 → 保留历史，每天新增一行 |
| boot 注入 | 只读一天日志 → 读最近两天 |
| digest 上限 | 500 字 → 1000 字（`DIGEST_MAX_CHARS` 常量统一） |
| 做梦 cron | UTC 20:10（北京 04:10）→ UTC 19:00（北京 03:00） |

**涉及文件：** `dailyDigest.ts`, `db/v2.ts`(getRecentDailyLogs), `assembler/types.ts`(formatBootStable), `wrangler.toml`, `index.ts`, `admin.ts`, `mcp.ts`, `memories.ts`

### Phase 2：来源标记 + 召回加权

| 改动 | 详情 |
|------|------|
| source 标记 | extract 已有；dream 已有；MCP 为 "mcp" |
| 召回加权 | `RECALL_SOURCE_BOOST`（默认 1.0），source 为 model/mcp 时得分 × boost |
| 加权位置 | 闸三（injection decay）之后、gate-2 去重之前 |

**涉及文件：** `recall.ts`, `types.ts`

### Phase 3：MCP 工具增强

| 改动 | 详情 |
|------|------|
| memory_upsert | 描述加 type 可选值 + fact_key 示例 |
| memory_context | 新增系统专用工具（MCP 提供，模型不应主动调用） |
| digest_get/set | 更新为 ≤1000 字 |

**涉及文件：** `mcp.ts`

### Phase 4：伪造 tool call 注入

| 改动 | 详情 |
|------|------|
| 注入方式 | `MEMORY_INJECTION_MODE`：`text`（默认，追加 user 消息）/ `toolcall`（伪造 memory_context tool_use + tool_result） |
| 注入位置 | 用户最新消息之后，所有缓存断点之后 |
| 内容 | `[timestamp] + 召回记忆 + pending 变更` |
| fallback | 保留 `appendUncachedUserContext` 函数，text 模式可切回 |

**涉及文件：** `anthropicAdapter.ts`, `openaiAdapter.ts`, `assembler/types.ts`, `toAnthropic.ts`

### Phase 5：缓存断点调整

| 改动 | 详情 |
|------|------|
| 断点 3 | bridge（历史中段）→ boot_stable 末尾 |
| boot_stable 缓存 | 摘要 + 日志 + 术语表进入缓存区，天级变化可接受 |
| 断点总数 | 仍为 4：工具列表 / 系统锚点 / boot_stable / tail |

**涉及文件：** `blocks.ts`, `anthropicAdapter.ts`

### 最终缓存布局

```
[断点1: 工具列表末尾]
[断点2: 系统锚点 — client_system]
  long_term_baselines（角色基线，每天变一次）
  digest（长期画像，≤1000 字）
  daily_log（最近两天日记，分条列点）
  glossary（术语表）
[断点3: boot_stable 末尾]
[断点4: tail — 倒数第二条消息]
[用户最新消息]
[memory_context tool call — 召回记忆 + pending 变更]  ← 动态区域，不缓存
```

---

## 三、多角色记忆系统

### 3.1 核心概念

| 概念 | 说明 |
|------|------|
| role_scope | 记忆归属作用域：`id:<role_id>` / `name:<规范化名称>` / `shared` |
| baseline | 角色的长期印象文本，模型通过 MCP pending 维护，做梦合并写入 |
| 原子记忆 | memories 表中的具体事实，`memory_upsert` 实时写入，向量召回 |
| daily_log | 每日互动日记，按角色分开，做梦生成 |

### 3.2 数据层

**新增/修改表：**

| 表 | 变更 | migration |
|------|------|-----------|
| memories | 加 role_id, role_name, role_scope | 0006 |
| messages | 加 role_id, role_name | 0006 |
| conversations | 加 role_id, role_name | 0006 |
| memory_lifecycle | 加 role_scope | 0006 |
| daily_log | 重建为 (namespace, role_scope, date) PK | 0006 |
| memory_changelog | 新建（原子记忆 pending，已屏蔽） | 0006 |
| long_term_baselines | 新建 | 0006 |
| long_term_baseline_snapshots | 新建 | 0006 |
| baseline_changelog | 新建（baseline pending） | 0007 |

**索引：**
- `idx_memories_role_scope (namespace, role_scope, status)`
- `idx_memories_role_fact (namespace, role_scope, fact_key)`
- `idx_messages_role_created (namespace, role_id, created_at)`
- `idx_changelog_namespace_role_status (namespace, role_scope, status, created_at)`

### 3.3 role_scope 隔离

所有操作按 `namespace + role_scope` 隔离：

| 操作 | 隔离方式 |
|------|---------|
| fact_key upsert | WHERE 加 role_scope 条件 |
| embedding 语义去重 | 同 role_scope 内比较 |
| supersede | 继承旧记忆归属 |
| 做梦整理 | 按 role_scope 分组，不跨角色合并 |

### 3.4 MCP 工具最终状态

| 工具 | 状态 | 写入目标 | 用途 |
|------|------|---------|------|
| baseline_change | **启用** | baseline_changelog (pending) | 模型提交 baseline 变更 |
| memory_upsert | **启用** | memories（实时） | 实时写原子记忆 |
| memory_change_add/update/delete | **已屏蔽** | memory_changelog | handler 保留，getTools 注释掉 |
| memory_context | **启用** | 无写入（系统专用） | 伪造 tool call 注入记忆 |
| memory_pin | **启用** | precious（共享） | 珍贵记忆（本期不支持角色） |
| 其他读取工具 | **启用** | — | 加了 role_id/role_name 可选参数 |

### 3.5 baseline pending 7 条规则

1. baseline 只能由 `baseline_change` pending 修改
2. 普通 dream 不得自行修改 baseline
3. baseline pending 独立处理，不随分批重复
4. 每晚每个有 pending 的角色只合并写入一次
5. 没有 pending 就不调用 baseline 模型
6. 生成+写入都成功才标记 applied；失败保留 pending 重试
7. MCP 校验：add 必须有 after / update 必须有 before+after / delete 必须有 before / role_id+reason 必填 / 不允许 shared baseline

### 3.6 baseline 错误处理

| 失败类型 | 处理 |
|---------|------|
| 模型调用失败 | markBaselineChangelogError（保持 pending，下次重试） |
| 模型返回空 | 同上 |
| 写入失败 | 同上 |
| 读取旧 baseline 失败 | 跳过该 scope，不覆盖 |
| applied 成功 | markBaselineChangelogApplied + 清除 error_message |

### 3.7 召回加权

**位置：** reranker 之后（post-reranker），不前移

**公式：** `score × source_boost × role_boost`

**role boost 规则：**
1. role_id 精确匹配 → `RECALL_ROLE_BOOST_EXACT`（默认 1.3）
2. 缺 ID 但名称匹配 → `RECALL_ROLE_BOOST_NAME`（默认 1.1）
3. 两边都有不同 ID → 不因同名加权
4. 共享记忆 → 不加权

### 3.8 做梦流程

```
1. applyPendingChanges（原子记忆 pending，代码执行）
2. applyBaselineChanges（baseline pending，按 scope 分组，每组调一次模型合并）
3. 读取消息，按 role_id 分组
4. 每组：共享消息 + 角色消息 → 喂给模型整理
5. 输出：memories_to_update/delete + daily_log（按角色）
6. 校验：跨 scope 写入拦截 + 写入白名单 + 重复 target 阻止
```

**安全规则：**
- 跨 scope 修改被校验拦截
- 写入白名单：只允许实际构建的 roleGroups 写入
- 重复 target：同一 target_id 多次操作 → 全部跳过
- 角色数超限 → 失败不推进 cursor
- 模型未携带归属 → 代码从输入分组恢复，不降级共享

### 3.9 Operit 角色标记

前端通过 `<aelios_role_context>` XML 标记在独立 SYSTEM 消息中传递角色信息：

```xml
<aelios_role_context>
{"role_id":"稳定角色卡ID","role_name":"当前角色名称"}
</aelios_role_context>
```

**解析规则：**
- body 顶层 role_id/role_name 优先，缺字段才用标记
- 只认独立 SYSTEM 消息（string content，只含标记块）
- JSON + 字段白名单 + ≤200 字符
- 多标记 / 残缺 / 解析失败 → 删标记 + warn，不转发上游

---

## 四、Bug 修复记录

### tool_call/tool_result 透传（第四轮）

**问题：** assembler 过滤了 `role=tool` 消息并丢弃 assistant 的 `tool_calls` 字段 → 模型看不到 MCP 调用历史 → 重复 upsert

**修复：**
- assembler 保留 tool 消息和 tool_calls 字段
- 请求以 tool result 结尾时不拆分 current_user
- tool 续接请求不重复保存 user 消息
- 空 content + 有 tool_calls 的 assistant 响应不保存
- 流式路径同步修复（OpenAI + Anthropic）

### importance/confidence 范围校验（第五轮）

**问题：** 模型传 importance=9 或 10 直接存入数据库，导致召回分数异常

**修复：** MCP 超 0-1 范围直接返回 toolError，不静默 clamp

---

## 五、环境变量完整列表（本次新增）

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `MEMORY_INJECTION_MODE` | `text` | `text` / `toolcall` |
| `RECALL_SOURCE_BOOST` | `1.0` | source 为 model/mcp 时加权 |
| `ROLE_MEMORY_ENABLED` | `false` | 角色记忆总开关 |
| `RECALL_ROLE_BOOST_EXACT` | `1.3` | role_id 精确匹配加权 |
| `RECALL_ROLE_BOOST_NAME` | `1.1` | role_name 兜底加权 |
| `BASELINE_MAX_CHARS_PER_ROLE` | `2000` | 基线文本 per role 上限 |
| `BASELINE_MAX_CHARS_TOTAL` | `8000` | 基线文本总量上限 |
| `DREAM_MAX_ROLES_PER_RUN` | `5` | 单次做梦最多处理角色数 |
| `ENABLE_AUTO_MEMORY` | （空=开启） | `false` 关闭自动提取 |

### 已修改的常量

| 常量 | 旧值 | 新值 | 位置 |
|------|------|------|------|
| `MEMORY_HARD_DELETE_DAYS` | 30 | 365 | `retention.ts` |
| `DIGEST_MAX_CHARS` | 500 | 1000 | `db/v2.ts` |
| `DAILY_MAINTENANCE_CRON` | `10 20 * * *` | `0 19 * * *` | `index.ts` + `wrangler.toml` |
| `MESSAGES_RETENTION_DAYS` | 3 | 3（未改，README 原来写错为 14） | `retention.ts` |

---

## 六、部署清单

1. **备份 D1**：`wrangler d1 export companion_memory_proxy --output backup.sql`
2. **本地验证 migration**：用临时 toml 指向本地 D1 执行
3. **部署**：`npm run deploy:cloudflare`
4. **Vectorize 回填**：`node scripts/backfill-vectorize-role.mjs --apply`
5. **环境变量**：先不设新变量（默认行为不变），观察稳定后逐步开启：
   - `MEMORY_INJECTION_MODE=toolcall`
   - `RECALL_SOURCE_BOOST=1.2`
   - `ROLE_MEMORY_ENABLED=true`
   - `ENABLE_AUTO_MEMORY=false`

---

## 七、测试覆盖

| 测试套件 | 数量 | 说明 |
|---------|------|------|
| TypeScript 类型检查 | — | `npx tsc --noEmit` |
| verify-assembler.mjs | 177 | assembler + 记忆 + 淘汰逻辑 |
| verify-cache-strategy.mjs | 15 | 缓存断点策略 |
| vitest | 240 | 多角色 + baseline pending + tool_call 透传 + 数值校验 |

**验证命令：**
```bash
npm run typecheck && npx vitest run && node scripts/verify-assembler.mjs && node scripts/verify-cache-strategy.mjs
```

---

## 八、已知限制 / 暂不做

| 项目 | 原因 |
|------|------|
| 管理面板按角色筛选 | 先靠 API 查 |
| 角色 ID 迁移工具 | 等遇到角色卡重导入再做 |
| visibility 字段（角色私有记忆） | 等出现隐私需求 |
| 多窗口隔离 | 暂按单窗口 |
| 自动提取角色归属 | 低优先级 |
| memory_pin 角色支持 | 本期 precious 仅共享 |
| token 超限自动拆分做梦调用 | 依赖 DREAM_MAX_ROLES_PER_RUN 限制 |
| 跨 scope 召回去重（Jaccard） | 观察实际召回后再决定 |

---

## 九、设计决策记录

| 决策 | 理由 |
|------|------|
| baseline 和 memories 独立 | baseline 是角色印象（稳定），memories 是具体事实（可频繁变更） |
| baseline 由模型主动维护，做梦只合并 | 避免做梦模型自动生成不准确的 baseline |
| role boost 后置（reranker 后） | 前移会被 reranker 覆盖，boost 失效 |
| 屏蔽 memory_change_* 保留 memory_upsert | 原子记忆实时更新更好（避免当天召回过时内容），baseline 走 pending 保护缓存 |
| 不允许 shared baseline | 共享信息走 memories 召回，角色觉得重要会写进自己的 baseline |
| 存储去重只在同 role_scope 内 | 不同角色可能有相似但独立的记忆 |
| 召回去重只折叠不删记录 | 数据库完整性优先于注入效率 |
| update/delete 从目标记忆继承归属 | 防止通过省略参数跨角色修改 |

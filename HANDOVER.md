# Aelios 缓存与记忆改造 — 开发交接文档

> 本文件供后续接手开发的模型/人阅读。确保在上下文缺失时，仅凭本文 + 代码即可完整理解进度并继续。

---

## 一、项目背景

Aelios 是一个运行在 Cloudflare Workers 上的 AI 记忆代理系统。核心功能：
- 代理 LLM 对话请求（OpenAI / Anthropic 兼容）
- 长期记忆管理（D1 数据库 + Vectorize 向量索引）
- Prompt 缓存优化（Anthropic 4 断点策略）
- 定时记忆整理（extract 4h + dream 每天 + retention 清理）

本次改造目标：优化缓存结构和记忆注入方式，分为 5 个阶段实施。

**相关文件：**
- `plan/缓存与记忆改造方案.md` — 原始改造方案（只读，不改）
- `plan/实施计划.md` — 详细的执行细则（已按审查意见修正）
- `plan/实施计划审查意见.md` — 对实施计划的代码级审查意见

---

## 二、开发方法论

采用 TDD（测试驱动开发）：
1. **RED**：先写测试，确认首次运行失败
2. **GREEN**：实现功能，逐个测试点通过
3. 每个功能点测试全通过后再做下一个
4. 使用 mock 数据，不依赖真实 D1/Vectorize

测试框架：vitest 2.x + @types/node 18
- 测试目录：`test/`
- 配置文件：`vitest.config.ts`
- D1 mock 工具：`test/helpers/d1-mock.ts`（`createMockD1` + `createMockEnv`）
- 运行命令：`npx vitest run`（全部）或 `npx vitest run test/phaseN/`（按阶段）

另有两个旧的契约镜像脚本（纯 Node.js，无 vitest）：
- `scripts/verify-assembler.mjs` — assembler 逻辑镜像测试
- `scripts/verify-cache-strategy.mjs` — 缓存断点策略镜像测试
- 运行：`node scripts/verify-assembler.mjs` / `node scripts/verify-cache-strategy.mjs`

**改动源码时必须同步更新这两个镜像脚本，否则会失败。**

---

## 三、整体架构

```
写入侧                              读取侧                            组装侧
extractPipeline (4h cron)  ──┐
dailyDigest    (daily cron) ──┼──→  D1 + Vectorize  ──→     buildBootPackage ──→ boot_stable block
MCP upsert               ──┘                                     (after anchor, day-stable)
                               runRecall (per-turn) ────→ dynamic_memory_patch
                                                        (after anchor, uncached)
```

Prompt 结构（9 个 block，按固定顺序）：
```
proxy_static_rules → persona_pinned → preset_lite → client_system [缓存锚点]
→ boot_stable [断点3] → client_volatile_context → dynamic_memory_patch
→ vision_context → recent_history → current_user [断点4 tail]
```

4 个缓存断点：
1. 工具列表末尾（adapter 层 applyToolsCacheBreakpoint）
2. 系统锚点 = client_system 之后
3. boot_stable 末尾（Phase 5 新增，替换了原来的 bridge）
4. tail = 倒数第二条消息

---

## 四、各阶段状态总览

| 阶段 | 内容 | 风险 | 状态 |
|------|------|------|------|
| 1 | 日志改造 | 低 | ✅ 完成 |
| 2 | 来源标记 + 召回加权 | 低 | ✅ 完成 |
| 3 | memory_upsert 工具描述 | 低 | ✅ 完成 |
| 4 | 伪造 tool call 注入记忆 | 高 | ✅ 完成 |
| 5 | 缓存断点调整 | 中 | ✅ 完成 |

**全部 5 个阶段已完成。vitest 55/55 通过，verify-assembler 177/0，verify-cache-strategy 15/0。**

> **Phase 4+5 刚刚完成代码改动，尚未运行 typecheck 全量验证。** 接手后请先运行：
> ```bash
> npm run typecheck && npx vitest run && node scripts/verify-assembler.mjs && node scripts/verify-cache-strategy.mjs
> ```
> 如果有失败，根据失败信息修复（最可能是 verify-assembler.mjs 中遗漏的 cache_control 相关断言）。

---

## 五、各阶段改动详情

### 阶段 1：日志改造（✅ 完成）

**改动文件：**
- `src/db/v2.ts` — 新增 `getRecentDailyLogs()` 函数 + `DIGEST_MAX_CHARS = 1000` 常量
- `src/assembler/types.ts` — `formatBootStable()`: `yesterday_log` → `recent_logs[]`，输出 `<daily_log>` 标签
- `src/memory/v2/recall.ts` — `BootPackage` 类型 + `buildBootPackage()`: 改用 `getRecentDailyLogs(limit=2)`
- `src/memory/dailyDigest.ts` — digest 截断 500 → `DIGEST_MAX_CHARS`
- `src/api/mcp.ts` — `digest_set` 验证 500 → `DIGEST_MAX_CHARS`，描述更新，导出 `callTool`
- `src/api/memories.ts` — PATCH 端点 `slice(0, 1200)` → `DIGEST_MAX_CHARS`
- `src/api/admin.ts` — 管理面板 textarea maxlength/计数器/slice 从 500 → 1000
- `src/index.ts` — `DAILY_MAINTENANCE_CRON` 导出，值改为 `"0 19 * * *"`（北京 03:00）
- `wrangler.toml` — cron `"10 20 * * *"` → `"0 19 * * *"`

**测试文件：** `test/phase1/`（5 个文件，30 个测试）

---

### 阶段 2：来源标记 + 召回加权（✅ 完成）

**改动文件：**
- `src/memory/v2/recall.ts` — 新增 `readSourceBoost()` + 加权逻辑（在闸三降权和闸二去重之间）
- `src/types.ts` — Env 新增 `RECALL_SOURCE_BOOST` 字段

**加权逻辑：** `source` 为 `"model"` 或 `"mcp"` 的记忆得分 × `RECALL_SOURCE_BOOST`（默认 1.0）。必须在 reranker 评分之后、gate-2 去重之前。

**注意：** `extractPipeline.ts` 不需要改（已传 `source: "extract"`）。`dailyDigest.ts` 已有 `source: "dream"`。

**测试文件：** `test/phase2/recallSourceBoost.test.ts`（6 个测试）

---

### 阶段 3：memory_upsert 工具描述（✅ 完成）

**改动文件：**
- `src/api/mcp.ts` — `memory_upsert` 工具的 `description` 和 `fact_key` 字段 `description` 更新

**决策：** 不新建 `memory_save` 工具，直接用现有 `memory_upsert`。只改描述让模型更清楚 `fact_key` 的去重用途 + 命名示例 + 鼓励主动调用。

**测试文件：** `test/phase3/memoryUpsertDescription.test.ts`（4 个测试）

---

### 阶段 4：伪造 tool call 注入记忆（✅ 完成）

**改动文件：**
- `src/assembler/types.ts` — 新增 `SyntheticContext` 接口 + `AssembledPrompt.synthetic_context`
- `src/assembler/toAnthropic.ts` — `assembledToAnthropicMessages()` 新增 `syntheticContext` 参数，追加合成 `tool_use` + `tool_result`
- `src/proxy/anthropicAdapter.ts` — 新增 `buildSyntheticContext()` + `MEMORY_INJECTION_MODE` 切换逻辑
- `src/api/mcp.ts` — 新增 `memory_context` 工具定义 + 兜底响应
- `src/types.ts` — Env 新增 `MEMORY_INJECTION_MODE` 字段

**机制：**
- `MEMORY_INJECTION_MODE = "text"`（默认）→ 旧的文本追加方式（`appendUncachedUserContext`）
- `MEMORY_INJECTION_MODE = "toolcall"` → 伪造 `tool_use`/`tool_result` 对注入记忆

**tool_use_id 格式：** `toolu_${crypto.randomUUID().replace(/-/g, "")}` — 匹配 Anthropic 真实格式，避免拒收。

**兜底响应：** 模型如果主动调用 `memory_context`，返回：
```
"This tool is system-managed and has already been executed. The relevant context has been provided. Do not call this tool manually."
```

**测试文件：** `test/phase4_5/`（5 个文件，15 个测试）

---

### 阶段 5：缓存断点调整（✅ 完成）

**改动文件：**
- `src/assembler/blocks.ts` — `assemble()` 中：
  - 新增 boot_stable cache_control（断点3）
  - 移除 bridge 断点逻辑
- `scripts/verify-assembler.mjs` — assemble 镜像同步更新，测试断言更新
- `scripts/verify-cache-strategy.mjs` — assemble 镜像同步更新，T5/T6/T12/T14 测试更新

**断点变化：**
| # | 改前 | 改后 |
|---|------|------|
| 1 | 工具列表末尾 | 不变 |
| 2 | 系统锚点(client_system) | 不变 |
| 3 | bridge(历史中段,>16块时) | **boot_stable 末尾** |
| 4 | tail(倒数第二条消息) | 不变 |

---

## 六、改动文件总览（19 个源文件 + 12 个测试文件 + 2 个镜像脚本）

**源码：**
- `src/api/admin.ts` — digest 截断 500→1000
- `src/api/mcp.ts` — digest_set/DIGEST_MAX_CHARS + memory_context 工具 + callTool 导出 + memory_upsert 描述
- `src/api/memories.ts` — PATCH 端点 DIGEST_MAX_CHARS
- `src/assembler/assemble.ts` — 注释更新
- `src/assembler/blocks.ts` — boot_stable cache_control + 移除 bridge
- `src/assembler/toAnthropic.ts` — syntheticContext 参数 + 合成消息追加
- `src/assembler/types.ts` — SyntheticContext + formatBootStable recent_logs
- `src/db/v2.ts` — getRecentDailyLogs + DIGEST_MAX_CHARS
- `src/index.ts` — DAILY_MAINTENANCE_CRON 导出 + 值
- `src/memory/dailyDigest.ts` — DIGEST_MAX_CHARS 导入 + 截断
- `src/memory/v2/recall.ts` — getRecentDailyLogs + BootPackage + readSourceBoost
- `src/proxy/anthropicAdapter.ts` — MEMORY_INJECTION_MODE + buildSyntheticContext
- `src/types.ts` — RECALL_SOURCE_BOOST + MEMORY_INJECTION_MODE
- `wrangler.toml` — cron 时间
- `tsconfig.json` — include test/ + types node
- `package.json` — vitest + @types/node + test scripts

**镜像脚本：**
- `scripts/verify-assembler.mjs` — assemble 镜像 + boot_stable cache_control + 测试断言
- `scripts/verify-cache-strategy.mjs` — assemble 镜像 + boot_stable 断点 + T5/T6/T12/T14

**测试：**
- `vitest.config.ts`
- `test/helpers/d1-mock.ts`
- `test/phase1/` — 5 文件 30 测试
- `test/phase2/` — 1 文件 6 测试
- `test/phase3/` — 1 文件 4 测试
- `test/phase4_5/` — 5 文件 15 测试

---

## 七、待验证 / 后续工作

### 接手后第一件事
```bash
cd /home/yyuan/projects/Aelios
npm run typecheck && npx vitest run && node scripts/verify-assembler.mjs && node scripts/verify-cache-strategy.mjs
```

如果全部通过 → 一切正常，可以进入后续工作。
如果有失败 → 根据失败信息修复（最可能是 verify-assembler.mjs 中的 cache_control 相关断言遗漏）。

### 可能需要修复的遗留问题

1. **`verify-assembler.mjs` 滚动缓存测试**：`applyRollingMessageCache` 中用 `systemCacheCount` 计算可用消息断点数。Phase 5 新增 boot_stable cache_control 后 systemCacheCount 从 1 变 2，可能影响滚动缓存的 maxMessageMarkers 计算。需要检查滚动缓存相关测试是否仍通过。

2. **`toOpenAI.ts`**：Phase 4 的合成消息目前只在 Anthropic 路径实现。OpenAI 兼容模型（`assembledToOpenAIMessages`）未处理 `synthetic_context`。如果需要支持 OpenAI 模型的 toolcall 注入模式，需补充。

3. **实际对话测试**：所有改动已通过单元测试和镜像测试，但尚未进行真实 API 对话测试。部署后需要：
   - 确认 `MEMORY_INJECTION_MODE=toolcall` 时模型能正确读取 tool_result 中的记忆
   - 确认模型不会主动调用 `memory_context` 工具
   - `/v1/debug/cache_health` 确认缓存命中率

4. **环境变量配置**：部署前需要在 Cloudflare Dashboard 设置：
   - `RECALL_SOURCE_BOOST` = `"1.2"`（阶段2加权，可灰度）
   - `MEMORY_INJECTION_MODE` = `"text"`（默认安全模式，验证后切 `"toolcall"`）

### 其他项目（扭蛋/gacha）

工作目录 `/home/yyuan/projects/gacha/` 下有一个独立的小项目（与 Aelios 无关），已完成 v1/v2/v3 卡池开发。不影响 Aelios 改造。

---

## 八、关键命令速查

```bash
# 全量测试
npm run typecheck && npx vitest run && node scripts/verify-assembler.mjs && node scripts/verify-cache-strategy.mjs

# 按阶段测试
npx vitest run test/phase1/   # 阶段1
npx vitest run test/phase2/   # 阶段2
npx vitest run test/phase3/   # 阶段3
npx vitest run test/phase4_5/ # 阶段4+5

# 类型检查
npm run typecheck

# 部署
npm run deploy
```

---

## 九、环境变量汇总

| 变量 | 默认值 | 阶段 | 说明 |
|------|--------|------|------|
| `RECALL_SOURCE_BOOST` | `1.0` | 2 | 来源加权系数，`1.2` 启用 |
| `MEMORY_INJECTION_MODE` | `text` | 4 | `text`=追加文本，`toolcall`=伪造 tool call |
| `DAILY_MAINTENANCE_CRON` | `0 19 * * *` | 1 | 已硬编码到 index.ts |
| `DIGEST_MAX_CHARS` | `1000` | 1 | 代码常量，非环境变量 |
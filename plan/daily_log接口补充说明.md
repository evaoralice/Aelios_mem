# Daily Log 接口补充说明

> 新增 daily_log 的独立 HTTP 接口和 MCP 工具，使日记可以被前端和模型直接读写。
> 此前 daily_log 仅由 dream（凌晨定时任务）自动生成，且只能通过 `GET /v1/memory_boot` 间接读取。

---

## 改动概述

### 1. 新增 HTTP 接口

**路由：** `/v1/daily_log`（同时支持 `/v1/daily-log`）

#### `GET /v1/daily_log`

读取日记。鉴权要求：`memory:read` scope。

| 查询参数 | 类型 | 默认 | 说明 |
|---------|------|------|------|
| date | string | — | YYYY-MM-DD，指定日期查单条 |
| limit | number | 30（最大 365） | 不传 date 时返回最近 N 天 |
| role_scope | string | shared | 角色范围 |
| namespace | string | profile default | debug key 可覆盖 |

**响应（单条）：**
```json
{
  "data": {
    "namespace": "default",
    "role_scope": "shared",
    "date": "2026-07-30",
    "title": "温柔的一天",
    "summary": "- 聊了前端布局的问题\n- 讨论了记忆系统的设计",
    "updated_at": "2026-07-30T19:00:00.000Z"
  }
}
```

**响应（列表）：**
```json
{
  "data": [
    { "namespace": "...", "role_scope": "...", "date": "...", "title": "...", "summary": "...", "updated_at": "..." }
  ]
}
```

#### `POST /v1/daily_log`

写入或更新日记。鉴权要求：`memory:write` scope。

**请求体：**
```json
{
  "date": "2026-07-30",
  "title": "温柔的一天",
  "summary": "- 聊了前端布局的问题\n- 讨论了记忆系统的设计",
  "role_scope": "shared"
}
```

| 字段 | 必填 | 说明 |
|------|:----:|------|
| date | 是 | YYYY-MM-DD |
| title | 是 | ≤12 字 |
| summary | 否 | 分条列点（`- ` 开头），≤800 字 |
| role_scope | 否 | 默认 shared |

同一 `(namespace, role_scope, date)` 存在时覆盖更新（upsert）。

---

### 2. 新增 MCP 工具

#### `daily_log_read`

读取日记。需要 `memory:read` scope。

| 参数 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| date | string | 否 | YYYY-MM-DD，指定日期查单条 |
| limit | number | 否 | 不传 date 时返回最近 N 天（默认 7，最大 365） |
| role_scope | string | 否 | 默认 shared |
| namespace | string | 否 | |

#### `daily_log_write`

写入或更新日记。需要 `memory:write` scope。

| 参数 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| date | string | 是 | YYYY-MM-DD |
| title | string | 是 | ≤12 字 |
| summary | string | 否 | 分条列点，≤800 字 |
| role_scope | string | 否 | 默认 shared |
| namespace | string | 否 | |

---

### 3. 改动文件

| 文件 | 改动 |
|------|------|
| `src/api/memories.ts` | 新增 `handleDailyLog` 函数，新增 `getRecentDailyLogs`、`upsertDailyLog` 的 import |
| `src/index.ts` | 注册 `/v1/daily_log` 和 `/v1/daily-log` 路由，新增 `handleDailyLog` 的 import |
| `src/api/mcp.ts` | 新增 `daily_log_read`、`daily_log_write` 工具定义和 handler，新增 `getDailyLog`、`getRecentDailyLogs`、`upsertDailyLog` 的 import |

### 4. 数据库

无新增迁移。复用已有的 `daily_log` 表和 `getDailyLog`、`getRecentDailyLogs`、`upsertDailyLog` 三个数据库函数（`src/db/v2.ts`）。

### 5. 鉴权

复用现有 API Key 权限体系，不新增 scope：

| API Key | 读日记 | 写日记 |
|---------|:------:|:------:|
| CHATBOX_API_KEY | ✓ | ✓ |
| IM_API_KEY | ✓ | ✓ |
| DEBUG_API_KEY | ✓ | ✓ |
| MEMORY_MCP_API_KEY | ✓ | ✓ |
| GUIDE_DOG_API_KEY | ✗ | ✗ |

### 6. 与现有 dream 写入的关系

dream（凌晨定时任务）仍然会自动生成 daily_log。新增的写入接口和 dream 共用 `upsertDailyLog`（INSERT ON CONFLICT UPDATE），后写入的覆盖先写入的。

如果模型通过 MCP 在白天写了日记，凌晨 dream 跑的时候会覆盖。如果需要保留模型白天写的内容，dream 流程中已有合并机制（读取已有日记传给模型做合并），不会丢失。

---

## 审查要点

- [ ] HTTP 接口鉴权是否完整（401 / 403 路径）
- [ ] MCP 工具权限检查是否正确
- [ ] upsert 语义是否符合预期（同日期覆盖）
- [ ] 与 dream 自动生成的 daily_log 是否存在竞态风险
- [ ] namespace 解析是否正确（非 debug key 不能覆盖 namespace）

---

## 审查后改动记录

### 改动 1：dream 写 daily_log 开关 `DREAM_WRITE_DAILY_LOG`

**原因：** 新增 `/v1/daily_log` 和 MCP `daily_log_write` 后，白天模型/前端可主动写日记。但凌晨 dream 仍会调用 `upsertDailyLog` 覆盖同 `(namespace, role_scope, date)` 的记录。dream 跑批是多批循环（`runDailyMemoryDigest` 内部 for 循环），跑批过程中若模型并发写入同一日期，`INSERT ON CONFLICT UPDATE` 是"后写者覆盖先写者"，无事务级锁，会导致内容丢失。审查要点"与 dream 自动生成的 daily_log 是否存在竞态风险"由此确认。

**方案：** 新增环境变量 `DREAM_WRITE_DAILY_LOG`（默认 `true`，保留原行为）。设为 `false` 时 dream 跳过 daily_log 写入（per-role 和 shared 两处都跳），改由模型/前端通过新接口主动写，从根上消除竞态。baseline、digest、记忆抽取/更新/删除等其它 dream 逻辑不受影响。

| 环境变量 | 类型 | 默认值 | 说明 |
|---------|------|-------|------|
| `DREAM_WRITE_DAILY_LOG` | string | `"true"` | `"true"` 时 dream 正常写 daily_log（保留原行为）；`"false"` 时跳过写入，改由新接口主动写。未设置时等同 `"true"`。 |

**影响范围：** 仅 dream 写 daily_log 的行为。关掉后 daily_log 表不再有凌晨自动写入，需要模型或前端主动写——这正是本次新增接口的用途，语义自洽。

**改动文件：**

| 文件 | 改动 |
|------|------|
| `src/types.ts` | `Env` 接口新增 `DREAM_WRITE_DAILY_LOG?: string` |
| `src/memory/dailyDigest.ts` | 新增 `shouldDreamWriteDailyLog(env)` 读取开关；在 per-role 写入处（`P1-3: write per-role daily_log`）和 shared 写入处（`Non-role path`）两处 `upsertDailyLog` 调用前加 `if (shouldDreamWriteDailyLog(env))` 判断 |

**配置示例：** `wrangler.toml` 的 `[vars]` 中加 `DREAM_WRITE_DAILY_LOG = "false"` 即可关闭 dream 自动写日记。

### 改动 2：`daily_log_write` 长度校验（已修复）

**原因：** 文档要求 title≤12 字、summary≤800 字，但原实现只校验非空，未做长度校验。模型或前端可能写入超长内容，凌晨 dream 又因 prompt 约束截断，造成数据不一致。对比 `digest_set` 已有 `DIGEST_MAX_CHARS` 硬校验。

**方案：** HTTP 和 MCP 两端在 title/summary 非空校验后追加长度校验，超长直接返回错误（HTTP 400 / MCP toolError），不静默截断，让调用方明确知道越界。

**改动文件：**

| 文件 | 改动位置 | 改动 |
|------|---------|------|
| `src/api/memories.ts` | `handleDailyLog` POST 分支 | title 校验 `> 12` 返回 400；summary 校验 `> 800` 返回 400 |
| `src/api/mcp.ts` | `callTool` `daily_log_write` 分支 | title 校验 `> 12` 返回 toolError；summary 校验 `> 800` 返回 toolError |

### 改动 3：POST `role_scope` 来源理清（已修复）

**原因：** 原 `handleDailyLog` POST 分支用 `readString(body.role_scope) || roleScope`，其中 `roleScope` 来自 query 参数。导致 POST 时 `role_scope` 有两个来源（query + body），语义不清，文档未说明 POST 支持 query 传 role_scope，容易误用。

**方案：** POST 分支直接 `readString(body.role_scope) || "shared"`，不复用 GET 的 query 变量，POST 只认 body。

**改动文件：**

| 文件 | 改动位置 | 改动 |
|------|---------|------|
| `src/api/memories.ts` | `handleDailyLog` POST 分支 `bodyRoleScope` | 由 `readString(body.role_scope) || roleScope` 改为 `readString(body.role_scope) || "shared"` |

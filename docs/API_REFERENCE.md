# Aelios API 接口参考

> 所有接口的完整请求/响应格式。基于源码整理。
> 最后更新：2026-07-31

---

## 认证

除 `GET /health` 和 `GET /admin` 外，所有接口需要 Bearer token：

```
Authorization: Bearer <token>
```

或：

```
X-API-Key: <token>
```

MCP 端点额外支持 `?token=<key>` 查询参数。

### API Key 权限

| 环境变量 | 权限 |
|---------|------|
| `CHATBOX_API_KEY` | chat:proxy, memory:read, memory:write, cache:read, cache:write |
| `IM_API_KEY` | chat:proxy, memory:read, memory:write, cache:read |
| `DEBUG_API_KEY` | 全部权限 + debug:read + export:read |
| `MEMORY_MCP_API_KEY` | memory:read, memory:write, export:read |
| `GUIDE_DOG_API_KEY` | chat:proxy |

只有 debug 可以覆盖 namespace 参数。

### 错误格式（所有接口统一）

```json
{
  "error": {
    "message": "错误描述",
    "type": "invalid_request_error",
    "param": null,
    "code": null
  }
}
```

---

## 聊天

### `POST /v1/chat/completions`

OpenAI 兼容聊天接口，带记忆注入。

**权限：** chat:proxy

**请求：**
```json
{
  "model": "companion",
  "messages": [
    { "role": "system", "content": "..." },
    { "role": "user", "content": "..." },
    { "role": "assistant", "content": "...", "tool_calls": [] },
    { "role": "tool", "content": "...", "tool_call_id": "..." }
  ],
  "stream": false,
  "temperature": 0.7,
  "max_tokens": 4096,
  "tools": [],
  "role_id": "角色ID（可选）",
  "role_name": "角色名（可选）"
}
```

`role_id`/`role_name` 也可通过 Operit `<aelios_role_context>` 标记在独立 SYSTEM 消息中传递，body 顶层优先。

**响应（非流式）：**
```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "created": 1700000000,
  "model": "upstream-model",
  "choices": [{
    "index": 0,
    "message": { "role": "assistant", "content": "回复内容" },
    "finish_reason": "stop"
  }],
  "usage": {
    "prompt_tokens": 100,
    "completion_tokens": 50,
    "total_tokens": 150,
    "cache_read_input_tokens": 0,
    "cache_creation_input_tokens": 0
  }
}
```

**响应（流式，stream: true）：** SSE 流，OpenAI 格式的 `data: {...}` chunks。

### `POST /v1/guide-dog/chat/completions`

轻量聊天代理，不读写记忆。请求响应格式同上。

**权限：** chat:proxy

---

## MCP 端点

### `GET /mcp`（或 `/memory-mcp`）

无需认证。返回服务器信息。

```json
{
  "name": "companion-memory-mcp",
  "transport": "streamable-http",
  "endpoint": "/mcp",
  "tools": ["memory_search", "memory_list", ...]
}
```

### `POST /mcp`

JSON-RPC 2.0 格式。

**请求：**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": { "name": "工具名", "arguments": { ... } }
}
```

**支持的 method：**
- `initialize` — 握手
- `tools/list` — 返回所有工具定义
- `tools/call` — 调用工具
- `ping` — 心跳

**响应：**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [{ "type": "text", "text": "JSON字符串" }],
    "structuredContent": { "data": ... }
  }
}
```

### MCP 工具列表

#### memory_search

| 参数 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| query | string | 是 | 搜索关键词 |
| top_k | number | 否 | 1-50 |
| types | string[] | 否 | 按类型过滤 |
| role_id | string | 否 | 角色加权 |
| role_name | string | 否 | |

#### memory_list

| 参数 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| limit | number | 否 | 1-1000，默认 100 |
| offset | number | 否 | 分页偏移 |
| type | string | 否 | 按类型过滤 |
| status | string | 否 | 默认 active |

#### memory_get

| 参数 | 类型 | 必填 |
|------|------|:----:|
| id | string | 是 |

#### memory_delete

| 参数 | 类型 | 必填 |
|------|------|:----:|
| id | string | 是 |

#### memory_upsert（实时写入原子记忆）

| 参数 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| fact_key | string | 是 | 去重键，相同 key 更新而非新建 |
| content | string | 是 | |
| type | string | 否 | fact/event/preference/relationship/boundary/habit/decision/note/world_fact，默认 fact |
| importance | number | 否 | 0-1，默认 0.6 |
| confidence | number | 否 | 0-1，默认 0.8 |
| tags | string[] | 否 | |
| source | string | 否 | 默认 mcp |
| role_id | string | 否 | |
| role_name | string | 否 | |

#### baseline_change（提交 baseline 变更 pending）

| 参数 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| op | string | 是 | add / update / delete |
| before_content | string | 条件 | update/delete 必填 |
| after_content | string | 条件 | add/update 必填 |
| reason | string | 是 | 变更理由 |
| role_id | string | 是 | baseline 必须绑角色 |
| role_name | string | 否 | |

#### memory_pin（珍贵记忆，共享）

| 参数 | 类型 | 必填 |
|------|------|:----:|
| content | string | 是 |
| context_message_ids | string[] | 否 |

#### glossary_set

| 参数 | 类型 | 必填 |
|------|------|:----:|
| term | string | 是 |
| definition | string | 是 |
| aliases | string[] | 否 |
| examples | string[] | 否 |

#### memory_recall（召回并返回可注入文本）

| 参数 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| query | string | 是 | |
| k | number | 否 | 1-100，默认 20 |
| min_score | number | 否 | 0-1，默认 0.15 |
| role_id | string | 否 | 角色加权 |
| role_name | string | 否 | |

#### memory_boot（冷启动包）

| 参数 | 类型 | 必填 |
|------|------|:----:|
| role_id | string | 否 |
| role_name | string | 否 |

#### memory_supersede

| 参数 | 类型 | 必填 |
|------|------|:----:|
| old_id | string | 是 |
| new_content | string | 是 |
| new_type | string | 否 |
| new_fact_key | string | 否 |
| reason | string | 否 |

#### memory_archive

| 参数 | 类型 | 必填 |
|------|------|:----:|
| id | string | 是 |

#### memory_export

| 参数 | 类型 | 必填 |
|------|------|:----:|
| type | string | 否 |
| format | string | 否 |

需要 memory:read + export:read 权限。

#### digest_get / digest_set

| 参数 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| content | string | set 必填 | ≤1000 字 |

#### daily_log_read

| 参数 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| date | string | 否 | YYYY-MM-DD，传则返回单条；不传返回最近列表 |
| limit | number | 否 | 1-365，默认 7（仅列表模式） |
| role_id | string | 否 | 按角色筛选 |
| role_name | string | 否 | role_id 的兜底 |

#### daily_log_write

| 参数 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| title | string | 是 | ≤12 字，已有日志时保留已有 title |
| summary | string | 否 | `- ` 开头的要点，≤800 字 |
| role_id | string | 否 | 按角色隔离 |
| role_name | string | 否 | role_id 的兜底 |

- 日期由服务端按 `DREAM_TIME_ZONE`（默认 Asia/Singapore）自动取当天，不接受客户端传入
- 当天已有日志时，新 summary 追加到已有内容之后（不覆盖），合并后上限 2000 字
- 建议在聊天结束时调用

#### memory_context（系统专用，模型不应主动调用）

无参数。被调用时返回提示信息。

---

## 记忆 CRUD

路径前缀 `/v1/memory` 和 `/v1/memories` 等效。

### `GET /v1/memory`

**权限：** memory:read

| 查询参数 | 类型 | 默认 |
|---------|------|------|
| limit | number | 100（最大 1000） |
| offset | number | 0 |
| status | string | active |
| type | string | 全部 |

**响应：**
```json
{
  "data": [{
    "id": "...", "type": "fact", "content": "...",
    "importance": 0.6, "confidence": 0.8, "status": "active",
    "pinned": false, "tags": [], "source": "mcp",
    "role_id": null, "role_name": null, "role_scope": "shared",
    "created_at": "...", "updated_at": "..."
  }],
  "paging": { "limit": 100, "cursor": "100", "has_more": true, "count": 100 }
}
```

### `POST /v1/memory`

**权限：** memory:write

```json
{
  "content": "必填",
  "fact_key": "必填（v2）",
  "type": "fact",
  "importance": 0.6,
  "confidence": 0.8,
  "tags": []
}
```

### `GET /v1/memory/:id`

### `PATCH /v1/memory/:id`

所有字段可选。

### `DELETE /v1/memory/:id`

软删除。

### `POST /v1/search/memories`

```json
{
  "query": "搜索内容",
  "top_k": 50,
  "types": ["fact"],
  "filter": true
}
```

---

## 冷启动包

### `GET /v1/memory_boot`

**权限：** memory:read

返回 digest + daily_log + precious + glossary + longtail + 今日消息 + 统计。

### `PATCH /v1/memory_boot`

**权限：** memory:write

```json
{ "content": "摘要内容（≤1000字）" }
```

---

## 珍贵记忆

### `GET /v1/precious`

### `POST /v1/precious`

```json
{ "content": "必填", "source": "human" }
```

### `DELETE /v1/precious/:id`

---

## 术语表

### `GET /v1/glossary`

### `POST /v1/glossary`

```json
{ "term": "必填", "definition": "必填", "aliases": [], "examples": [] }
```

### `PATCH /v1/glossary/:id`

### `DELETE /v1/glossary/:id`

---

## 候选审核

### `GET /v1/candidates`

| 查询参数 | 默认 |
|---------|------|
| status | pending |
| limit | 100 |

### `POST /v1/candidates/:id/approve`

可选覆盖 content、type、fact_key、confidence、importance。

### `POST /v1/candidates/:id/discard`

### `POST /v1/candidates/:id/merge`

```json
{ "target_id": "要合并到的记忆ID" }
```

### `POST /v1/candidates/:id/supersede`

```json
{ "target_id": "要替代的旧记忆ID" }
```

---

## 消息写入

### `POST /v1/ingest/messages`

```json
{
  "messages": [{ "role": "user", "content": "..." }],
  "conversation_id": "可选",
  "source": "mcp",
  "auto_extract": true
}
```

---

## KV 缓存

### `GET /v1/cache/:namespace/:key`

**权限：** cache:read

### `PUT /v1/cache/:namespace/:key`

**权限：** cache:write

```json
{
  "value": "任意值",
  "content_type": "application/json",
  "tags": [],
  "ttl_seconds": 86400
}
```

最大 256KB。

### `DELETE /v1/cache/:namespace/:key`

---

## 调试

### `GET /v1/debug/cache_health`

**权限：** debug:read

返回最近 24 小时的缓存命中率统计。

### `GET /v1/debug/vector_health`

**权限：** debug:read 或 memory:write

Vectorize 读写健康检查。

### `POST /v1/debug/vector_reindex`

**权限：** memory:write

```json
{ "limit": 50, "cursor": "...", "dry_run": true }
```

---

## 其他

### `GET /health`

无需认证。返回服务状态。

### `GET /v1/models`

返回 OpenAI 兼容的模型列表。

### `GET /admin`（或 `/memory-admin`）

无需认证。返回管理面板 HTML 页面。

### `POST /v1/memories/dream`

手动触发做梦流程。**权限：** memory:write

```json
{ "date": "2026-07-27", "force": false }
```

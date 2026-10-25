# Aelios v2 集成更新说明（阶段 1–3 + 方案 D）

> 本文是给前端/客户端维护者（Kimi / memoria）的对接说明。
> 对应后端分支：`integration/upstream-v2`（未推送）；方案文档：
> `plan/Aelios-upstream-v2-baseline-integration.md`。

## 本次后端新增了什么

1. **Gateway 固定背景**：主模型每轮自动注入当前 identity 写入空间的
   - `<long_term_baseline>`（角色长期印象）
   - `<daily_log>`（最近两个**有记录的日期**，每篇带 `date` 属性）
   - `=== 待处理变更（今日）===`（模型提交的 baseline 变更回执）
   客户端**不需要做任何事**；背景在 system/instructions 区，与动态召回的
   消息尾 patch 分开。
2. **MCP 新工具**：`baseline_change`、`daily_log_write`、`daily_log_read`
   （功能并集版，上游 `diary_get` 已从工具列表隐藏）。
3. **Dream 夜间合并**：pending baseline 变更整组原子合并，失败保留重试。

## 方案 D：MCP namespace 归属（需要前端配合的部分）

**核心变化：`baseline_change` / `daily_log_write` / `daily_log_read`（及别名
`diary_get`）不再接受 `namespace` 参数，归属由 MCP endpoint 的 URL 决定。**

| 地址 | 行为 |
|------|------|
| `/mcp/<identity>` | 强制绑定该 identity 的写入 namespace；`args.namespace` 被忽略 |
| `/mcp` 或 `/memory-mcp`（全局） | 上述四个工具直接报错，**不回退 default**；其余工具行为不变 |

错误语义：
- 未知 identity slug → HTTP 404（JSON-RPC error code -32003）
- key 不在该 identity 的 `keys` 列表 → 同上 404
- identity 配置未迁移/缺失 → HTTP 503（-32002）

### memoria 需要改什么（给 Kimi）

当前 memoria 的 MCP 是**全局单列表**（`settings.mcps`），工具按名字全局匹配
（`findMcpForTool`）。这和方案 D 不兼容：如果给每个角色各配一个
`/mcp/sol`、`/mcp/ke` 条目，两边工具同名（`daily_log_write`），只会命中
列表里第一个——另一个角色永远写不进去。

需要的三处改动：

1. **MCP 配置支持绑定角色**：`settings.mcps[]` 加一个可选字段（如
   `characterId`），或者模型条目上加 `mcpIds`。无绑定的 MCP 保持全局
   （供工具类 MCP 用）。
2. **工具匹配按当前角色路由**：`findMcpForTool` 优先在当前角色的绑定
   MCP 里找；找不到再退全局。`buildTools` 生成工具列表时同理——只暴露
   当前角色绑定的 MCP 工具 + 全局 MCP 工具。
3. **设置页 UI**：MCP 编辑行加"绑定角色"下拉（默认不绑定）。

切换角色时如果工具列表变了，注意把 `availableTools` 重建（现在它只在
render 时构建一次，角色切换不会刷新——这本来就是问题，顺手修）。

### 配置示例

角色 sol（identity slug `sol`，写入 namespace `sol`）：

```
MCP 地址: https://<aelios-host>/mcp/sol
Token:    MEMORY_MCP_API_KEY 的值（该 key 必须挂在 sol identity 的 keys 里）
```

后端 `/admin` 的 identity 配置示例（keys 含 MEMORY_MCP_API_KEY 后同一个
MCP key 可访问所有角色路由）：

```json
{
  "version": 3,
  "identities": [
    { "slug": "sol", "namespace": "sol", "keys": ["CHATBOX_API_KEY", "MEMORY_MCP_API_KEY"], "models": ["..."] },
    { "slug": "ke", "namespace": "ke", "keys": ["CHATBOX_API_KEY", "MEMORY_MCP_API_KEY"], "models": ["..."] }
  ]
}
```

### 角色卡注意事项

- 角色卡的系统提示词里如果写了工具用法，**删除所有"传 namespace 参数"的
  说明**——namespace 已经由 URL 固定，传了也会被忽略。
- 角色卡不用改工具名：`daily_log_read` / `daily_log_write` / `baseline_change`
  名称与旧分支一致。
# Claude adaptive thinking 适配记录

> 日期：2026-09-07；复核与补档：2026-09-20；本地审查：2026-10-04
> 分支：`fix/logic-review`
> 状态：本地实现、审查并通过测试，已提交、尚未推送、尚未部署

## 背景

同一 Claude 4.6 渠道直连前端时 thinking 正常，经 Aelios 后 thinking 很少或近似关闭。排查发现 Aelios 仍以旧式 `thinking.type=enabled + budget_tokens` 组装请求，默认预算仅 1024；Claude 4.6 已推荐 adaptive thinking，并用 `output_config.effort` 控制整体响应强度。

## 已实现

1. 增加 `ANTHROPIC_THINKING_MODE=auto|adaptive|manual|off`；保留 `ANTHROPIC_THINKING_ENABLED` 作为向后兼容开关（仅在新 `MODE` 未配置时生效）。
2. `auto` 对已知 Opus/Sonnet 4.6+、Fable/Mythos 5+ 和 Mythos Preview 使用 `thinking.type=adaptive`，对其他已知旧模型保留 manual budget。
3. 增加 `ANTHROPIC_THINKING_EFFORT`，并接受请求中的 `output_config.effort` / `reasoning_effort`；显式请求优先于环境默认。
4. 显式 `thinking.type=enabled|adaptive|disabled` 保持最高优先级，便于迁移和回退。
5. adaptive 模式不再为 thinking budget 额外扩大 `max_tokens`；强制 `tool_choice` 时沿用原行为，关闭 thinking，同时移除 effort。
6. README、Env 类型和专门测试同步更新。

## 2026-09-20 复核结论

OpenCode 复核认为主体逻辑没有其他阻断问题，提出三点：旧 budget 在 adaptive 下不再控制深度、自动识别只覆盖 Opus/Sonnet、此前缺少实施记录。

### 不增加 budget → effort 数值映射

官方定义中，两者不是同一维度：

- `budget_tokens`：manual thinking 的固定思考 token 上限；
- `effort`：影响正文、工具调用和 thinking 的整体行为强度，不是严格 token 预算。

官方没有提供迁移换算表，并明确说明新模型上 budget 没有直接替代项。因此不引入伪精确的阈值映射：adaptive 请求若显式提供 `output_config.effort` / `reasoning_effort` 就使用它，否则使用环境默认 `high`。旧 budget 只表达“请求开启 thinking”，不决定 adaptive effort。专门测试锁定此行为。

### 模型识别边界

当前自动识别覆盖官方已知的 Opus/Sonnet 4.6+、Fable/Mythos 5+ 和 Mythos Preview；Haiku 当前已知版本仍是 4.5 manual。自动识别只覆盖已知族，避免猜测未来型号。渠道别名或未来新模型族使用显式 `ANTHROPIC_THINKING_MODE=adaptive`。

## 尚未完成 / 不属于本次小改动

- Anthropic 工具续轮需原样保存并回传 thinking/redacted_thinking/signature 块；这是更大的会话协议状态改造，另行设计。
- 尚未用真实上游渠道做集成验证；当前仅完成请求组装单测、全量单测和类型检查。
- 尚未提交、推送或部署。推送会触发 Workers Builds，必须由用户明确确认。

## 验证

2026-10-04：

- `npx vitest run test/proxy/anthropicThinking.test.ts`：13/13 通过；
- `npx vitest run`：298/298 通过（46 个测试文件）；
- `npx tsc --noEmit`：通过。

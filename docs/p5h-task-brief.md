# P5-H 历史行为缺口扫描任务单

本任务只做审计，不实现缺口。

## 开始前阅读

1. `/home/agent/projects/AGENTS.md`
2. `/home/agent/projects/DIRECTORY.md`
3. `DEV.md`
4. `/home/agent/projects/doc/handovers/` 中最新交接
5. `/home/agent/projects/plan/Aelios-upstream-v2-baseline-integration.md`
6. `docs/p5-legacy-fix-audit.md`
7. `docs/p0-touchpoint-manifest.md`
8. `/home/agent/projects/strategies/` 中与 upstream、行为考古和迁移相关的策略卡

## 目标

P5 只审计了计划预先点名的五组旧修复。脱离既有 P5 清单，从
`fix/logic-review` 的 Git 历史、旧文档、测试和实际调用链中，系统寻找更早的缓存与召回
行为是否在 `integration/upstream-v2` 中丢失。

重点检查：

- 缓存前缀、`cache_control`、缓存断点、动态内容隔离；
- 召回查询、筛选、排序、去重、longtail、触发器、失败降级；
- 自动注入与模型主动查询的差异；
- 被重构掩盖的旧边界行为。

## 审计规则

每项必须给出旧 commit/测试证据和当前实现证据，并分类为：

- 当前仍保留；
- 上游新架构替代；
- P0–P6 已覆盖；
- 当前确实丢失；
- 无法确认，需要实验。

以用户可观察行为和数据语义为单位，不以文件名是否存在判断。不要为了复刻旧代码而复刻
已经消失的旧架构。对真实缺口只拆独立实现包，标明依赖、触点、最低必要测试和优先级，
并与 P5-A～G 去重；本轮严禁实现。

## 写入范围

- 唯一业务产物：`docs/p5h-historical-behavior-gap-audit.md`
- 必要时可以更新总计划的 P5-H 状态和执行者自己的 `doc/handovers/` 文件。
- 不得修改业务代码、迁移、测试、`DEV.md` 或共享 handover。
- 不得提交、推送或切分支。

禁止读取或输出凭证、环境变量、`.env`、`wrangler.toml`、`.cc-connect`、SSH/cloud/browser
数据或线上记忆正文。

## 最终报告

- 扫描的历史范围；
- 各分类数量；
- 新发现的真实缺口及优先级；
- 是否影响 P5-B、P5-C、P7、P8 的实施顺序；
- 无法确认的项目及所需实验。

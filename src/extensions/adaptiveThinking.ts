import type { Env } from "../types";

// =====================================================================
// P6 · Anthropic adaptive thinking（策略决策模块，纯逻辑）
// =====================================================================
// 源头：旧分支 fix/logic-review 540f0c8「feat: support adaptive Anthropic thinking」，
// 审查记录见工作区 plan/2026-09-07-Claude-adaptive-thinking适配.md（复核 2026-09-20）。
// 本模块只做决策：模型能力识别 + manual/adaptive 模式选择 + effort/budget 解析；
// 请求体改写由本模块的 applyThinkingPlan 执行，入口只有 gateway/protocol.ts 的
// applyThinkingPolicy 一处调用（prepareGatewayRequest，主模型限定）。
//
// 与旧实现的两处架构性差异（行为语义不变）：
// 1. 旧分支把 OpenAI 兼容请求转成 Anthropic wire（converter），thinking 全靠服务端组装；
//    新分支 messages 协议是透传网关，客户端自己就能带 thinking/output_config——
//    显式请求优先级因此映射为"客户端已带合法 thinking 时尊重原值，只在缺省处补全"。
// 2. 旧分支会把客户端 effort 拼写（minimal/extra_high/auto）归一成 Anthropic 枚举；
//    新入口是原生 Anthropic wire，没有这些别名，无效 effort 交给合同校验报错，不代为收编。
//
// budget→effort 不做数值换算：这是旧分支复核后的明确裁定（官方无换算表，budget 只表达
// "要思考"，effort 由显式请求或环境默认决定），测试钉死此行为。

export type ThinkingEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type ThinkingMode = "auto" | "adaptive" | "manual" | "off";

/** 决策所需的请求字段（messages 协议顶层）。 */
export interface ThinkingBody {
  model?: unknown;
  thinking?: Record<string, unknown>;
  output_config?: Record<string, unknown>;
  tool_choice?: Record<string, unknown>;
  max_tokens?: unknown;
  temperature?: unknown;
  [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Anthropic provider 前缀剥离后按已知模型族识别 adaptive 能力（旧分支逐字移植）。 */
export function supportsAdaptiveThinking(model: string): boolean {
  const normalized = model.replace(/^anthropic\//i, "").toLowerCase();
  if (/claude-(?:opus|sonnet)-(?:4-(?:[6-9]|\d{2,})|[5-9](?:-|$))/.test(normalized)) {
    return true;
  }
  return /claude-(?:fable|mythos)-(?:preview|[5-9](?:-|$))/.test(normalized);
}

/** effort 解析（旧分支逐字移植，含 OpenAI 兼容别名归一，供环境变量使用）。 */
export function parseThinkingEffort(value: unknown): ThinkingEffort | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "minimal") return "low";
  if (normalized === "extra_high") return "xhigh";
  if (normalized === "auto") return "high";
  if (["low", "medium", "high", "xhigh", "max"].includes(normalized)) {
    return normalized as ThinkingEffort;
  }
  return null;
}

function clampThinkingBudget(value: unknown): number | null {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(numeric)) return null;
  return Math.min(Math.max(Math.floor(numeric), 1024), 32000);
}

/** manual 预算：ANTHROPIC_THINKING_BUDGET（1024–32000），默认 1024（旧分支同款）。 */
export function manualThinkingBudget(env: Env): number {
  return clampThinkingBudget(env.ANTHROPIC_THINKING_BUDGET) ?? 1024;
}

/** 模式解析（旧分支 getConfiguredThinkingMode 逐字移植；MODE 未填返回 auto 但旧开关另把关）。 */
export function resolveThinkingMode(env: Env): ThinkingMode {
  const mode = env.ANTHROPIC_THINKING_MODE?.trim().toLowerCase();
  if (mode === "manual" || mode === "enabled") return "manual";
  if (mode === "adaptive") return "adaptive";
  if (mode === "off" || mode === "disabled" || mode === "none") return "off";
  return "auto";
}

/** messages 协议原生 tool_choice 的"强制工具调用"判定（旧 isForcedToolChoice 的 Anthropic wire 版）。 */
function isForcedToolChoice(toolChoice: ThinkingBody["tool_choice"]): boolean {
  return toolChoice?.type === "any" || toolChoice?.type === "tool";
}

export type ThinkingPlan =
  | { action: "passthrough" }
  | { action: "drop" }
  | { action: "adaptive"; effort: ThinkingEffort; inject: boolean; fillEffort: boolean }
  | { action: "manual"; budgetTokens: number; inject: boolean; fillBudget: boolean };

/**
 * 决策树（优先级自上而下，对应旧 buildThinkingConfig）：
 * 1. 客户端 thinking / output_config 非法形状 → passthrough（合同校验负责报错，不代为收编）；
 * 2. 显式 disabled → passthrough（无思考，策略不动）；
 * 3. 显式 adaptive → 强制工具调用时 drop；否则 effort 缺省才补（客户端值优先）；
 * 4. 显式 enabled（manual）→ 强制工具调用时 drop；budget 缺省才补（迁移期兼容）；
 * 5. 客户端没带 thinking → 按 ANTHROPIC_THINKING_MODE / 旧开关 ANTHROPIC_THINKING_ENABLED
 *    决定是否注入：auto 按模型能力选 adaptive/manual，adaptive/manual 全局指定，off 不注入。
 */
export function planThinkingPolicy(env: Env, body: ThinkingBody): ThinkingPlan {
  const thinking = body.thinking;
  if (thinking !== undefined && (!isRecord(thinking) ||
    !["enabled", "adaptive", "disabled"].includes(String(thinking.type)))) {
    return { action: "passthrough" };
  }
  // 非法 output_config 形状（非 null/undefined 的非普通对象）不代为收编：整单透传，
  // 交给 validateRequest 的 "output_config: Expected an object." 报错。
  // 否则 applyThinkingPlan 的对象展开会把字符串/数组改写成索引对象，绕过合同校验。
  if (body.output_config != null && !isRecord(body.output_config)) {
    return { action: "passthrough" };
  }
  const explicitType = isRecord(thinking) ? (thinking.type as string | undefined) : undefined;
  if (explicitType === "disabled") return { action: "passthrough" };

  const forced = isForcedToolChoice(body.tool_choice);
  const clientHasEffort = isRecord(body.output_config) && body.output_config.effort != null;
  const fallbackEffort = parseThinkingEffort(env.ANTHROPIC_THINKING_EFFORT) ?? "high";

  if (explicitType === "adaptive") {
    if (forced) return { action: "drop" };
    return { action: "adaptive", effort: fallbackEffort, inject: false, fillEffort: !clientHasEffort };
  }

  const budgetTokens = manualThinkingBudget(env);

  if (explicitType === "enabled") {
    if (forced) return { action: "drop" };
    if (!isRecord(thinking) || thinking.budget_tokens == null) {
      return { action: "manual", budgetTokens, inject: false, fillBudget: true };
    }
    return { action: "passthrough" };
  }

  // 客户端没带 thinking：按配置注入。默认全不配 = 不注入（保持透传现状）。
  const mode = resolveThinkingMode(env);
  if (mode === "off") return { action: "passthrough" };
  // 旧开关把关（旧分支原语义）：MODE 未填时必须 ANTHROPIC_THINKING_ENABLED=true 才注入。
  if (env.ANTHROPIC_THINKING_ENABLED !== "true" && env.ANTHROPIC_THINKING_MODE === undefined) {
    return { action: "passthrough" };
  }
  if (forced) return { action: "passthrough" };
  // cache 预热探测（max_tokens=0）没有输出，注入 thinking 只会让合同校验挂掉。
  if (body.max_tokens === 0) return { action: "passthrough" };

  if (mode === "adaptive" || (mode === "auto" && supportsAdaptiveThinking(typeof body.model === "string" ? body.model : ""))) {
    return { action: "adaptive", effort: fallbackEffort, inject: true, fillEffort: !clientHasEffort };
  }
  return { action: "manual", budgetTokens, inject: true, fillBudget: false };
}

/**
 * 执行决策，改写请求体（messages 协议顶层）：
 * - drop：删 thinking，并把随行 effort 摘掉（格式配置保留）——对应旧分支"强制工具调用关 thinking"；
 * - adaptive：注入 {type:"adaptive", display:"summarized"}，effort 缺省时补 output_config.effort；
 * - manual：注入/补全 budget_tokens，并按旧 getAnthropicMaxTokens 扩 max_tokens 保证 budget < max_tokens；
 * - thinking 生效时删 temperature（旧分支同款：思考与 temperature 互斥）。
 */
export function applyThinkingPlan(body: ThinkingBody, plan: ThinkingPlan): void {
  if (plan.action === "drop") {
    delete body.thinking;
    if (isRecord(body.output_config)) {
      delete body.output_config.effort;
      if (Object.keys(body.output_config).length === 0) delete body.output_config;
    }
    return;
  }
  if (plan.action === "adaptive") {
    if (plan.inject) body.thinking = { type: "adaptive", display: "summarized" };
    if (plan.fillEffort) {
      body.output_config = { ...body.output_config, effort: plan.effort };
    }
  } else if (plan.action === "manual") {
    if (plan.inject) body.thinking = { type: "enabled", budget_tokens: plan.budgetTokens, display: "summarized" };
    else if (plan.fillBudget && isRecord(body.thinking)) body.thinking.budget_tokens = plan.budgetTokens;
    expandMaxTokensForBudget(body, plan.budgetTokens);
  }
  if (isRecord(body.thinking) && body.thinking.type !== "disabled") {
    delete body.temperature;
  }
}

/** 旧 getAnthropicMaxTokens 移植：manual 预算必须小于 max_tokens，不够就扩。 */
function expandMaxTokensForBudget(body: ThinkingBody, budgetTokens: number): void {
  const raw = body.max_tokens;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 1) return;
  const maxTokens = Math.max(Math.floor(raw), 1);
  body.max_tokens = Math.max(maxTokens, budgetTokens + Math.min(Math.max(maxTokens, 256), 4096));
}
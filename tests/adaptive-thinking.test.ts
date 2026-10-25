import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  applyThinkingPlan,
  manualThinkingBudget,
  parseThinkingEffort,
  planThinkingPolicy,
  resolveThinkingMode,
  supportsAdaptiveThinking,
  type ThinkingBody,
  type ThinkingPlan,
} from "../src/extensions/adaptiveThinking";
import { applyThinkingPolicy } from "../src/gateway/protocol";
import { prepareGatewayRequest } from "../src/gateway/upstream";
import type { Env } from "../src/types";

// P6 · Adaptive thinking 移植验收。行为对照旧分支 fix/logic-review 540f0c8 的
// test/proxy/anthropicThinking.test.ts（13 用例），按新架构（messages 协议透传 + 策略接缝）
// 重新落位；4.5 manual budget / 4.6+ adaptive 两条路径与"不做 budget→effort 换算"
// 的旧裁定都在这里钉死。

const baseEnv = {} as Env;

function body(overrides: Record<string, unknown> = {}): ThinkingBody {
  return {
    model: "claude-opus-4-6",
    messages: [{ role: "user", content: "hello" }],
    max_tokens: 4096,
    ...overrides,
  };
}

function identity(extra: Record<string, unknown> = {}) {
  return { slug: "partner", keys: ["CHATBOX_API_KEY"], models: ["partner"], ...extra } as any;
}

function runPlan(env: Env, b: Record<string, unknown>): { body: ThinkingBody; plan: ThinkingPlan } {
  const plan = planThinkingPolicy(env, b as ThinkingBody);
  applyThinkingPlan(b as ThinkingBody, plan);
  return { body: b as ThinkingBody, plan };
}

// ---------------------------------------------------------------------------
// 模型识别（旧 supportsAdaptiveThinking 逐字移植）
// ---------------------------------------------------------------------------

test("model recognition covers known adaptive families and keeps 4.5 manual", () => {
  assert.equal(supportsAdaptiveThinking("claude-opus-4-6"), true);
  assert.equal(supportsAdaptiveThinking("claude-sonnet-4-6-20261001"), true);
  assert.equal(supportsAdaptiveThinking("claude-opus-4-10"), true);
  assert.equal(supportsAdaptiveThinking("claude-sonnet-5"), true);
  assert.equal(supportsAdaptiveThinking("anthropic/claude-opus-4-6"), true, "provider 前缀剥离");
  assert.equal(supportsAdaptiveThinking("claude-fable-5-1"), true);
  assert.equal(supportsAdaptiveThinking("claude-mythos-5"), true);
  assert.equal(supportsAdaptiveThinking("claude-mythos-preview"), true);
  assert.equal(supportsAdaptiveThinking("claude-opus-4-5-20251101"), false, "4.5 仍是 manual");
  assert.equal(supportsAdaptiveThinking("claude-haiku-4-5"), false, "Haiku 已知版本仍 manual");
  assert.equal(supportsAdaptiveThinking("some-other-model"), false);
});

test("effort parsing keeps the reviewed aliases and falls back to high", () => {
  assert.equal(parseThinkingEffort("minimal"), "low");
  assert.equal(parseThinkingEffort("extra_high"), "xhigh");
  assert.equal(parseThinkingEffort("auto"), "high");
  assert.equal(parseThinkingEffort("Max"), "max");
  assert.equal(parseThinkingEffort("bogus"), null);
  assert.equal(parseThinkingEffort(42), null);
  assert.equal(manualThinkingBudget(baseEnv), 1024, "默认预算");
  assert.equal(manualThinkingBudget({ ANTHROPIC_THINKING_BUDGET: "32000" } as Env), 32000);
  assert.equal(manualThinkingBudget({ ANTHROPIC_THINKING_BUDGET: "10" } as Env), 1024, "越界收敛回下限");
  assert.equal(resolveThinkingMode({ ANTHROPIC_THINKING_MODE: "enabled" } as Env), "manual", "enabled 视为 manual");
  assert.equal(resolveThinkingMode({ ANTHROPIC_THINKING_MODE: "none" } as Env), "off");
  assert.equal(resolveThinkingMode(baseEnv), "auto", "未配置按 auto，由旧开关把关");
});

// ---------------------------------------------------------------------------
// 路径一：客户端没带 thinking，配置注入（旧 buildThinkingConfig 主干）
// ---------------------------------------------------------------------------

test("legacy enabled flag turns on adaptive thinking for Claude 4.6", () => {
  const { plan } = runPlan({ ANTHROPIC_THINKING_ENABLED: "true" } as Env, body());
  assert.equal(plan.action, "adaptive");
  assert.equal(plan.inject, true);
});

test("legacy enabled flag keeps manual budget for Claude 4.5", () => {
  const { body: out, plan } = runPlan(
    { ANTHROPIC_THINKING_ENABLED: "true", ANTHROPIC_THINKING_BUDGET: "4096" } as Env,
    body({ model: "claude-opus-4-5-20251101" })
  );
  assert.equal(plan.action, "manual");
  assert.deepEqual(out.thinking, { type: "enabled", budget_tokens: 4096, display: "summarized" });
  assert.ok(out.max_tokens as number > 4096, "max_tokens 扩到预算之上");
});

test("ANTHROPIC_THINKING_MODE=auto picks adaptive for the adaptive-only families", () => {
  for (const model of ["claude-fable-5-1", "claude-mythos-5", "claude-mythos-preview"]) {
    const { plan } = runPlan({ ANTHROPIC_THINKING_MODE: "auto" } as Env, body({ model }));
    assert.equal(plan.action, "adaptive");
  }
  const legacy = runPlan({ ANTHROPIC_THINKING_MODE: "auto" } as Env, body({ model: "claude-opus-4-5" }));
  assert.equal(legacy.plan.action, "manual", "auto 对旧模型回落 manual budget");
});

test("the legacy flag only applies when the new mode is not configured", () => {
  const off = planThinkingPolicy({ ANTHROPIC_THINKING_ENABLED: "false" } as Env, body());
  assert.equal(off.action, "passthrough");
  const onViaMode = planThinkingPolicy(
    { ANTHROPIC_THINKING_ENABLED: "false", ANTHROPIC_THINKING_MODE: "auto" } as Env, body());
  assert.equal(onViaMode.action, "adaptive", "MODE 优先于旧开关");
  const explicitOff = planThinkingPolicy(
    { ANTHROPIC_THINKING_ENABLED: "true", ANTHROPIC_THINKING_MODE: "off" } as Env, body());
  assert.equal(explicitOff.action, "passthrough", "off 关掉旧开关");
});

test("with nothing configured the request is untouched", () => {
  const before = body();
  const snapshot = JSON.stringify(before);
  const { plan } = runPlan(baseEnv, before);
  assert.equal(plan.action, "passthrough");
  assert.equal(JSON.stringify(before), snapshot, "逐字节不变");
});

test("mode manual injects the configured budget and expands max_tokens", () => {
  const { body: out } = runPlan(
    { ANTHROPIC_THINKING_MODE: "manual", ANTHROPIC_THINKING_BUDGET: "32000" } as Env,
    body({ max_tokens: 2000 })
  );
  assert.deepEqual(out.thinking, { type: "enabled", budget_tokens: 32000, display: "summarized" });
  assert.equal(out.max_tokens, 34000, "32000 + min(max(2000,256),4096)");
  assert.ok((out.max_tokens as number) > 32000, "budget < max_tokens 合同成立");
  assert.equal(out.output_config, undefined, "manual 不带 effort");
});

test("cache-warming probes (max_tokens=0) are not injected", () => {
  const { plan } = runPlan({ ANTHROPIC_THINKING_MODE: "adaptive" } as Env, body({ max_tokens: 0 }));
  assert.equal(plan.action, "passthrough");
});

// ---------------------------------------------------------------------------
// 路径二：客户端显式 thinking（透传优先级，旧显式语义）
// ---------------------------------------------------------------------------

test("explicit disabled thinking wins over the environment default", () => {
  const b = body({ thinking: { type: "disabled" }, temperature: 0.7 });
  const { plan } = runPlan({ ANTHROPIC_THINKING_MODE: "adaptive" } as Env, b);
  assert.equal(plan.action, "passthrough");
  assert.deepEqual(b.thinking, { type: "disabled" });
  assert.equal(b.temperature, 0.7, "disabled 无思考，temperature 不动");
});

test("explicit adaptive thinking is kept and gets a default high effort", () => {
  const { body: out, plan } = runPlan({ ANTHROPIC_THINKING_MODE: "off" } as Env,
    body({ thinking: { type: "adaptive" } }));
  assert.equal(plan.action, "adaptive");
  assert.equal(plan.inject, false);
  assert.deepEqual(out.thinking, { type: "adaptive" });
  assert.deepEqual(out.output_config, { effort: "high" }, "effort 缺省补默认");
});

test("client effort is not replaced by the environment default", () => {
  const { body: out } = runPlan(
    { ANTHROPIC_THINKING_MODE: "adaptive", ANTHROPIC_THINKING_EFFORT: "medium" } as Env,
    body({ thinking: { type: "adaptive" }, output_config: { effort: "low" } })
  );
  assert.deepEqual(out.output_config, { effort: "low" });
});

test("injected adaptive thinking keeps the client-provided effort over the env default", () => {
  // 旧分支对应用例："uses explicit reasoning_effort instead of a legacy budget on adaptive
  // models"——注入路径同样不许用环境值覆盖客户端 effort。
  const { body: out, plan } = runPlan(
    { ANTHROPIC_THINKING_MODE: "auto", ANTHROPIC_THINKING_EFFORT: "high", ANTHROPIC_THINKING_BUDGET: "32000" } as Env,
    body({ thinking: undefined, output_config: { effort: "low" } })
  );
  assert.equal(plan.action, "adaptive");
  assert.equal(plan.inject, true);
  assert.deepEqual(out.thinking, { type: "adaptive", display: "summarized" });
  assert.deepEqual(out.output_config, { effort: "low" }, "客户端 effort 原样保留");
});

test("explicit manual thinking is kept on Claude 4.6 during migration", () => {
  const b = body({ thinking: { type: "enabled", budget_tokens: 8192 }, temperature: 0.7 });
  const { plan } = runPlan({ ANTHROPIC_THINKING_ENABLED: "true" } as Env, b);
  assert.equal(plan.action, "passthrough", "客户端自带预算，不再注入 adaptive");
  assert.deepEqual(b.thinking, { type: "enabled", budget_tokens: 8192 });
  assert.equal(b.temperature, undefined, "thinking 生效时删 temperature（旧分支同款）");
});

test("explicit manual thinking without a budget is filled from settings", () => {
  const { body: out, plan } = runPlan({ ANTHROPIC_THINKING_BUDGET: "4096" } as Env,
    body({ thinking: { type: "enabled" }, max_tokens: 1024 }));
  assert.equal(plan.action, "manual");
  assert.deepEqual(out.thinking, { type: "enabled", budget_tokens: 4096 });
  assert.equal(out.max_tokens, 5120, "4096 + min(max(1024,256),4096)=5120，预算 < max_tokens 成立");
});

test("invalid client thinking shapes reach validation untouched", () => {
  const b = body({ thinking: { type: "weird" } });
  const snapshot = JSON.stringify(b);
  const { plan } = runPlan({ ANTHROPIC_THINKING_MODE: "adaptive" } as Env, b);
  assert.equal(plan.action, "passthrough");
  assert.equal(JSON.stringify(b), snapshot, "不代为收编成 adaptive");
});

// ---------------------------------------------------------------------------
// budget→effort 映射：旧复核明确裁定不换算，这里钉死
// ---------------------------------------------------------------------------

test("no budget-to-effort conversion is invented for adaptive requests", () => {
  // 注入路径：legacy budget 32000 不影响 effort，effort 只认环境/默认
  const injected = runPlan(
    { ANTHROPIC_THINKING_MODE: "adaptive", ANTHROPIC_THINKING_BUDGET: "32000", ANTHROPIC_THINKING_EFFORT: "medium" } as Env,
    body()
  );
  assert.equal(injected.plan.action, "adaptive");
  assert.deepEqual(injected.body.output_config, { effort: "medium" }, "budget 数值不进 effort");
  // 显式 manual 路径：budget 32000 保持 manual，永不带 effort
  const manual = runPlan(
    { ANTHROPIC_THINKING_ENABLED: "true" } as Env,
    body({ thinking: { type: "enabled", budget_tokens: 32000 } })
  );
  assert.equal(manual.plan.action, "passthrough");
  assert.equal(manual.body.output_config, undefined);
  // 环境没配 effort 时默认 high，而不是从 budget 推导
  const defaulted = runPlan({ ANTHROPIC_THINKING_MODE: "adaptive" } as Env, body());
  assert.deepEqual(defaulted.body.output_config, { effort: "high" });
});

// ---------------------------------------------------------------------------
// 非法 output_config 形状：不代为收编，交给合同校验报错
// （复核阻塞项：对象展开曾把 "bad" 改写成 {"0":"b","1":"a","2":"d","effort":"high"}，
//  绕过 validateRequest 的 "output_config: Expected an object."）
// ---------------------------------------------------------------------------

test("a string output_config is not spread into an indexed object", () => {
  const b = body({ thinking: { type: "adaptive" }, output_config: "bad" });
  const snapshot = JSON.stringify(b);
  const { plan } = runPlan({ ANTHROPIC_THINKING_MODE: "adaptive" } as Env, b);
  assert.equal(plan.action, "passthrough");
  assert.equal(JSON.stringify(b), snapshot, "字符串原样保留，不展开不注入");
});

test("an array output_config is left untouched for validation to reject", () => {
  const b = body({ output_config: ["x", "y"] });
  const snapshot = JSON.stringify(b);
  const { plan } = runPlan({ ANTHROPIC_THINKING_ENABLED: "true" } as Env, b);
  assert.equal(plan.action, "passthrough");
  assert.equal(JSON.stringify(b), snapshot, "数组原样保留，不展开不注入");
});

test("valid output_config shapes still fill or keep effort as before", () => {
  // 合法对象缺 effort：照常补默认（null/undefined 同样当缺省处理）
  for (const absent of [undefined, null]) {
    const { body: out } = runPlan({ ANTHROPIC_THINKING_MODE: "adaptive" } as Env,
      body({ thinking: { type: "adaptive" }, output_config: absent }));
    assert.deepEqual(out.output_config, { effort: "high" });
  }
  // 合法对象已有 effort：不覆盖
  const kept = runPlan({ ANTHROPIC_THINKING_MODE: "adaptive", ANTHROPIC_THINKING_EFFORT: "high" } as Env,
    body({ thinking: { type: "adaptive" }, output_config: { effort: "low", format: { type: "json_schema", schema: {} } } }));
  assert.deepEqual(kept.body.output_config, { effort: "low", format: { type: "json_schema", schema: {} } });
});

// ---------------------------------------------------------------------------
// 强制工具调用（旧分支：thinking 与 forced tool_choice 互斥，策略主动摘除）
// ---------------------------------------------------------------------------

test("forced tool choice drops thinking and its effort, keeping other output config", () => {
  const b = body({
    thinking: { type: "adaptive" },
    output_config: { effort: "low", format: { type: "json_schema", schema: {} } },
    tool_choice: { type: "any" },
  });
  const { plan } = runPlan({ ANTHROPIC_THINKING_MODE: "adaptive" } as Env, b);
  assert.equal(plan.action, "drop");
  assert.equal(b.thinking, undefined);
  assert.deepEqual(b.output_config, { format: { type: "json_schema", schema: {} } }, "format 保留，effort 摘除");
});

test("forced tool choice prevents injection entirely", () => {
  const plan = planThinkingPolicy({ ANTHROPIC_THINKING_MODE: "adaptive" } as Env,
    body({ tool_choice: { type: "tool", name: "lookup" } }) as ThinkingBody);
  assert.equal(plan.action, "passthrough");
});

// ---------------------------------------------------------------------------
// 接缝：applyThinkingPolicy（唯一入口）与 prepareGatewayRequest 集成
// ---------------------------------------------------------------------------

test("applyThinkingPolicy without env stays byte-identical for existing callers", () => {
  const b = body({ thinking: { type: "enabled", budget_tokens: 1024 } });
  const snapshot = JSON.stringify(b);
  applyThinkingPolicy(b, identity(), "messages", new Headers());
  assert.equal(JSON.stringify(b), snapshot);
});

test("applyThinkingPolicy runs the plan, then the drop_block binding still stamps injected thinking", () => {
  const b = body({ model: "claude-opus-4-6", max_tokens: 1024 });
  const headers = new Headers();
  applyThinkingPolicy(b, identity({ anthropicThinking: "drop_block", models: ["claude-*"] }), "messages", headers,
    { ANTHROPIC_THINKING_MODE: "auto" } as Env);
  const stamped = b.thinking as { type: string; display: string; block_binding: { prefix_mismatch_behavior: string } };
  assert.equal(stamped.type, "adaptive");
  assert.equal(stamped.display, "summarized");
  assert.deepEqual(b.output_config, { effort: "high" });
  assert.equal(stamped.block_binding.prefix_mismatch_behavior, "drop_block", "策略注入后再打绑定标记");
  assert.ok((headers.get("anthropic-beta") ?? "").includes("thinking-binding-controls-2026-08-01"));
  assert.equal(b.temperature, undefined);
});

test("prepareGatewayRequest injects adaptive thinking for a routed main model", () => {
  const env = {
    CLOUDFLARE_API_TOKEN: "token",
    ANTHROPIC_THINKING_ENABLED: "true",
  } as Env;
  const config = {
    version: 3,
    upstream: { address: "a".repeat(32) },
    identities: [identity({ models: ["anthropic/claude-*"] })],
  } as any;
  const request = new Request("https://gw.test/partner/v1/messages", { method: "POST" });
  const prepared = prepareGatewayRequest(env, config, config.identities[0], "messages", request,
    body({ model: "anthropic/claude-sonnet-4-6" }) as any);
  // BYOK 路由剥掉 provider 前缀，模型识别用的是路由后的原生名
  assert.equal(prepared.body.model, "claude-sonnet-4-6");
  assert.equal(prepared.body.thinking.type, "adaptive");
  assert.deepEqual(prepared.body.output_config, { effort: "high" });
  assert.equal(prepared.removed.length, 0, "注入字段都在合同白名单内，不会被 normalize 剥掉");
});

test("prepareGatewayRequest keeps manual budget for Claude 4.5 under the legacy flag", () => {
  const env = {
    CLOUDFLARE_API_TOKEN: "token",
    ANTHROPIC_THINKING_ENABLED: "true",
    ANTHROPIC_THINKING_BUDGET: "4096",
  } as Env;
  const config = {
    version: 3,
    upstream: { address: "a".repeat(32) },
    identities: [identity({ models: ["anthropic/claude-*"] })],
  } as any;
  const request = new Request("https://gw.test/partner/v1/messages", { method: "POST" });
  const prepared = prepareGatewayRequest(env, config, config.identities[0], "messages", request,
    body({ model: "anthropic/claude-opus-4-5-20251101", max_tokens: 2048 }) as any);
  assert.deepEqual(prepared.body.thinking, { type: "enabled", budget_tokens: 4096, display: "summarized" });
  assert.ok((prepared.body.max_tokens as number) > 4096, "预算 < max_tokens");
  assert.equal(prepared.body.output_config, undefined);
});

test("non-main models pass through without thinking injection", () => {
  const env = {
    CLOUDFLARE_API_TOKEN: "token",
    ANTHROPIC_THINKING_MODE: "adaptive",
  } as Env;
  const config = {
    version: 3,
    upstream: { address: "a".repeat(32) },
    identities: [identity({ models: ["partner"] })],
  } as any;
  const request = new Request("https://gw.test/partner/v1/messages", { method: "POST" });
  const b = body({ model: "anthropic/claude-opus-4-6" });
  const snapshot = JSON.stringify({ thinking: b.thinking, output_config: b.output_config });
  const prepared = prepareGatewayRequest(env, config, config.identities[0], "messages", request, b as any);
  assert.equal(JSON.stringify({ thinking: prepared.body.thinking, output_config: prepared.body.output_config }), snapshot,
    "非主模型不注入");
});

test("prepareGatewayRequest still reports the output_config contract error for invalid shapes", () => {
  const env = {
    CLOUDFLARE_API_TOKEN: "token",
    ANTHROPIC_THINKING_MODE: "adaptive",
  } as Env;
  const config = {
    version: 3,
    upstream: { address: "a".repeat(32) },
    identities: [identity({ models: ["anthropic/claude-*"] })],
  } as any;
  for (const output_config of ["bad", ["x"]]) {
    const request = new Request("https://gw.test/partner/v1/messages", { method: "POST" });
    const b = body({ model: "anthropic/claude-sonnet-4-6", output_config });
    assert.throws(
      () => prepareGatewayRequest(env, config, config.identities[0], "messages", request, b as any),
      /output_config/,
      "合同校验的形状错误必须原样到达调用方，不被策略改写成可过审的形状"
    );
  }
});
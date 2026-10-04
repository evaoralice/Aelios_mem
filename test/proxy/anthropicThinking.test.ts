import { describe, expect, it } from "vitest";
import type { AssembledPrompt } from "../../src/assembler/types";
import {
  buildAnthropicRequestFromAssembled,
  buildThinkingConfig,
} from "../../src/proxy/anthropicAdapter";
import type { Env, OpenAIChatRequest } from "../../src/types";

function request(overrides: Record<string, unknown> = {}): OpenAIChatRequest {
  return {
    model: "companion",
    messages: [{ role: "user", content: "hello" }],
    max_tokens: 4096,
    ...overrides,
  };
}

function assembled(): AssembledPrompt {
  return {
    system_blocks: [],
    messages: [{ role: "user", content: "hello" }],
    meta: {
      anchor_index: -1,
      block_ids: [],
      client_system_hash: "none",
      cache_breakpoints: [],
    },
  };
}

describe("Anthropic thinking mode selection", () => {
  it("uses adaptive thinking for Claude 4.6 when the legacy enabled flag is on", () => {
    const thinking = buildThinkingConfig(
      { ANTHROPIC_THINKING_ENABLED: "true" } as Env,
      request(),
      "claude-sonnet-4-6",
    );

    expect(thinking).toEqual({ type: "adaptive", display: "summarized" });
  });

  it("keeps manual thinking for Claude 4.5", () => {
    const thinking = buildThinkingConfig(
      {
        ANTHROPIC_THINKING_ENABLED: "true",
        ANTHROPIC_THINKING_BUDGET: "4096",
      } as Env,
      request(),
      "claude-opus-4-5-20251101",
    );

    expect(thinking).toEqual({
      type: "enabled",
      budget_tokens: 4096,
      display: "summarized",
    });
  });

  it.each(["claude-fable-5-1", "claude-mythos-5", "claude-mythos-preview"])(
    "uses adaptive thinking for the current adaptive-only family %s",
    (model) => {
      const thinking = buildThinkingConfig(
        { ANTHROPIC_THINKING_MODE: "auto" } as Env,
        request(),
        model,
      );

      expect(thinking).toEqual({ type: "adaptive", display: "summarized" });
    },
  );

  it("uses the legacy enabled flag only when the new mode is not configured", () => {
    expect(
      buildThinkingConfig(
        { ANTHROPIC_THINKING_ENABLED: "false" } as Env,
        request(),
        "claude-opus-4-6",
      ),
    ).toBeUndefined();

    expect(
      buildThinkingConfig(
        {
          ANTHROPIC_THINKING_ENABLED: "false",
          ANTHROPIC_THINKING_MODE: "auto",
        } as Env,
        request(),
        "claude-opus-4-6",
      ),
    ).toEqual({ type: "adaptive", display: "summarized" });
  });

  it("honors an explicit disabled request over the environment default", () => {
    const thinking = buildThinkingConfig(
      { ANTHROPIC_THINKING_ENABLED: "true" } as Env,
      request({ thinking: { type: "disabled" } }),
      "claude-opus-4-6",
    );

    expect(thinking).toBeUndefined();
  });

  it("keeps an explicit thinking type above merged generic disable hints", () => {
    const thinking = buildThinkingConfig(
      { ANTHROPIC_THINKING_MODE: "off" } as Env,
      request({
        thinking: { type: "adaptive" },
        reasoning_effort: "none",
        enable_thinking: false,
      }),
      "claude-opus-4-6",
    );

    expect(thinking).toEqual({ type: "adaptive", display: "summarized" });
  });

  it("allows an explicit manual request on Claude 4.6 during migration", () => {
    const thinking = buildThinkingConfig(
      { ANTHROPIC_THINKING_ENABLED: "true" } as Env,
      request({ thinking: { type: "enabled", budget_tokens: 8192 } }),
      "claude-opus-4-6",
    );

    expect(thinking).toEqual({
      type: "enabled",
      budget_tokens: 8192,
      display: "summarized",
    });
  });

  it("adds high effort to adaptive requests by default", () => {
    const built = buildAnthropicRequestFromAssembled(
      request(),
      "claude-opus-4-6",
      assembled(),
      { ANTHROPIC_THINKING_MODE: "auto" } as Env,
    );

    expect(built.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(built.output_config).toEqual({ effort: "high" });
  });

  it("does not invent a budget_tokens to adaptive effort conversion", () => {
    const built = buildAnthropicRequestFromAssembled(
      request({ thinking_budget: 1024 }),
      "claude-opus-4-6",
      assembled(),
      { ANTHROPIC_THINKING_MODE: "auto", ANTHROPIC_THINKING_EFFORT: "medium" } as Env,
    );

    expect(built.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(built.output_config).toEqual({ effort: "medium" });
  });

  it("uses explicit reasoning_effort instead of a legacy budget on adaptive models", () => {
    const built = buildAnthropicRequestFromAssembled(
      request({ thinking_budget: 32000, reasoning_effort: "low" }),
      "claude-sonnet-4-6",
      assembled(),
      { ANTHROPIC_THINKING_MODE: "auto", ANTHROPIC_THINKING_EFFORT: "high" } as Env,
    );

    expect(built.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(built.output_config).toEqual({ effort: "low" });
  });

  it("removes adaptive thinking and effort for forced tool choice", () => {
    const built = buildAnthropicRequestFromAssembled(
      request({
        tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
        tool_choice: { type: "function", function: { name: "lookup" } },
      }),
      "claude-opus-4-6",
      assembled(),
      { ANTHROPIC_THINKING_MODE: "auto" } as Env,
    );

    expect(built.thinking).toBeUndefined();
    expect(built.output_config).toBeUndefined();
  });
});

import { describe, it, expect } from "vitest";
import { assembledToAnthropicMessages } from "../../src/assembler/toAnthropic";
import type { AssembledPrompt } from "../../src/assembler/types";
import type { AnthropicToolUseBlock, AnthropicToolResultBlock } from "../../src/assembler/toAnthropic";

function findToolUse(content: any[]): AnthropicToolUseBlock | undefined {
  return content.find((b: any) => b.type === "tool_use") as AnthropicToolUseBlock | undefined;
}
function findToolResult(content: any[]): AnthropicToolResultBlock | undefined {
  return content.find((b: any) => b.type === "tool_result") as AnthropicToolResultBlock | undefined;
}

function makeAssembled(overrides: any = {}): AssembledPrompt {
  return {
    system_blocks: [],
    messages: [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
      { role: "user", content: "What's up?" },
    ],
    meta: {
      anchor_index: -1,
      block_ids: [],
      client_system_hash: "none",
      cache_breakpoints: [],
    },
    ...overrides,
  };
}

describe("assembledToAnthropicMessages — synthetic tool call injection (Phase 4)", () => {
  it("appends synthetic assistant tool_use + user tool_result when synthetic_context present", () => {
    const assembled = makeAssembled({
      synthetic_context: {
        tool_name: "memory_context",
        tool_use_id: "toolu_abc123",
        tool_result: "[2025-07-11T00:00:00Z]\nmemory1: test content",
      },
    });

    const { wire } = assembledToAnthropicMessages(assembled.messages, assembled.synthetic_context);

    // Original 3 messages + 2 synthetic (assistant tool_use + user tool_result) = 5
    expect(wire.length).toBe(5);

    // Synthetic assistant message with tool_use
    const synthAssistant = wire[3];
    expect(synthAssistant.role).toBe("assistant");
    const toolUseBlock = findToolUse(synthAssistant.content as any[]);
    expect(toolUseBlock).toBeDefined();
    expect(toolUseBlock!.id).toBe("toolu_abc123");
    expect(toolUseBlock!.name).toBe("memory_context");

    // Synthetic user message with tool_result
    const synthUser = wire[4];
    expect(synthUser.role).toBe("user");
    const toolResultBlock = findToolResult(synthUser.content as any[]);
    expect(toolResultBlock).toBeDefined();
    expect(toolResultBlock!.tool_use_id).toBe("toolu_abc123");
    expect(toolResultBlock!.content).toContain("memory1: test content");
  });

  it("does NOT append synthetic messages when synthetic_context is absent", () => {
    const assembled = makeAssembled();
    const { wire } = assembledToAnthropicMessages(assembled.messages, undefined);
    expect(wire.length).toBe(3);
  });

  it("tool_use_id starts with 'toolu_' prefix (matches Anthropic format)", () => {
    const assembled = makeAssembled({
      synthetic_context: {
        tool_name: "memory_context",
        tool_use_id: "toolu_def456",
        tool_result: "test",
      },
    });
    const { wire } = assembledToAnthropicMessages(assembled.messages, assembled.synthetic_context);
    const toolUseBlock = findToolUse(wire[3].content as any[]);
    expect(toolUseBlock?.id).toMatch(/^toolu_/);
  });

  it("synthetic tool_result contains timestamp and memory content", () => {
    const assembled = makeAssembled({
      synthetic_context: {
        tool_name: "memory_context",
        tool_use_id: "toolu_xyz",
        tool_result: "[2025-07-11T12:00:00+08:00]\nfact_key_1: 用户喜欢凌晨工作\nfact_key_2: 讨论过缓存设计",
      },
    });
    const { wire } = assembledToAnthropicMessages(assembled.messages, assembled.synthetic_context);
    const toolResultBlock = findToolResult(wire[4].content as any[]);
    expect(toolResultBlock?.content).toContain("[2025-07-11T12:00:00+08:00]");
    expect(toolResultBlock?.content).toContain("用户喜欢凌晨工作");
    expect(toolResultBlock?.content).toContain("讨论过缓存设计");
  });
});

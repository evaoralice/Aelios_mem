import { describe, it, expect, vi } from "vitest";
import type { AssembledPrompt, PendingChange } from "../../../src/assembler/types";

// Heavy deps mocked — we only test the adapter build functions
vi.mock("../../../src/memory/embedding", () => ({
  createEmbedding: vi.fn(async () => null),
}));

import { buildOpenAIRequestFromAssembled, buildOpenAICompatRequest } from "../../../src/proxy/openaiAdapter";
import { buildAnthropicRequestFromAssembled } from "../../../src/proxy/anthropicAdapter";
import { createMockEnv } from "../../helpers/d1-mock";

const pendingChanges: PendingChange[] = [
  { op: "add", after_content: "用户喜欢用 Vim 写代码", target_id: null, reason: null },
  { op: "update", after_content: "用户改为早上 7 点起床", target_id: "mem_x1", reason: "作息更新" },
  { op: "delete", after_content: null, target_id: "mem_y2", reason: "重复" },
];

function makeAssembled(overrides: any = {}): AssembledPrompt {
  return {
    system_blocks: [],
    messages: [
      { role: "user", content: "你好" },
      { role: "assistant", content: "你好，有什么可以帮你？" },
      { role: "user", content: "今天天气怎么样" },
    ],
    meta: {
      anchor_index: -1,
      block_ids: [],
      client_system_hash: "none",
      cache_breakpoints: [],
    },
    pending_changes: pendingChanges,
    ...overrides,
  };
}

describe("#12: pending changes visible in Anthropic text / Anthropic toolcall / OpenAI paths", () => {
  it("Anthropic text mode: pending changes appear in last user message text", () => {
    const env = createMockEnv(undefined as any, { MEMORY_INJECTION_MODE: "text" }) as any;
    const req: any = { max_tokens: 1024 };
    const assembled = makeAssembled();

    const built = buildAnthropicRequestFromAssembled(req, "claude-test", assembled, env);

    // Find the last user message in built.messages; it should contain pending text
    const lastUser = [...built.messages].reverse().find((m) => m.role === "user");
    expect(lastUser).toBeTruthy();
    const text = typeof lastUser!.content === "string"
      ? lastUser!.content
      : JSON.stringify(lastUser!.content);
    expect(text).toContain("待处理变更");
    expect(text).toContain("用户喜欢用 Vim 写代码");
    expect(text).toContain("mem_y2");
    // No synthetic_context in text mode
    expect(built.messages.some((m: any) =>
      Array.isArray(m.content) && m.content.some((b: any) => b.type === "tool_use" && b.name === "memory_context")
    )).toBe(false);
  });

  it("Anthropic toolcall mode: pending changes appear inside synthetic memory_context tool_result", () => {
    const env = createMockEnv(undefined as any, { MEMORY_INJECTION_MODE: "toolcall" }) as any;
    const req: any = { max_tokens: 1024 };
    const assembled = makeAssembled();

    const built = buildAnthropicRequestFromAssembled(req, "claude-test", assembled, env);

    // Find the synthetic tool_use/tool_result pair with tool_name = memory_context
    const toolUseBlocks = built.messages.flatMap((m: any) =>
      Array.isArray(m.content) ? m.content.filter((b: any) => b.type === "tool_use") : []
    );
    const memoryToolUse = toolUseBlocks.find((b: any) => b.name === "memory_context");
    expect(memoryToolUse).toBeTruthy();

    const toolResultBlocks = built.messages.flatMap((m: any) =>
      Array.isArray(m.content) ? m.content.filter((b: any) => b.type === "tool_result") : []
    );
    const matchingResult = toolResultBlocks.find((b: any) => b.tool_use_id === memoryToolUse!.id);
    expect(matchingResult).toBeTruthy();
    const resultText = typeof matchingResult!.content === "string"
      ? matchingResult!.content
      : JSON.stringify(matchingResult!.content);
    expect(resultText).toContain("待处理变更");
    expect(resultText).toContain("用户喜欢用 Vim 写代码");
    expect(resultText).toContain("mem_y2");
  });

  it("OpenAI path: pending changes appear in last user message text", () => {
    const req: any = { messages: [], stream: false };
    const assembled = makeAssembled();

    const built = buildOpenAIRequestFromAssembled(req, "gpt-test", assembled);

    const lastUser = [...built.messages].reverse().find((m) => m.role === "user");
    expect(lastUser).toBeTruthy();
    const content = typeof lastUser!.content === "string"
      ? lastUser!.content
      : JSON.stringify(lastUser!.content);
    expect(content).toContain("待处理变更");
    expect(content).toContain("用户喜欢用 Vim 写代码");
    expect(content).toContain("mem_y2");
  });
});

describe("#12: Aelios private role_id / role_name must NOT be forwarded to upstream", () => {
  it("OpenAI buildOpenAICompatRequest strips role_id and role_name from request", () => {
    const req: any = {
      model: "x",
      messages: [],
      role_id: "alice-001",
      role_name: "Alice",
      thinking: { budget_tokens: 4096 },
    };
    const built = buildOpenAICompatRequest(req, "target-model");
    expect(built).not.toHaveProperty("role_id");
    expect(built).not.toHaveProperty("role_name");
    expect(built).not.toHaveProperty("thinking");
  });

  it("OpenAI buildOpenAIRequestFromAssembled strips role_id and role_name from forwarded request", () => {
    const req: any = {
      messages: [],
      role_id: "alice-001",
      role_name: "Alice",
    };
    const assembled = makeAssembled();
    const built = buildOpenAIRequestFromAssembled(req, "target-model", assembled);
    expect(built).not.toHaveProperty("role_id");
    expect(built).not.toHaveProperty("role_name");
  });

  it("Anthropic buildAnthropicRequestFromAssembled does not include role_id / role_name fields", () => {
    const env = createMockEnv(undefined as any, {}) as any;
    const req: any = {
      max_tokens: 1024,
      role_id: "alice-001",
      role_name: "Alice",
    };
    const assembled = makeAssembled();
    const built = buildAnthropicRequestFromAssembled(req, "claude-test", assembled, env) as any;
    expect(built).not.toHaveProperty("role_id");
    expect(built).not.toHaveProperty("role_name");
    // Also verify no nested leakage into system or messages
    const serialized = JSON.stringify(built);
    expect(serialized).not.toContain("alice-001");
    expect(serialized).not.toContain('"role_name"');
  });
});
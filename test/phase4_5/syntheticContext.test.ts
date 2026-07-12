import { describe, it, expect } from "vitest";
import type { AssembledPrompt } from "../../src/assembler/types";

/**
 * Phase 4: AssembledPrompt should have a synthetic_context field
 * for the fake tool_use/tool_result pair that injects memories.
 */
describe("AssembledPrompt.synthetic_context (Phase 4)", () => {
  it("AssembledPrompt type allows synthetic_context field", () => {
    const prompt: AssembledPrompt = {
      system_blocks: [],
      messages: [],
      meta: {
        anchor_index: -1,
        block_ids: [],
        client_system_hash: "none",
        cache_breakpoints: [],
      },
      synthetic_context: {
        tool_name: "memory_context",
        tool_use_id: "toolu_abc123",
        tool_result: "[2025-07-11T00:00:00Z]\nmemory1: test",
      },
    };
    expect(prompt.synthetic_context).toBeDefined();
    expect(prompt.synthetic_context?.tool_name).toBe("memory_context");
    expect(prompt.synthetic_context?.tool_use_id).toMatch(/^toolu_/);
  });

  it("synthetic_context is optional (undefined when no memories)", () => {
    const prompt: AssembledPrompt = {
      system_blocks: [],
      messages: [],
      meta: {
        anchor_index: -1,
        block_ids: [],
        client_system_hash: "none",
        cache_breakpoints: [],
      },
    };
    expect(prompt.synthetic_context).toBeUndefined();
  });
});

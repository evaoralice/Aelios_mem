import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Phase 4: MEMORY_INJECTION_MODE env var controls injection method.
 *
 * - "text" (default): append dynamic_memory_patch as text to user message
 * - "toolcall": inject as synthetic tool_use/tool_result pair
 *
 * The adapter should check this env and branch accordingly.
 */
describe("MEMORY_INJECTION_MODE switching (Phase 4)", () => {
  const src = readFileSync(resolve(__dirname, "../../src/proxy/anthropicAdapter.ts"), "utf-8");

  it("adapter reads MEMORY_INJECTION_MODE from env", () => {
    expect(src).toMatch(/MEMORY_INJECTION_MODE/);
  });

  it("adapter branches on toolcall vs text mode", () => {
    // Should have a check for "toolcall" mode
    expect(src).toMatch(/toolcall/i);
  });

  it("text mode still uses appendUncachedUserContext as fallback", () => {
    // The function should still exist for text mode
    expect(src).toMatch(/appendUncachedUserContext/);
  });

  it("Env type includes MEMORY_INJECTION_MODE", async () => {
    const typesSrc = readFileSync(resolve(__dirname, "../../src/types.ts"), "utf-8");
    expect(typesSrc).toMatch(/MEMORY_INJECTION_MODE/);
  });
});

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Phase 5: Cache breakpoint changes.
 *
 * - boot_stable gets cache_control (breakpoint 3)
 * - bridge breakpoint is removed
 * - Total breakpoints still ≤ 4
 */
describe("Phase 5: cache breakpoint changes in blocks.ts", () => {
  const src = readFileSync(resolve(__dirname, "../../src/assembler/blocks.ts"), "utf-8");

  it("boot_stable block gets cache_control when present", () => {
    // The assemble function should add cache_control to boot_stable system block
    expect(src).toMatch(/boot_stable.*cache_control/s);
  });

  it("bridge breakpoint logic is removed or disabled", () => {
    // The old bridge logic should be gone or gated behind a feature flag
    // Look for the bridge reason tag
    const bridgeMatches = src.match(/reason:\s*"bridge"/g);
    // Should either not exist, or be behind a conditional that defaults to off
    if (bridgeMatches) {
      // If bridge still exists, it should be behind a feature flag
      expect(src).toMatch(/MEMORY_INJECTION_MODE|bridge.*disabled|enable.*bridge/i);
    }
  });
});

describe("Phase 5: verify-assembler.mjs breakpoint mirror", () => {
  const src = readFileSync(resolve(__dirname, "../../scripts/verify-assembler.mjs"), "utf-8");

  it("verify-assembler checks boot_stable breakpoint (not bridge as primary)", () => {
    // The test script should have a test that checks boot_stable gets cache_control
    // or that bridge is no longer the primary breakpoint 3
    expect(src).toMatch(/boot_stable.*cache_control|breakpoint.*boot_stable/i);
  });
});

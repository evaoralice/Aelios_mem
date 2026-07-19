import { describe, it, expect } from "vitest";
import { formatBootStable } from "../../../src/assembler/types";
import type { BootPackage } from "../../../src/memory/v2/recall";

function makeBoot(overrides: any = {}): BootPackage {
  return {
    digest: null,
    recent_logs: [],
    precious: [],
    glossary: [],
    baselines: [],
    schema_version: "v2-1",
    cache_prefix_end: true,
    ...overrides,
  } as any;
}

describe("Phase 4: baseline current-role priority", () => {
  it("shared baseline comes first when pre-sorted", () => {
    const boot = makeBoot({
      baselines: [
        { role_scope: "shared", content: "共享基线", version: 1 },
        { role_scope: "id:alice-001", content: "Alice基线", version: 1 },
      ],
    });
    const out = formatBootStable(boot);
    const sharedIdx = out.indexOf("共享基线");
    const aliceIdx = out.indexOf("Alice基线");
    expect(sharedIdx).toBeGreaterThan(-1);
    expect(aliceIdx).toBeGreaterThan(-1);
    expect(sharedIdx).toBeLessThan(aliceIdx);
  });

  it("truncates baselines exceeding total cap", () => {
    const longContent = "x".repeat(6000);
    const boot = makeBoot({
      baselines: [
        { role_scope: "shared", content: longContent, version: 1 },
        { role_scope: "id:bob", content: "y".repeat(3000), version: 1 },
      ],
    });
    const out = formatBootStable(boot);
    // Total cap is 8000, shared takes 6000, bob should be truncated to 2000
    expect(out).toContain("x".repeat(6000));
    // bob content should be truncated (not full 3000)
    const bobSection = out.split("[id:bob]")[1] ?? "";
    expect(bobSection.length).toBeLessThan(3000);
  });

  it("omits baselines block when content is empty", () => {
    const boot = makeBoot({
      baselines: [],
    });
    const out = formatBootStable(boot);
    expect(out).not.toContain("<long_term_baselines>");
  });
});

describe("Phase 4 / P1-2: buildBootPackage only fetches current role baseline", () => {
  it("only queries baseline for the current role_scope, not all baselines", async () => {
    // Source check: should query getBaselines with roleScope filter, not unfiltered.
    const fs = await import("fs");
    const path = await import("path");
    const code = fs.readFileSync(
      path.resolve(__dirname, "../../../src/memory/v2/recall.ts"),
      "utf-8"
    );
    // Should call getBaselines with roleScope=requestRoleScope (not unfiltered)
    expect(code).toMatch(/getBaselines\(env\.DB,\s*\{\s*namespace:\s*input\.namespace,\s*roleScope:\s*requestRoleScope\s*\}\)/);
    // Should NOT fetch all baselines then sort (P1-2 explicitly removes that)
    expect(code).not.toMatch(/getBaselines\(env\.DB,\s*\{\s*namespace:\s*input\.namespace\s*\}\)/);
  });
});
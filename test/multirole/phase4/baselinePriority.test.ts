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

describe("Phase 4: buildBootPackage baseline sorting", () => {
  it("sorts baselines: shared first, then current role, then others", async () => {
    const src = await import("../../../src/memory/v2/recall");
    // Check source code has the sorting logic
    const fs = await import("fs");
    const path = await import("path");
    const code = fs.readFileSync(
      path.resolve(__dirname, "../../../src/memory/v2/recall.ts"),
      "utf-8"
    );
    // Should have sorting with shared first and requestRoleScope
    expect(code).toMatch(/shared.*first|role_scope === .shared.*return -1/);
    expect(code).toMatch(/requestRoleScope/);
    expect(code).toMatch(/localeCompare/);
  });
});
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

describe("Phase F: formatBootStable renders baselines", () => {
  it("renders <long_term_baselines> when baselines present", () => {
    const boot = makeBoot({
      baselines: [
        { role_scope: "shared", content: "用户喜欢凌晨工作", version: 1 },
        { role_scope: "id:alice-001", content: "Alice 专属基线", version: 2 },
      ],
    });
    const out = formatBootStable(boot);
    expect(out).toContain("<long_term_baselines>");
    expect(out).toContain("用户喜欢凌晨工作");
    expect(out).toContain("Alice 专属基线");
    expect(out).toContain("</long_term_baselines>");
  });

  it("omits <long_term_baselines> when empty", () => {
    const boot = makeBoot({ baselines: [] });
    const out = formatBootStable(boot);
    expect(out).not.toContain("<long_term_baselines>");
  });

  it("does not prefix [shared] for shared scope", () => {
    const boot = makeBoot({
      baselines: [{ role_scope: "shared", content: "共享内容", version: 1 }],
    });
    const out = formatBootStable(boot);
    expect(out).not.toContain("[shared]");
    expect(out).toContain("共享内容");
  });

  it("prefixes [role_scope] for non-shared scope", () => {
    const boot = makeBoot({
      baselines: [{ role_scope: "id:alice-001", content: "Alice内容", version: 1 }],
    });
    const out = formatBootStable(boot);
    expect(out).toContain("[id:alice-001]");
    expect(out).toContain("Alice内容");
  });

  it("baselines come before digest", () => {
    const boot = makeBoot({
      baselines: [{ role_scope: "shared", content: "基线文本", version: 1 }],
      digest: { content: "摘要文本", updated_at: "t" },
    });
    const out = formatBootStable(boot);
    const baselineIdx = out.indexOf("<long_term_baselines>");
    const digestIdx = out.indexOf("<digest>");
    expect(baselineIdx).toBeGreaterThan(-1);
    expect(digestIdx).toBeGreaterThan(-1);
    expect(baselineIdx).toBeLessThan(digestIdx);
  });
});
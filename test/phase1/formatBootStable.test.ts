import { describe, it, expect } from "vitest";
import { formatBootStable } from "../../src/assembler/types";

// Helper: build a boot-like object with the NEW shape (recent_logs array).
// In RED phase, BootPackage still has yesterday_log; we cast to test future behavior.
function makeBoot(overrides: any = {}) {
  return {
    digest: null,
    recent_logs: [],
    precious: [],
    glossary: [],
    schema_version: "v2-1",
    cache_prefix_end: true,
    ...overrides,
  } as any;
}

describe("formatBootStable — recent_logs (two-day daily log)", () => {
  it("renders <daily_log> block with two entries when two logs available", () => {
    const boot = makeBoot({
      recent_logs: [
        { date: "2025-07-10", title: "整理", summary: "合并了重复记忆" },
        { date: "2025-07-09", title: "对话", summary: "讨论了缓存设计" },
      ],
    });

    const out = formatBootStable(boot);
    expect(out).toContain("<daily_log>");
    expect(out).toContain("[2025-07-10]");
    expect(out).toContain("整理");
    expect(out).toContain("合并了重复记忆");
    expect(out).toContain("[2025-07-09]");
    expect(out).toContain("讨论了缓存设计");
    expect(out).toContain("</daily_log>");
  });

  it("renders <daily_log> block with one entry when only one log available", () => {
    const boot = makeBoot({
      recent_logs: [{ date: "2025-07-10", title: "T", summary: "S" }],
    });

    const out = formatBootStable(boot);
    expect(out).toContain("<daily_log>");
    expect(out).toContain("[2025-07-10]");
    expect(out).toContain("</daily_log>");
  });

  it("omits <daily_log> block entirely when recent_logs is empty", () => {
    const boot = makeBoot({ recent_logs: [] });
    const out = formatBootStable(boot);
    expect(out).not.toContain("<daily_log>");
    expect(out).not.toContain("</daily_log>");
  });

  it("does NOT render legacy <yesterday_log> tag (replaced by <daily_log>)", () => {
    const boot = makeBoot({
      recent_logs: [{ date: "2025-07-10", title: "T", summary: "S" }],
    });
    const out = formatBootStable(boot);
    expect(out).not.toContain("<yesterday_log>");
  });

  it("preserves <digest> block when present", () => {
    const boot = makeBoot({
      digest: { content: "用户喜欢凌晨工作", updated_at: "2025-07-10T00:00:00Z" },
      recent_logs: [],
    });
    const out = formatBootStable(boot);
    expect(out).toContain("<digest>");
    expect(out).toContain("用户喜欢凌晨工作");
    expect(out).toContain("</digest>");
  });

  it("preserves <glossary> block when entries present", () => {
    const boot = makeBoot({
      glossary: [{ term: "MCP", definition: "Model Context Protocol", aliases: [] }],
      recent_logs: [],
    });
    const out = formatBootStable(boot);
    expect(out).toContain("<glossary>");
    expect(out).toContain("MCP");
    expect(out).toContain("</glossary>");
  });

  it("formats each entry as [date]【title】summary", () => {
    const boot = makeBoot({
      recent_logs: [
        { date: "2025-07-10", title: "夜间整理", summary: "合并了3条重复记忆" },
      ],
    });
    const out = formatBootStable(boot);
    expect(out).toMatch(/\[2025-07-10\]【夜间整理】合并了3条重复记忆/);
  });

  it("orders entries by date DESC (most recent first)", () => {
    const boot = makeBoot({
      recent_logs: [
        { date: "2025-07-10", title: "A", summary: "a" },
        { date: "2025-07-09", title: "B", summary: "b" },
      ],
    });
    const out = formatBootStable(boot);
    const idxA = out.indexOf("[2025-07-10]");
    const idxB = out.indexOf("[2025-07-09]");
    expect(idxA).toBeGreaterThan(-1);
    expect(idxB).toBeGreaterThan(-1);
    expect(idxA).toBeLessThan(idxB);
  });
});
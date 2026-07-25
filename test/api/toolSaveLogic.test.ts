import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

describe("tool 续接请求保存逻辑（源码扫描）", () => {
  const src = readFileSync(resolve(__dirname, "../../src/api/chatCompletions.ts"), "utf-8");

  it("请求以 tool result 结尾时不调 saveUserMessages", () => {
    // 应该有 endsWithUser 判断，且 saveUserMessages 在条件内
    expect(src).toMatch(/endsWithUser/);
    expect(src).toMatch(/if\s*\(endsWithUser\)/);
    expect(src).toMatch(/saveUserMessages/);
    // saveUserMessages 调用应该在 if (endsWithUser) 块内
    const saveBlock = src.match(/if\s*\(endsWithUser\)\s*\{[\s\S]*?saveUserMessages/);
    expect(saveBlock).toBeTruthy();
  });

  it("空 content + 有 tool_calls 的 assistant 响应不调 saveAssistantMessage", () => {
    // 应该有 hasToolCalls 判断
    expect(src).toMatch(/hasToolCalls/);
    // 条件: filteredContent || !hasToolCalls → 有内容或没有 tool_calls 时才保存
    expect(src).toMatch(/filteredContent\s*\|\|\s*!hasToolCalls/);
    // saveAssistantMessage 应该在条件表达式内（三元运算符）
    expect(src).toMatch(/filteredContent\s*\|\|\s*!hasToolCalls[\s\S]*?saveAssistantMessage/);
  });

  it("assistantMessageId 为 null 时跳过 saveUsageLog 和 enqueueMemoryMaintenance", () => {
    // 应该有 assistantMessageId 条件判断
    expect(src).toMatch(/assistantMessageId\s*\?/);
    // enqueueMemoryMaintenanceIfNeeded 应该在 assistantMessageId && latestUserMessageId 条件内
    expect(src).toMatch(/assistantMessageId\s*&&\s*latestUserMessageId/);
  });

  it("tool 续接请求仍能正常返回 response（不因跳过保存而中断）", () => {
    // saveUserMessages 跳过不应该导致整个请求失败
    // latestUserMessageId 应该有 fallback (undefined)
    expect(src).toMatch(/savedUserMessageIds\.length > 0/);
  });
});
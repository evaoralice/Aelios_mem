import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

describe("流式 tool_calls 保存逻辑（源码扫描）", () => {
  const openaiSrc = readFileSync(resolve(__dirname, "../../src/proxy/streamOpenAI.ts"), "utf-8");
  const anthropicSrc = readFileSync(resolve(__dirname, "../../src/proxy/streamAnthropic.ts"), "utf-8");

  describe("streamOpenAI.ts", () => {
    it("StreamState 有 hasToolCalls 字段", () => {
      expect(openaiSrc).toMatch(/hasToolCalls:\s*boolean/);
    });

    it("收到 tool_calls delta 时标记 state.hasToolCalls = true", () => {
      expect(openaiSrc).toMatch(/hasToolCalls.*=.*true/);
    });

    it("persistStreamResult 在空 content + 有 tool_calls 时跳过 saveAssistantMessage", () => {
      expect(openaiSrc).toMatch(/!state\.assistantText\s*&&\s*state\.hasToolCalls/);
      // saveAssistantMessage 应该在 return 之后
      const skipMatch = openaiSrc.match(/if\s*\(!state\.assistantText\s*&&\s*state\.hasToolCalls\)\s*\{[\s\S]*?return;[\s\S]*?\}/);
      expect(skipMatch).toBeTruthy();
      expect(skipMatch![0]).not.toContain("saveAssistantMessage");
    });

    it("有可见文本时仍正常保存", () => {
      // persistStreamResult 在非跳过路径调用 saveAssistantMessage
      expect(openaiSrc).toMatch(/saveAssistantMessage/);
    });

    it("enqueueMemoryMaintenanceIfNeeded 在 fromMessageId 存在时才调用", () => {
      expect(openaiSrc).toMatch(/if\s*\(options\.fromMessageId\)/);
    });
  });

  describe("streamAnthropic.ts", () => {
    it("StreamState 有 hasToolCalls 字段", () => {
      expect(anthropicSrc).toMatch(/hasToolCalls:\s*boolean/);
    });

    it("收到 content_block_start tool_use 时标记 state.hasToolCalls = true", () => {
      expect(anthropicSrc).toMatch(/tool_use[\s\S]*?state\.hasToolCalls\s*=\s*true/);
    });

    it("persistStreamResult 在空 content + 有 tool_calls 时跳过 saveAssistantMessage", () => {
      expect(anthropicSrc).toMatch(/!state\.assistantText\s*&&\s*state\.hasToolCalls/);
      const skipMatch = anthropicSrc.match(/if\s*\(!state\.assistantText\s*&&\s*state\.hasToolCalls\)\s*\{[\s\S]*?return;[\s\S]*?\}/);
      expect(skipMatch).toBeTruthy();
      expect(skipMatch![0]).not.toContain("saveAssistantMessage");
    });

    it("有可见文本时仍正常保存", () => {
      expect(anthropicSrc).toMatch(/saveAssistantMessage/);
    });

    it("enqueueMemoryMaintenanceIfNeeded 在 fromMessageId 存在时才调用", () => {
      expect(anthropicSrc).toMatch(/if\s*\(options\.fromMessageId\)/);
    });
  });
});
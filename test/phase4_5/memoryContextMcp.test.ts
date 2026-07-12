import { describe, it, expect, vi } from "vitest";
import { createMockD1, createMockEnv } from "../helpers/d1-mock";

describe("memory_context MCP tool (Phase 4)", () => {
  it("getTools() includes memory_context tool definition", async () => {
    // Read the source to check the tool definition exists
    const { readFileSync } = await import("fs");
    const { resolve } = await import("path");
    const src = readFileSync(resolve(__dirname, "../../src/api/mcp.ts"), "utf-8");

    // Should have a tool named "memory_context"
    expect(src).toMatch(/name:\s*"memory_context"/);

    // Description should say "system" / "do not call manually"
    const ctxSection = src.match(/name:\s*"memory_context"[\s\S]*?(?:name:\s*"|}$)/);
    expect(ctxSection).toBeTruthy();
    const section = ctxSection![0].toLowerCase();
    expect(section).toMatch(/system|do not call|manual/);
  });

  it("callTool returns fallback when memory_context is called", async () => {
    const { callTool } = await import("../../src/api/mcp");
    const db = createMockD1({ onQuery: () => [], onRun: () => {} });
    const env = createMockEnv(db);
    const profile = { scopes: ["memory:read"], namespace: "test" } as any;
    const ctx = { waitUntil: () => {} } as any;

    const result = await callTool(env, ctx, profile, {
      name: "memory_context",
      arguments: {},
    } as any);

    // Should return a text result (not an error)
    const isError = (result as any).isError === true;
    expect(isError).toBeFalsy();

    // The content should contain the fallback message
    const content = (result as any).content?.[0]?.text ?? "";
    expect(content).toMatch(/already been executed|do not call/i);
  });
});

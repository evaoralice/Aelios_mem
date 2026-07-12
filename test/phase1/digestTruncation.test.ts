import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { createMockD1, createMockEnv } from "../helpers/d1-mock";

/**
 * Test the DIGEST_MAX_CHARS constant from db/v2.ts.
 * Should be exported and equal 1000 (was 500 before Phase 1).
 */
describe("DIGEST_MAX_CHARS constant", () => {
  it("should be exported from db/v2 and equal 1000", async () => {
    const mod = await import("../../src/db/v2");
    expect((mod as any).DIGEST_MAX_CHARS).toBe(1000);
  });
});

/**
 * dailyDigest.ts uses truncate(digestContent, 500) — should be DIGEST_MAX_CHARS (1000).
 */
describe("dailyDigest.ts digest truncation", () => {
  it("does not hardcode 500 for digest truncation", () => {
    const src = readFileSync(
      resolve(__dirname, "../../src/memory/dailyDigest.ts"),
      "utf-8"
    );
    // The truncate call for digest content should NOT be 500 anymore.
    expect(src).not.toMatch(/truncate\(digestContent,\s*500\)/);
    // It should use DIGEST_MAX_CHARS (or 1000) instead.
    expect(src).toMatch(/truncate\(digestContent,\s*(?:DIGEST_MAX_CHARS|1000)\)/);
  });
});

/**
 * mcp.ts digest_set tool: currently rejects content.length > 500.
 * Should reject only > 1000, and accept 501-1000.
 */
describe("mcp.ts digest_set truncation", () => {
  it("description says <=1000 chars (not <=500)", () => {
    const src = readFileSync(resolve(__dirname, "../../src/api/mcp.ts"), "utf-8");
    // digest_get description
    expect(src).not.toMatch(/Read the L1 digest.*<=500 chars/);
    expect(src).toMatch(/<=1000 chars/);
  });

  it("does not hardcode 500 in the digest_set validation", () => {
    const src = readFileSync(resolve(__dirname, "../../src/api/mcp.ts"), "utf-8");
    // The validation `content.length > 500` should be gone.
    expect(src).not.toMatch(/content\.length\s*>\s*500/);
    // Should reference 1000 or DIGEST_MAX_CHARS instead.
    expect(src).toMatch(/(?:1000|DIGEST_MAX_CHARS)/);
  });

  it("digest_set accepts content of 700 chars (currently rejected with >500)", async () => {
    const { callTool } = await import("../../src/api/mcp");
    const db = createMockD1({
      onQuery: () => [],
      onRun: () => {},
    });
    const env = createMockEnv(db);
    const profile = { scopes: ["memory:write"], namespace: "test" } as any;
    const ctx = { waitUntil: () => {} } as any;

    const result = await callTool(env, ctx, profile, {
      name: "digest_set",
      arguments: { content: "x".repeat(700) },
    } as any);

    // Should NOT be an error (would be error if 500 limit is in place).
    const isError = (result as any).isError === true || (result as any).error;
    expect(isError).toBeFalsy();
  });

  it("digest_set rejects content of 1001 chars", async () => {
    const { callTool } = await import("../../src/api/mcp");
    const db = createMockD1({ onQuery: () => [], onRun: () => {} });
    const env = createMockEnv(db);
    const profile = { scopes: ["memory:write"], namespace: "test" } as any;
    const ctx = { waitUntil: () => {} } as any;

    const result = await callTool(env, ctx, profile, {
      name: "digest_set",
      arguments: { content: "x".repeat(1001) },
    } as any);

    const isError = (result as any).isError === true || (result as any).error;
    expect(isError).toBeTruthy();
  });
});
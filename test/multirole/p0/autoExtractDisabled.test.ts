import { describe, it, expect, vi } from "vitest";
import { createMockD1, createMockEnv } from "../../helpers/d1-mock";

vi.mock("../../../src/db/messages", () => ({
  listMessagesByNamespaceInRange: vi.fn(async () => []),
}));
vi.mock("../../../src/db/retention", () => ({
  readCursor: vi.fn(async () => null),
  writeCursor: vi.fn(async () => {}),
}));
vi.mock("../../../src/proxy/openaiAdapter", () => ({
  callOpenAICompat: vi.fn(async () => new Response("{}", { status: 200 })),
}));

import { runMemoryExtractionWindow, runMemoryExtractionBatches } from "../../../src/memory/extractPipeline";

describe("P0-2: auto extraction disabled when ENABLE_AUTO_MEMORY=false", () => {
  it("runMemoryExtractionWindow returns auto_memory_disabled", async () => {
    const env = createMockEnv(createMockD1(), { ENABLE_AUTO_MEMORY: "false" });
    const result = await runMemoryExtractionWindow(env, "ns");
    expect(result.ran).toBe(false);
    expect((result as any).reason).toBe("auto_memory_disabled");
  });

  it("runMemoryExtractionBatches returns auto_memory_disabled", async () => {
    const env = createMockEnv(createMockD1(), { ENABLE_AUTO_MEMORY: "false" });
    const results = await runMemoryExtractionBatches(env, "ns");
    expect(results).toHaveLength(1);
    expect(results[0].ran).toBe(false);
    expect((results[0] as any).reason).toBe("auto_memory_disabled");
  });

  it("extraction runs normally when ENABLE_AUTO_MEMORY not set", async () => {
    const env = createMockEnv(createMockD1()); // no ENABLE_AUTO_MEMORY
    const result = await runMemoryExtractionWindow(env, "ns");
    // Should not return auto_memory_disabled (may return other reasons like no_messages)
    expect((result as any).reason).not.toBe("auto_memory_disabled");
  });

  it("extraction runs normally when ENABLE_AUTO_MEMORY=true", async () => {
    const env = createMockEnv(createMockD1(), { ENABLE_AUTO_MEMORY: "true" });
    const result = await runMemoryExtractionWindow(env, "ns");
    expect((result as any).reason).not.toBe("auto_memory_disabled");
  });
});

describe("P0-2: scheduled() skips extract when disabled", () => {
  it("index.ts checks ENABLE_AUTO_MEMORY before calling extract", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(
      path.resolve(__dirname, "../../../src/index.ts"),
      "utf-8"
    );
    expect(src).toMatch(/ENABLE_AUTO_MEMORY.*false/);
    expect(src).toMatch(/shouldRunExtract.*ENABLE_AUTO_MEMORY/);
  });
});
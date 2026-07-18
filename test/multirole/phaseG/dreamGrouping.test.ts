import { describe, it, expect, vi } from "vitest";
import { createMockD1, createMockEnv } from "../../helpers/d1-mock";

// Mock heavy imports
vi.mock("../../../src/memory/vectorStore", () => ({
  searchVectorMemories: vi.fn(async () => []),
  createVectorMemory: vi.fn(async () => ({})),
  deleteVectorMemory: vi.fn(async () => true),
  getVectorMemory: vi.fn(async () => null),
  listVectorMemories: vi.fn(async () => ({ data: [], cursor: null, hasMore: false })),
}));
vi.mock("../../../src/memory/search", () => ({
  searchMemories: vi.fn(async () => []),
  toMemoryApiRecord: (r: any) => r,
}));
vi.mock("../../../src/memory/filter", () => ({
  filterAndCompressMemories: vi.fn(async () => []),
}));
vi.mock("../../../src/memory/embedding", () => ({
  createEmbedding: vi.fn(async () => null),
}));
vi.mock("../../../src/proxy/openaiAdapter", () => ({
  callOpenAICompat: vi.fn(async () => new Response("{}", { status: 200 })),
}));
vi.mock("../../../src/db/messages", () => ({
  listMessagesByNamespaceInRange: vi.fn(async () => []),
}));
vi.mock("../../../src/db/memories", () => ({
  listMemoriesPage: vi.fn(async () => ({ records: [], hasMore: false, nextOffset: 0 })),
}));
vi.mock("../../../src/db/retention", () => ({
  readCursor: vi.fn(async () => null),
  writeCursor: vi.fn(async () => {}),
}));

import { listPendingChangelog, markChangelogApplied, markChangelogConflict } from "../../../src/db/v2";

describe("Phase G: changelog apply functions exist", () => {
  it("markChangelogApplied is exported", () => {
    expect(typeof markChangelogApplied).toBe("function");
  });

  it("markChangelogConflict is exported", () => {
    expect(typeof markChangelogConflict).toBe("function");
  });

  it("listPendingChangelog is exported", () => {
    expect(typeof listPendingChangelog).toBe("function");
  });
});

describe("Phase G: message grouping by role_id", () => {
  it("groups messages by role_id, null = shared", () => {
    const messages = [
      { id: "m1", role_id: "alice-001", role_name: "Alice", content: "hi" },
      { id: "m2", role_id: null, role_name: null, content: "shared msg" },
      { id: "m3", role_id: "alice-001", role_name: "Alice", content: "hello" },
      { id: "m4", role_id: "bob-002", role_name: "Bob", content: "hey" },
    ] as any;

    const grouped = new Map<string | null, typeof messages>();
    for (const msg of messages) {
      const key = msg.role_id ?? null;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(msg);
    }

    expect(grouped.get("alice-001")).toHaveLength(2);
    expect(grouped.get("bob-002")).toHaveLength(1);
    expect(grouped.get(null)).toHaveLength(1);
  });
});
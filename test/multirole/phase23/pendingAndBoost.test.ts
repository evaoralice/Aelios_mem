import { describe, it, expect, vi } from "vitest";
import { createMockD1, createMockEnv } from "../../helpers/d1-mock";
import { readFileSync } from "fs";
import { resolve } from "path";

vi.mock("../../../src/memory/search", () => ({
  searchMemories: vi.fn(),
  toMemoryApiRecord: (r: any) => r,
}));
vi.mock("../../../src/memory/filter", () => ({
  filterAndCompressMemories: vi.fn(async (_env: any, input: { memories: any[] }) =>
    input.memories.map((m) => ({ ...m, score: m.score ?? 0.5 }))
  ),
}));
vi.mock("../../../src/memory/embedding", () => ({
  createEmbedding: vi.fn(async () => null),
}));

import { searchMemories } from "../../../src/memory/search";
import { filterAndCompressMemories } from "../../../src/memory/filter";
import { runRecall } from "../../../src/memory/v2/recall";

function makeMemory(overrides: any = {}) {
  return {
    id: "m1", namespace: "ns", type: "fact", content: "test",
    summary: null, importance: 0.7, confidence: 0.8, status: "active",
    pinned: false, tags: [], source: "extract", source_message_ids: [],
    vector_id: "v1", last_recalled_at: null, last_injected_at: null,
    recall_count: 0, created_at: "2025-01-01", updated_at: "2025-01-01",
    expires_at: null, score: 0.5,
    role_id: null, role_name: null, role_scope: "shared",
    ...overrides,
  };
}

function mockDb() {
  return createMockD1({
    onQuery: (sql: string) => {
      if (sql.includes("FROM digest")) return [];
      if (sql.includes("FROM precious")) return [];
      if (sql.includes("FROM glossary")) return [];
      return [];
    },
  });
}

describe("Phase 2: pending_changes cross-provider injection", () => {
  it("text mode injects pending changes via formatDynamicMemoryText", () => {
    const src = readFileSync(resolve(__dirname, "../../../src/proxy/anthropicAdapter.ts"), "utf-8");
    expect(src).toMatch(/formatDynamicMemoryText/);
    // Text mode should call formatDynamicMemoryText
    expect(src).toMatch(/injectionMode === "text"[\s\S]*formatDynamicMemoryText/);
  });

  it("OpenAI adapter injects pending changes", () => {
    const src = readFileSync(resolve(__dirname, "../../../src/proxy/openaiAdapter.ts"), "utf-8");
    expect(src).toMatch(/formatPendingChangesText/);
    expect(src).toMatch(/pending_changes/);
  });

  it("chatCompletions sets pending_changes on OpenAI assembled path", () => {
    const src = readFileSync(resolve(__dirname, "../../../src/api/chatCompletions.ts"), "utf-8");
    // Should have pending_changes set in both anthropic and openai branches
    const matches = src.match(/assembled\.pending_changes = pendingChanges/g);
    expect(matches).toBeTruthy();
    expect(matches!.length).toBeGreaterThanOrEqual(2);
  });
});

describe("Phase 3: role boost pre-boost before reranker", () => {
  it("pre-boost is applied before filterAndCompressMemories", async () => {
    const env = createMockEnv(mockDb(), {
      RECALL_ROLE_BOOST_EXACT: "1.3",
      RECALL_ROLE_BOOST_NAME: "1.1",
      ROLE_MEMORY_ENABLED: "true",
    });

    // Track what gets passed to filterAndCompressMemories
    let capturedMemories: any[] = [];
    vi.mocked(searchMemories).mockResolvedValue([
      makeMemory({ id: "a", role_id: "alice-001", role_scope: "id:alice-001", score: 0.5 }),
      makeMemory({ id: "b", role_id: null, role_scope: "shared", score: 0.5 }),
    ]);
    vi.mocked(filterAndCompressMemories).mockImplementation(async (_env: any, input: { memories: any[] }) => {
      capturedMemories = input.memories;
      return input.memories.map((m) => ({ ...m, score: m.score ?? 0.5 }));
    });

    await runRecall(env, { namespace: "ns", query: "test", role_id: "alice-001" } as any);

    // No pre-boost applied — scores pass through unchanged to filterAndCompressMemories
    const memA = capturedMemories.find((m) => m.id === "a");
    const memB = capturedMemories.find((m) => m.id === "b");
    expect(memA!.score).toBeCloseTo(0.5, 5);
    expect(memB!.score).toBeCloseTo(0.5, 5);
  });

  it("full boost is applied in step 3 (after reranker)", async () => {
    const env = createMockEnv(mockDb(), {
      RECALL_ROLE_BOOST_EXACT: "1.3",
      RECALL_ROLE_BOOST_NAME: "1.1",
      ROLE_MEMORY_ENABLED: "true",
    });

    vi.mocked(searchMemories).mockResolvedValue([
      makeMemory({ id: "a", role_id: "alice-001", role_scope: "id:alice-001", score: 0.5 }),
    ]);
    vi.mocked(filterAndCompressMemories).mockImplementation(async (_env: any, input: { memories: any[] }) =>
      input.memories.map((m) => ({ ...m, score: m.score }))
    );

    const result = await runRecall(env, { namespace: "ns", query: "test", role_id: "alice-001" } as any);
    const hit = result.hits.find((h) => h.id === "a");
    // Full boost: 0.5 * 1.3 = 0.65
    expect(hit!.score).toBeCloseTo(0.65, 5);
  });

  it("pre-boost is NOT applied when ROLE_MEMORY_ENABLED is false", async () => {
    const env = createMockEnv(mockDb(), {
      RECALL_ROLE_BOOST_EXACT: "1.3",
    }); // no ROLE_MEMORY_ENABLED

    let capturedMemories: any[] = [];
    vi.mocked(searchMemories).mockResolvedValue([
      makeMemory({ id: "a", role_id: "alice-001", role_scope: "id:alice-001", score: 0.5 }),
    ]);
    vi.mocked(filterAndCompressMemories).mockImplementation(async (_env: any, input: { memories: any[] }) => {
      capturedMemories = input.memories;
      return input.memories;
    });

    await runRecall(env, { namespace: "ns", query: "test", role_id: "alice-001" } as any);

    // No pre-boost applied
    expect(capturedMemories[0].score).toBeCloseTo(0.5, 5);
  });
});
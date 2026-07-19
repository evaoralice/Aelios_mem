import { describe, it, expect, vi } from "vitest";
import { createMockD1, createMockEnv } from "../../helpers/d1-mock";

vi.mock("../../../src/memory/search", () => ({
  searchMemories: vi.fn(),
  toMemoryApiRecord: (r: any) => r,
}));
vi.mock("../../../src/memory/filter", () => ({
  filterAndCompressMemories: vi.fn(),
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

// Use mockImplementation so input scores (including pre-boost) are preserved
function mockFilterPassThrough() {
  vi.mocked(filterAndCompressMemories).mockImplementation(
    async (_env: any, input: { memories: any[] }) =>
      input.memories.map((m) => ({ ...m, score: m.score ?? 0.5 }))
  );
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

describe("recall role boost (Phase E)", () => {
  it("applies role boost when role_id exactly matches", async () => {
    const env = createMockEnv(mockDb(), {
      RECALL_ROLE_BOOST_EXACT: "1.3",
      RECALL_ROLE_BOOST_NAME: "1.1",
      ROLE_MEMORY_ENABLED: "true",
    });
    vi.mocked(searchMemories).mockResolvedValue([
      makeMemory({ id: "a", role_id: "alice-001", role_scope: "id:alice-001", score: 0.5, content: "alice fact about cats" }),
      makeMemory({ id: "b", role_id: null, role_scope: "shared", score: 0.5, content: "shared fact about dogs" }),
    ]);
    mockFilterPassThrough();

    const result = await runRecall(env, { namespace: "ns", query: "test", role_id: "alice-001" } as any);
    const hitA = result.hits.find((h) => h.id === "a");
    const hitB = result.hits.find((h) => h.id === "b");
    // 0.5 * 1.3 = 0.65
    expect(hitA!.score).toBeCloseTo(0.65, 5);
    expect(hitB!.score).toBeCloseTo(0.5, 5);
  });

  it("applies name boost when only role_name matches (no role_id in request)", async () => {
    const env = createMockEnv(mockDb(), {
      RECALL_ROLE_BOOST_EXACT: "1.3",
      RECALL_ROLE_BOOST_NAME: "1.1",
      ROLE_MEMORY_ENABLED: "true",
    });
    vi.mocked(searchMemories).mockResolvedValue([
      makeMemory({ id: "c", role_id: null, role_name: "Alice", role_scope: "name:Alice", score: 0.4 }),
    ]);
    mockFilterPassThrough();

    const result = await runRecall(env, { namespace: "ns", query: "test", role_name: "Alice" } as any);
    const hit = result.hits.find((h) => h.id === "c");
    // pre: sqrt(1.1), post: sqrt(1.1), total = 1.1
    // 0.4 * 1.1 = 0.44
    expect(hit!.score).toBeCloseTo(0.44, 5);
  });

  it("does NOT boost when role_ids differ even if names match", async () => {
    const env = createMockEnv(mockDb(), {
      RECALL_ROLE_BOOST_EXACT: "1.3",
      RECALL_ROLE_BOOST_NAME: "1.1",
      ROLE_MEMORY_ENABLED: "true",
    });
    vi.mocked(searchMemories).mockResolvedValue([
      makeMemory({ id: "d", role_id: "bob-001", role_name: "Alice", role_scope: "id:bob-001", score: 0.5 }),
    ]);
    mockFilterPassThrough();

    const result = await runRecall(env, { namespace: "ns", query: "test", role_id: "alice-001", role_name: "Alice" } as any);
    const hit = result.hits.find((h) => h.id === "d");
    expect(hit!.score).toBeCloseTo(0.5, 5);
  });

  it("does NOT boost when no role info in request", async () => {
    const env = createMockEnv(mockDb(), {
      RECALL_ROLE_BOOST_EXACT: "1.3",
      RECALL_ROLE_BOOST_NAME: "1.1",
      ROLE_MEMORY_ENABLED: "true",
    });
    vi.mocked(searchMemories).mockResolvedValue([
      makeMemory({ id: "e", role_id: "alice-001", role_scope: "id:alice-001", score: 0.5 }),
    ]);
    mockFilterPassThrough();

    const result = await runRecall(env, { namespace: "ns", query: "test" } as any);
    const hit = result.hits.find((h) => h.id === "e");
    expect(hit!.score).toBeCloseTo(0.5, 5);
  });

  it("role boost stacks with source boost", async () => {
    const env = createMockEnv(mockDb(), {
      RECALL_SOURCE_BOOST: "1.2",
      RECALL_ROLE_BOOST_EXACT: "1.3",
      RECALL_ROLE_BOOST_NAME: "1.1",
      ROLE_MEMORY_ENABLED: "true",
    });
    vi.mocked(searchMemories).mockResolvedValue([
      makeMemory({ id: "f", role_id: "alice-001", role_scope: "id:alice-001", source: "mcp", score: 0.5 }),
    ]);
    mockFilterPassThrough();

    const result = await runRecall(env, { namespace: "ns", query: "test", role_id: "alice-001" } as any);
    const hit = result.hits.find((h) => h.id === "f");
    // role: pre sqrt(1.3) * post sqrt(1.3) = 1.3
    // source: 1.2
    // 0.5 * 1.2 * 1.3 = 0.78
    expect(hit!.score).toBeCloseTo(0.78, 5);
  });

  it("boosted memories rank higher than non-boosted with same base score", async () => {
    const env = createMockEnv(mockDb(), {
      RECALL_ROLE_BOOST_EXACT: "1.3",
      RECALL_ROLE_BOOST_NAME: "1.1",
      ROLE_MEMORY_ENABLED: "true",
    });
    vi.mocked(searchMemories).mockResolvedValue([
      makeMemory({ id: "low", role_id: null, role_scope: "shared", score: 0.5 }),
      makeMemory({ id: "high", role_id: "alice-001", role_scope: "id:alice-001", score: 0.5 }),
    ]);
    mockFilterPassThrough();

    const result = await runRecall(env, { namespace: "ns", query: "test", role_id: "alice-001" } as any);
    expect(result.hits[0].id).toBe("high");
    expect(result.hits[1].id).toBe("low");
  });

  it("defaults to 1.3/1.1 when env vars not set", async () => {
    const env = createMockEnv(mockDb(), { ROLE_MEMORY_ENABLED: "true" });
    vi.mocked(searchMemories).mockResolvedValue([
      makeMemory({ id: "g", role_id: "alice-001", role_scope: "id:alice-001", score: 0.5 }),
    ]);
    mockFilterPassThrough();

    const result = await runRecall(env, { namespace: "ns", query: "test", role_id: "alice-001" } as any);
    const hit = result.hits.find((h) => h.id === "g");
    // 0.5 * 1.3 = 0.65
    expect(hit!.score).toBeCloseTo(0.65, 5);
  });
});
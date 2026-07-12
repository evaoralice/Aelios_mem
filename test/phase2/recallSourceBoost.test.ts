import { describe, it, expect, vi } from "vitest";
import { createMockD1, createMockEnv } from "../helpers/d1-mock";
import { runRecall } from "../../src/memory/v2/recall";

// Mock searchMemories to return controlled records with source field.
vi.mock("../../src/memory/search", () => ({
  searchMemories: vi.fn(),
  toMemoryApiRecord: (r: any) => r,
}));

// Mock filterAndCompressMemories to pass through with score.
vi.mock("../../src/memory/filter", () => ({
  filterAndCompressMemories: vi.fn(async (_env: any, input: { memories: any[] }) =>
    input.memories.map((m) => ({ ...m, score: m.score ?? 0.5 }))
  ),
}));

// Mock embedding (not used in these tests but imported).
vi.mock("../../src/memory/embedding", () => ({
  createEmbedding: vi.fn(async () => null),
}));

// Import the mocked modules to control return values.
import { searchMemories } from "../../src/memory/search";
import { filterAndCompressMemories } from "../../src/memory/filter";

function makeMemory(overrides: any = {}) {
  return {
    id: "m1",
    namespace: "ns",
    type: "fact",
    content: "test content",
    summary: null,
    importance: 0.7,
    confidence: 0.8,
    status: "active",
    pinned: false,
    tags: [],
    source: "extract",
    source_message_ids: [],
    vector_id: "v1",
    last_recalled_at: null,
    last_injected_at: null,
    recall_count: 0,
    created_at: "2025-01-01",
    updated_at: "2025-01-01",
    expires_at: null,
    score: 0.5,
    ...overrides,
  };
}

describe("recall source weighting (RECALL_SOURCE_BOOST)", () => {
  it("applies boost to source='mcp' memories when RECALL_SOURCE_BOOST=1.2", async () => {
    const db = createMockD1({
      onQuery: (sql) => {
        if (sql.includes("FROM digest")) return [];
        if (sql.includes("FROM precious")) return [];
        if (sql.includes("FROM glossary")) return [];
        return [];
      },
    });
    const env = createMockEnv(db, { RECALL_SOURCE_BOOST: "1.2" });

    vi.mocked(searchMemories).mockResolvedValue([
      makeMemory({ id: "a", source: "mcp", score: 0.5 }),
      makeMemory({ id: "b", source: "extract", score: 0.5 }),
    ]);
    vi.mocked(filterAndCompressMemories).mockResolvedValue([
      makeMemory({ id: "a", source: "mcp", score: 0.5 }),
      makeMemory({ id: "b", source: "extract", score: 0.5 }),
    ]);

    const result = await runRecall(env, { namespace: "ns", query: "test" });
    const hitA = result.hits.find((h) => h.id === "a");
    const hitB = result.hits.find((h) => h.id === "b");

    expect(hitA).toBeDefined();
    expect(hitB).toBeDefined();
    // mcp source should be boosted: 0.5 * 1.2 = 0.6
    expect(hitA!.score).toBeCloseTo(0.6, 5);
    // extract source should NOT be boosted: 0.5
    expect(hitB!.score).toBeCloseTo(0.5, 5);
  });

  it("applies boost to source='model' memories when RECALL_SOURCE_BOOST=1.2", async () => {
    const db = createMockD1({ onQuery: () => [] });
    const env = createMockEnv(db, { RECALL_SOURCE_BOOST: "1.2" });

    vi.mocked(searchMemories).mockResolvedValue([
      makeMemory({ id: "c", source: "model", score: 0.4 }),
    ]);
    vi.mocked(filterAndCompressMemories).mockResolvedValue([
      makeMemory({ id: "c", source: "model", score: 0.4 }),
    ]);

    const result = await runRecall(env, { namespace: "ns", query: "test" });
    const hit = result.hits.find((h) => h.id === "c");
    expect(hit).toBeDefined();
    // model source boosted: 0.4 * 1.2 = 0.48
    expect(hit!.score).toBeCloseTo(0.48, 5);
  });

  it("does NOT apply boost when RECALL_SOURCE_BOOST is not set (default 1.0)", async () => {
    const db = createMockD1({ onQuery: () => [] });
    const env = createMockEnv(db); // no RECALL_SOURCE_BOOST

    vi.mocked(searchMemories).mockResolvedValue([
      makeMemory({ id: "d", source: "mcp", score: 0.5 }),
    ]);
    vi.mocked(filterAndCompressMemories).mockResolvedValue([
      makeMemory({ id: "d", source: "mcp", score: 0.5 }),
    ]);

    const result = await runRecall(env, { namespace: "ns", query: "test" });
    const hit = result.hits.find((h) => h.id === "d");
    expect(hit).toBeDefined();
    // No boost: 0.5
    expect(hit!.score).toBeCloseTo(0.5, 5);
  });

  it("does NOT apply boost to source='extract' or 'dream'", async () => {
    const db = createMockD1({ onQuery: () => [] });
    const env = createMockEnv(db, { RECALL_SOURCE_BOOST: "1.2" });

    vi.mocked(searchMemories).mockResolvedValue([
      makeMemory({ id: "e1", source: "extract", score: 0.5 }),
      makeMemory({ id: "e2", source: "dream", score: 0.5 }),
    ]);
    vi.mocked(filterAndCompressMemories).mockResolvedValue([
      makeMemory({ id: "e1", source: "extract", score: 0.5 }),
      makeMemory({ id: "e2", source: "dream", score: 0.5 }),
    ]);

    const result = await runRecall(env, { namespace: "ns", query: "test" });
    const hit1 = result.hits.find((h) => h.id === "e1");
    const hit2 = result.hits.find((h) => h.id === "e2");
    expect(hit1?.score).toBeCloseTo(0.5, 5);
    expect(hit2?.score).toBeCloseTo(0.5, 5);
  });

  it("boosted memories rank higher than non-boosted with same base score", async () => {
    const db = createMockD1({ onQuery: () => [] });
    const env = createMockEnv(db, { RECALL_SOURCE_BOOST: "1.2" });

    vi.mocked(searchMemories).mockResolvedValue([
      makeMemory({ id: "low", source: "extract", score: 0.5 }),
      makeMemory({ id: "high", source: "mcp", score: 0.5 }),
    ]);
    vi.mocked(filterAndCompressMemories).mockResolvedValue([
      makeMemory({ id: "low", source: "extract", score: 0.5 }),
      makeMemory({ id: "high", source: "mcp", score: 0.5 }),
    ]);

    const result = await runRecall(env, { namespace: "ns", query: "test" });
    // high (mcp, boosted) should rank before low (extract, not boosted)
    expect(result.hits[0].id).toBe("high");
    expect(result.hits[1].id).toBe("low");
  });

  it("RECALL_SOURCE_BOOST value is read from env (e.g. 1.5)", async () => {
    const db = createMockD1({ onQuery: () => [] });
    const env = createMockEnv(db, { RECALL_SOURCE_BOOST: "1.5" });

    vi.mocked(searchMemories).mockResolvedValue([
      makeMemory({ id: "f", source: "mcp", score: 0.4 }),
    ]);
    vi.mocked(filterAndCompressMemories).mockResolvedValue([
      makeMemory({ id: "f", source: "mcp", score: 0.4 }),
    ]);

    const result = await runRecall(env, { namespace: "ns", query: "test" });
    const hit = result.hits.find((h) => h.id === "f");
    // 0.4 * 1.5 = 0.6
    expect(hit?.score).toBeCloseTo(0.6, 5);
  });
});

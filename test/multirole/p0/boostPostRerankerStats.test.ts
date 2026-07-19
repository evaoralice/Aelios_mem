import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockD1, createMockEnv } from "../../helpers/d1-mock";

vi.mock("../../../src/memory/search", () => ({
  searchMemories: vi.fn(async () => [] as any[]),
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

function makeMemory(overrides: any = {}): any {
  return {
    id: "m1", namespace: "ns", type: "fact", content: "test memory content here",
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

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(filterAndCompressMemories).mockImplementation(
    async (_env: any, input: { memories: any[] }) =>
      input.memories.map((m) => ({ ...m, score: m.score ?? 0.5 }))
  );
});

describe("#11: boost is only post-reranker and emits observable hit stats", () => {
  it("role_boosted_ids lists exactly the memories that got role boost", async () => {
    const env = createMockEnv(mockDb(), {
      ROLE_MEMORY_ENABLED: "true",
      RECALL_ROLE_BOOST_EXACT: "1.3",
    });
    vi.mocked(searchMemories).mockResolvedValue([
      makeMemory({ id: "a", role_id: "alice-001", role_scope: "id:alice-001", content: "alice 专属的猫猫喜好记忆详细描述" }),
      makeMemory({ id: "b", role_id: null, role_scope: "shared", content: "用户通用项目进展更新详细描述" }),
      makeMemory({ id: "c", role_id: "alice-001", role_scope: "id:alice-001", content: "alice 专属的另一个不同事实记忆" }),
    ]);

    const result = await runRecall(env, {
      namespace: "ns", query: "猫猫", role_id: "alice-001", role_name: "Alice",
    } as any);

    expect(result.meta.role_boosted_ids).toEqual(["a", "c"]);
    expect(result.meta.role_boost_factor).toBeCloseTo(1.3, 5);
    // shared hit not in boosted list
    expect(result.meta.role_boosted_ids).not.toContain("b");
  });

  it("role_boosted_ids is empty and factor=1 when no role in request", async () => {
    const env = createMockEnv(mockDb(), { ROLE_MEMORY_ENABLED: "true" });
    vi.mocked(searchMemories).mockResolvedValue([
      makeMemory({ id: "a", role_id: "alice-001", role_scope: "id:alice-001" }),
    ]);

    const result = await runRecall(env, { namespace: "ns", query: "test" } as any);
    expect(result.meta.role_boosted_ids).toEqual([]);
    expect(result.meta.role_boost_factor).toBe(1);
  });

  it("role_boosted_ids is empty when ROLE_MEMORY_ENABLED is false", async () => {
    const env = createMockEnv(mockDb(), {}); // no ROLE_MEMORY_ENABLED
    vi.mocked(searchMemories).mockResolvedValue([
      makeMemory({ id: "a", role_id: "alice-001", role_scope: "id:alice-001" }),
    ]);

    const result = await runRecall(env, { namespace: "ns", query: "test", role_id: "alice-001" } as any);
    expect(result.meta.role_boosted_ids).toEqual([]);
    expect(result.meta.role_boost_factor).toBe(1);
    // And the score was NOT multiplied by 1.3
    const hit = result.hits.find((h) => h.id === "a");
    expect(hit!.score).toBeCloseTo(0.5, 5);
  });

  it("raw_recall_count / post_rerank_count / final_injected_count are populated", async () => {
    const env = createMockEnv(mockDb(), { ROLE_MEMORY_ENABLED: "true" });
    vi.mocked(searchMemories).mockResolvedValue([
      makeMemory({ id: "a", role_id: "alice-001", role_scope: "id:alice-001", content: "alice 专属的猫猫喜好记忆详细描述" }),
      makeMemory({ id: "b", role_id: null, role_scope: "shared", content: "用户通用项目进展更新详细描述" }),
    ]);

    const result = await runRecall(env, {
      namespace: "ns", query: "猫猫", role_id: "alice-001", role_name: "Alice",
    } as any);

    expect(result.meta.raw_recall_count).toBe(2);
    expect(result.meta.post_rerank_count).toBe(2);
    expect(result.meta.final_injected_count).toBe(result.hits.length);
    expect(result.meta.final_injected_count).toBeGreaterThan(0);
  });

  it("boost is applied post-reranker: filterAndCompressMemories receives un-boosted scores", async () => {
    const env = createMockEnv(mockDb(), {
      ROLE_MEMORY_ENABLED: "true",
      RECALL_ROLE_BOOST_EXACT: "1.3",
    });
    const baseScore = 0.5;
    vi.mocked(searchMemories).mockResolvedValue([
      makeMemory({ id: "a", role_id: "alice-001", role_scope: "id:alice-001", score: baseScore }),
    ]);
    // Capture what filterAndCompressMemories receives
    let receivedScore: number | undefined;
    vi.mocked(filterAndCompressMemories).mockImplementation(
      async (_env: any, input: { memories: any[] }) => {
        receivedScore = input.memories[0]?.score;
        return input.memories.map((m) => ({ ...m, score: m.score ?? 0.5 }));
      }
    );

    const result = await runRecall(env, { namespace: "ns", query: "test", role_id: "alice-001" } as any);

    // filterAndCompressMemories (the reranker step) saw the un-boosted score
    expect(receivedScore).toBeCloseTo(baseScore, 5);
    // Final hit score has boost applied (0.5 * 1.3 = 0.65)
    const hit = result.hits.find((h) => h.id === "a");
    expect(hit!.score).toBeCloseTo(0.65, 5);
  });

  it("no pre-boost is applied — boost factor appears exactly once in final score", async () => {
    const env = createMockEnv(mockDb(), {
      ROLE_MEMORY_ENABLED: "true",
      RECALL_ROLE_BOOST_EXACT: "1.3",
    });
    vi.mocked(searchMemories).mockResolvedValue([
      makeMemory({ id: "a", role_id: "alice-001", role_scope: "id:alice-001", score: 0.5 }),
    ]);

    const result = await runRecall(env, { namespace: "ns", query: "test", role_id: "alice-001" } as any);
    const hit = result.hits.find((h) => h.id === "a");
    // If boost were applied twice (pre + post), score would be 0.5 * 1.3 * 1.3 = 0.845
    // Single post-reranker boost: 0.5 * 1.3 = 0.65
    expect(hit!.score).toBeCloseTo(0.65, 5);
    expect(hit!.score).not.toBeCloseTo(0.845, 5);
  });
});
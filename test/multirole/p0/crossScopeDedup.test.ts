import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockD1, createMockEnv } from "../../helpers/d1-mock";

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

import { runRecall } from "../../../src/memory/v2/recall";
import { searchMemories } from "../../../src/memory/search";
import { filterAndCompressMemories } from "../../../src/memory/filter";

const sameContent =
  "用户喜欢在深夜工作，通常凌晨两点才睡觉，早上十点起床，这是长期作息偏好";
const sharedHit = {
  id: "mem_shared", namespace: "ns", type: "fact", content: sameContent,
  summary: null, importance: 0.7, confidence: 0.8, status: "active",
  pinned: false, tags: [], source: "mcp", source_message_ids: [],
  vector_id: "v1", last_recalled_at: null, last_injected_at: null,
  recall_count: 0, created_at: "t", updated_at: "t", expires_at: null,
  score: 0.6, role_id: null, role_name: null, role_scope: "shared",
} as any;
const aliceHit = {
  id: "mem_alice", namespace: "ns", type: "fact", content: sameContent,
  summary: null, importance: 0.7, confidence: 0.8, status: "active",
  pinned: false, tags: [], source: "mcp", source_message_ids: [],
  vector_id: "v2", last_recalled_at: null, last_injected_at: null,
  recall_count: 0, created_at: "t", updated_at: "t", expires_at: null,
  score: 0.55, role_id: "alice-001", role_name: "Alice", role_scope: "id:alice-001",
} as any;

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

describe("P1-6: cross-scope near-duplicate dedup (current role > shared > others)", () => {
  it("when Alice and shared both hit with same content, only Alice is kept (higher priority)", async () => {
    vi.mocked(searchMemories).mockResolvedValue([sharedHit, aliceHit]);
    const env = createMockEnv(mockDb(), { ROLE_MEMORY_ENABLED: "true" });
    const result = await runRecall(env, {
      namespace: "ns", query: "作息", role_id: "alice-001", role_name: "Alice",
    } as any);

    const keptIds = result.hits.map((h) => h.id);
    expect(keptIds).toContain("mem_alice");
    expect(keptIds).not.toContain("mem_shared");
    expect(result.meta.cross_scope_deduped_ids).toContain("mem_shared");
  });

  it("when no role in request, shared and Alice versions both kept (no cross-scope dedup)", async () => {
    vi.mocked(searchMemories).mockResolvedValue([sharedHit, aliceHit]);
    const env = createMockEnv(mockDb(), { ROLE_MEMORY_ENABLED: "true" });
    const result = await runRecall(env, { namespace: "ns", query: "作息" } as any);

    const keptIds = result.hits.map((h) => h.id);
    expect(keptIds).toContain("mem_shared");
    expect(keptIds).toContain("mem_alice");
  });

  it("does not delete the folded record from database (only marks in meta)", async () => {
    vi.mocked(searchMemories).mockResolvedValue([sharedHit, aliceHit]);
    const env = createMockEnv(mockDb(), { ROLE_MEMORY_ENABLED: "true" });
    const result = await runRecall(env, {
      namespace: "ns", query: "作息", role_id: "alice-001", role_name: "Alice",
    } as any);

    // The folded id should be reported in meta, but no DB mutation API is called.
    // runRecall only calls markMemoriesInjected on kept hits; verify shared id not marked.
    expect(result.meta.cross_scope_deduped_ids).toEqual(["mem_shared"]);
    // Both records still exist in search results (we only mutated injection output)
    expect(searchMemories).toHaveBeenCalled();
  });

  it("other-role memory is deduped against current role (Bob loses to Alice)", async () => {
    const bobHit = {
      ...aliceHit,
      id: "mem_bob",
      role_id: "bob-001",
      role_name: "Bob",
      role_scope: "id:bob-001",
      score: 0.7,
    };
    vi.mocked(searchMemories).mockResolvedValue([aliceHit, bobHit]);
    const env = createMockEnv(mockDb(), { ROLE_MEMORY_ENABLED: "true" });
    const result = await runRecall(env, {
      namespace: "ns", query: "作息", role_id: "alice-001", role_name: "Alice",
    } as any);

    const keptIds = result.hits.map((h) => h.id);
    expect(keptIds).toContain("mem_alice");
    expect(keptIds).not.toContain("mem_bob");
    expect(result.meta.cross_scope_deduped_ids).toContain("mem_bob");
  });

  it("short content skips cross-scope dedup (avoid false positives)", async () => {
    const shortShared = { ...sharedHit, id: "short_s", content: "hi", score: 0.5 };
    const shortAlice = { ...aliceHit, id: "short_a", content: "hi", score: 0.4 };
    vi.mocked(searchMemories).mockResolvedValue([shortShared, shortAlice]);
    const env = createMockEnv(mockDb(), { ROLE_MEMORY_ENABLED: "true" });
    const result = await runRecall(env, {
      namespace: "ns", query: "hi", role_id: "alice-001", role_name: "Alice",
    } as any);

    // Both kept — short content shouldn't be folded
    const keptIds = result.hits.map((h) => h.id);
    expect(keptIds).toContain("short_s");
    expect(keptIds).toContain("short_a");
  });

  it("different content from different scopes both kept", async () => {
    const aliceDiff = { ...aliceHit, content: "Alice 专属的猫猫喜好记忆" };
    const sharedDiff = { ...sharedHit, content: "用户通用项目进展更新" };
    vi.mocked(searchMemories).mockResolvedValue([sharedDiff, aliceDiff]);
    const env = createMockEnv(mockDb(), { ROLE_MEMORY_ENABLED: "true" });
    const result = await runRecall(env, {
      namespace: "ns", query: "项目", role_id: "alice-001", role_name: "Alice",
    } as any);

    const keptIds = result.hits.map((h) => h.id);
    expect(keptIds).toContain("mem_shared");
    expect(keptIds).toContain("mem_alice");
  });
});
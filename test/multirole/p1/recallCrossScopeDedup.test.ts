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
    id: "m1", namespace: "ns", type: "fact", content: "test memory",
    summary: null, importance: 0.7, confidence: 0.8, status: "active",
    pinned: false, tags: [], source: "extract", source_message_ids: [],
    vector_id: "v1", last_recalled_at: null, last_injected_at: null,
    recall_count: 0, created_at: "2025-01-01", updated_at: "2025-01-01",
    expires_at: null, score: 0.5,
    role_id: null, role_name: null, role_scope: "shared",
    ...overrides,
  };
}

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

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(searchMemories).mockResolvedValue([]);
  mockFilterPassThrough();
});

describe("P1-6: cross-scope near-duplicate dedup (current role > shared > other)", () => {
  it("keeps current-role version when shared has near-duplicate content", async () => {
    const env = createMockEnv(mockDb(), { ROLE_MEMORY_ENABLED: "true" });
    const sharedContent = "用户偏好早起工作，每天凌晨四点起床开始写代码，作息非常规律";
    const aliceContent = "用户偏好早起工作，每天凌晨四点起床开始写代码，作息非常规律";
    vi.mocked(searchMemories).mockResolvedValue([
      makeMemory({ id: "alice_v", role_id: "alice-001", role_scope: "id:alice-001", score: 0.5, content: aliceContent }),
      makeMemory({ id: "shared_v", role_id: null, role_scope: "shared", score: 0.5, content: sharedContent }),
    ]);

    const result = await runRecall(env, { namespace: "ns", query: "作息", role_id: "alice-001" } as any);
    expect(result.hits.find((h) => h.id === "alice_v")).toBeTruthy();
    expect(result.hits.find((h) => h.id === "shared_v")).toBeFalsy();
    expect(result.meta.cross_scope_deduped_ids).toContain("shared_v");
  });

  it("keeps shared version when other-role (non-current) has near-duplicate", async () => {
    const env = createMockEnv(mockDb(), { ROLE_MEMORY_ENABLED: "true" });
    const content = "用户喜欢用 Python 写脚本做日常自动化任务";
    vi.mocked(searchMemories).mockResolvedValue([
      makeMemory({ id: "bob_v", role_id: "bob-001", role_scope: "id:bob-001", score: 0.5, content }),
      makeMemory({ id: "shared_v", role_id: null, role_scope: "shared", score: 0.5, content }),
    ]);

    const result = await runRecall(env, { namespace: "ns", query: "Python", role_id: "alice-001" } as any);
    expect(result.hits.find((h) => h.id === "shared_v")).toBeTruthy();
    expect(result.hits.find((h) => h.id === "bob_v")).toBeFalsy();
    expect(result.meta.cross_scope_deduped_ids).toContain("bob_v");
  });

  it("keeps both when contents are clearly different", async () => {
    const env = createMockEnv(mockDb(), { ROLE_MEMORY_ENABLED: "true" });
    vi.mocked(searchMemories).mockResolvedValue([
      makeMemory({ id: "alice_v", role_id: "alice-001", role_scope: "id:alice-001", score: 0.5, content: "Alice 自己的承诺是每天陪用户练习钢琴" }),
      makeMemory({ id: "shared_v", role_id: null, role_scope: "shared", score: 0.5, content: "用户工作日早上九点开站会，团队有五个人" }),
    ]);

    const result = await runRecall(env, { namespace: "ns", query: "工作", role_id: "alice-001" } as any);
    expect(result.hits.find((h) => h.id === "alice_v")).toBeTruthy();
    expect(result.hits.find((h) => h.id === "shared_v")).toBeTruthy();
    expect(result.meta.cross_scope_deduped_ids ?? []).toHaveLength(0);
  });

  it("does not dedup cross-scope when ROLE_MEMORY_ENABLED is false", async () => {
    const env = createMockEnv(mockDb(), {});
    const content = "用户偏好早起工作，每天凌晨四点起床开始写代码，作息非常规律";
    vi.mocked(searchMemories).mockResolvedValue([
      makeMemory({ id: "alice_v", role_id: "alice-001", role_scope: "id:alice-001", score: 0.5, content }),
      makeMemory({ id: "shared_v", role_id: null, role_scope: "shared", score: 0.5, content }),
    ]);

    const result = await runRecall(env, { namespace: "ns", query: "作息", role_id: "alice-001" } as any);
    expect(result.hits.find((h) => h.id === "alice_v")).toBeTruthy();
    expect(result.hits.find((h) => h.id === "shared_v")).toBeTruthy();
  });

  it("does not dedup cross-scope when request has no role_id", async () => {
    const env = createMockEnv(mockDb(), { ROLE_MEMORY_ENABLED: "true" });
    const content = "用户偏好早起工作，每天凌晨四点起床开始写代码，作息非常规律";
    vi.mocked(searchMemories).mockResolvedValue([
      makeMemory({ id: "alice_v", role_id: "alice-001", role_scope: "id:alice-001", score: 0.5, content }),
      makeMemory({ id: "shared_v", role_id: null, role_scope: "shared", score: 0.5, content }),
    ]);

    const result = await runRecall(env, { namespace: "ns", query: "作息" } as any);
    expect(result.hits.find((h) => h.id === "alice_v")).toBeTruthy();
    expect(result.hits.find((h) => h.id === "shared_v")).toBeTruthy();
  });

  it("other-role memory is deduped against current role (Bob loses to Alice)", async () => {
    const env = createMockEnv(mockDb(), { ROLE_MEMORY_ENABLED: "true" });
    const content = "用户喜欢在深夜工作，通常凌晨两点才睡觉，早上十点起床，这是长期作息偏好";
    vi.mocked(searchMemories).mockResolvedValue([
      makeMemory({ id: "alice_v", role_id: "alice-001", role_scope: "id:alice-001", score: 0.5, content }),
      makeMemory({ id: "bob_v", role_id: "bob-001", role_scope: "id:bob-001", score: 0.7, content }),
    ]);

    const result = await runRecall(env, {
      namespace: "ns", query: "作息", role_id: "alice-001", role_name: "Alice",
    } as any);
    expect(result.hits.find((h) => h.id === "alice_v")).toBeTruthy();
    expect(result.hits.find((h) => h.id === "bob_v")).toBeFalsy();
    expect(result.meta.cross_scope_deduped_ids).toContain("bob_v");
  });

  it("short content skips cross-scope dedup (avoid false positives)", async () => {
    const env = createMockEnv(mockDb(), { ROLE_MEMORY_ENABLED: "true" });
    vi.mocked(searchMemories).mockResolvedValue([
      makeMemory({ id: "short_s", role_id: null, role_scope: "shared", score: 0.5, content: "hi" }),
      makeMemory({ id: "short_a", role_id: "alice-001", role_scope: "id:alice-001", score: 0.4, content: "hi" }),
    ]);

    const result = await runRecall(env, {
      namespace: "ns", query: "hi", role_id: "alice-001", role_name: "Alice",
    } as any);
    expect(result.hits.find((h) => h.id === "short_s")).toBeTruthy();
    expect(result.hits.find((h) => h.id === "short_a")).toBeTruthy();
  });
});
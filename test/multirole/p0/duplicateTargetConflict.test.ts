import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockD1, createMockEnv } from "../../helpers/d1-mock";

vi.mock("../../../src/memory/vectorStore", () => ({
  searchVectorMemories: vi.fn(async () => []),
  createVectorMemory: vi.fn(async () => ({})),
  deleteVectorMemory: vi.fn(async () => true),
  getVectorMemory: vi.fn(async () => null),
  listVectorMemories: vi.fn(async () => ({ data: [], cursor: null, hasMore: false })),
  updateVectorMemory: vi.fn(async () => ({})),
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
vi.mock("../../../src/db/retention", () => ({
  readCursor: vi.fn(async () => null),
  writeCursor: vi.fn(async () => {}),
}));

const listMessagesByNamespaceInRange = vi.fn<(...args: any[]) => Promise<any[]>>(async () => [] as any[]);
vi.mock("../../../src/db/messages", () => ({
  listMessagesByNamespaceInRange: (...args: any[]) => listMessagesByNamespaceInRange(...args),
}));

const listMemoriesPage = vi.fn<(...args: any[]) => Promise<any>>(async () => ({ records: [], hasMore: false, nextOffset: 0 }));
vi.mock("../../../src/db/memories", () => ({
  listMemoriesPage: (...args: any[]) => listMemoriesPage(...args),
}));

const callOpenAICompat = vi.fn<(...args: any[]) => Promise<Response>>(async () => new Response("{}", { status: 200 }));
vi.mock("../../../src/proxy/openaiAdapter", () => ({
  callOpenAICompat: (...args: any[]) => callOpenAICompat(...args),
}));

const upsertDailyLog = vi.fn<(...args: any[]) => Promise<any>>(async () => ({}));
const upsertBaseline = vi.fn<(...args: any[]) => Promise<any>>(async () => ({}));
const upsertDigest = vi.fn<(...args: any[]) => Promise<any>>(async () => ({}));
const listPendingChangelog = vi.fn<(...args: any[]) => Promise<any[]>>(async () => [] as any[]);
const markChangelogApplied = vi.fn<(...args: any[]) => Promise<void>>(async () => {});
const markChangelogConflict = vi.fn<(...args: any[]) => Promise<void>>(async () => {});
const getBaselines = vi.fn<(...args: any[]) => Promise<any[]>>(async () => [] as any[]);
const getDailyLog = vi.fn<(...args: any[]) => Promise<any>>(async () => null);
const fetchMemoryLifecycleRows = vi.fn<(...args: any[]) => Promise<any[]>>(async () => [] as any[]);
const upsertMemoryByFactKey = vi.fn<(...args: any[]) => Promise<any>>(async () => ({}));
const supersedeMemory = vi.fn<(...args: any[]) => Promise<any>>(async () => ({}));
const archiveMemory = vi.fn<(...args: any[]) => Promise<boolean>>(async () => true);
const createLongtail = vi.fn<(...args: any[]) => Promise<any>>(async () => ({ id: "lt1" }));
const upsertLongtailEmbedding = vi.fn<(...args: any[]) => Promise<void>>(async () => {});
vi.mock("../../../src/db/v2", async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    upsertMemoryByFactKey: (...args: any[]) => upsertMemoryByFactKey(...args),
    supersedeMemory: (...args: any[]) => supersedeMemory(...args),
    archiveMemory: (...args: any[]) => archiveMemory(...args),
    upsertDigest: (...args: any[]) => upsertDigest(...args),
    createLongtail: (...args: any[]) => createLongtail(...args),
    upsertDailyLog: (...args: any[]) => upsertDailyLog(...args),
    upsertBaseline: (...args: any[]) => upsertBaseline(...args),
    fetchMemoryLifecycleRows: (...args: any[]) => fetchMemoryLifecycleRows(...args),
    listPendingChangelog: (...args: any[]) => listPendingChangelog(...args),
    markChangelogApplied: (...args: any[]) => markChangelogApplied(...args),
    markChangelogConflict: (...args: any[]) => markChangelogConflict(...args),
    getBaselines: (...args: any[]) => getBaselines(...args),
    getDailyLog: (...args: any[]) => getDailyLog(...args),
  };
});

import { getVectorMemory } from "../../../src/memory/vectorStore";
import { runDailyMemoryDigest } from "../../../src/memory/dailyDigest";

function mkMsg(id: string, roleId: string | null, roleName: string | null, content: string, createdAt: string): any {
  return { id, namespace: "ns", role: "user", role_id: roleId, role_name: roleName, content, created_at: createdAt };
}

function makeResponseJson(json: unknown): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(json) }, finish_reason: "stop" }],
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function mkExistingMemory(id: string, scope: string, roleId: string, roleName: string): any {
  return { id, namespace: "ns", status: "active", pinned: false, role_id: roleId, role_name: roleName, content: `${id} content` };
}

beforeEach(() => {
  vi.clearAllMocks();
  listMessagesByNamespaceInRange.mockResolvedValue([]);
  listMemoriesPage.mockResolvedValue({ records: [], hasMore: false, nextOffset: 0 });
  callOpenAICompat.mockResolvedValue(new Response("{}", { status: 200 }));
  listPendingChangelog.mockResolvedValue([]);
  getBaselines.mockResolvedValue([]);
  getDailyLog.mockResolvedValue(null);
  (getVectorMemory as any).mockResolvedValue(null);
});

function mkEnv() {
  return createMockEnv(createMockD1(), {
    ROLE_MEMORY_ENABLED: "true",
    MEMORY_LIFECYCLE_ENABLED: "true",
    DREAM_MODEL: "test-model",
    ENABLE_DREAM: "true",
  });
}

describe("P1 重复 target 检测真正阻止执行", () => {
  it("同组重复 update 同一 target：只执行 0 次（冲突，全部跳过）", async () => {
    listMessagesByNamespaceInRange.mockResolvedValue([
      mkMsg("m1", "alice", "Alice", "hi", "2025-07-18T01:00:00.000Z"),
    ]);
    (getVectorMemory as any).mockImplementation(async (_env: any, id: string) => {
      if (id === "mem_a") return mkExistingMemory("mem_a", "id:alice", "alice", "Alice");
      return null;
    });
    callOpenAICompat.mockResolvedValue(makeResponseJson({
      groups: [
        {
          role_scope: "id:alice",
          daily_log: { title: "Alice", summary: "- hi" },
          baseline: "Alice baseline",
          memories_to_update: [
            { target_id: "mem_a", content: "v1", type: "fact", importance: 0.8 },
            { target_id: "mem_a", content: "v2", type: "fact", importance: 0.9 },
          ],
          memories_to_delete: [],
        },
      ],
    }));

    const result = await runDailyMemoryDigest(mkEnv(), "ns", { dateLabel: "2025-07-18", force: true });
    expect(result.ran).toBe(true);
    // 重复 update 视为冲突，两个都不执行
    expect(upsertMemoryByFactKey).not.toHaveBeenCalled();
    expect(supersedeMemory).not.toHaveBeenCalled();
  });

  it("Alice/Bob group 对同一 target 操作：不得执行（跨 group 重复也阻止）", async () => {
    // 模拟 Alice 和 Bob 都对 mem_shared 操作 — 但实际 mem_shared 属于某 scope，
    // 这里测跨 group 重复 target 即冲突，无论 scope 是否匹配都跳过
    listMessagesByNamespaceInRange.mockResolvedValue([
      mkMsg("m1", "alice", "Alice", "hi", "2025-07-18T01:00:00.000Z"),
      mkMsg("m2", "bob", "Bob", "hello", "2025-07-18T02:00:00.000Z"),
    ]);
    (getVectorMemory as any).mockImplementation(async (_env: any, id: string) => {
      if (id === "mem_x") return mkExistingMemory("mem_x", "id:alice", "alice", "Alice");
      return null;
    });
    callOpenAICompat.mockResolvedValue(makeResponseJson({
      groups: [
        {
          role_scope: "id:alice",
          daily_log: { title: "Alice", summary: "- hi" },
          baseline: "Alice baseline",
          memories_to_update: [{ target_id: "mem_x", content: "Alice 改", type: "fact", importance: 0.8 }],
          memories_to_delete: [],
        },
        {
          role_scope: "id:bob",
          daily_log: { title: "Bob", summary: "- hello" },
          baseline: "Bob baseline",
          memories_to_update: [{ target_id: "mem_x", content: "Bob 改", type: "fact", importance: 0.7 }],
          memories_to_delete: [],
        },
      ],
    }));

    const result = await runDailyMemoryDigest(mkEnv(), "ns", { dateLabel: "2025-07-18", force: true });
    expect(result.ran).toBe(true);
    // mem_x 被两个 group 同时 update，冲突，都不执行
    expect(upsertMemoryByFactKey).not.toHaveBeenCalled();
    expect(supersedeMemory).not.toHaveBeenCalled();
  });

  it("同 target 同时 update + delete：两个都不执行，目标保持 active", async () => {
    listMessagesByNamespaceInRange.mockResolvedValue([
      mkMsg("m1", "alice", "Alice", "hi", "2025-07-18T01:00:00.000Z"),
    ]);
    (getVectorMemory as any).mockImplementation(async (_env: any, id: string) => {
      if (id === "mem_a") return mkExistingMemory("mem_a", "id:alice", "alice", "Alice");
      return null;
    });
    callOpenAICompat.mockResolvedValue(makeResponseJson({
      groups: [
        {
          role_scope: "id:alice",
          daily_log: { title: "Alice", summary: "- hi" },
          baseline: "Alice baseline",
          memories_to_update: [{ target_id: "mem_a", content: "改", type: "fact", importance: 0.8 }],
          memories_to_delete: [{ target_id: "mem_a", reason: "又改又删" }],
        },
      ],
    }));

    const result = await runDailyMemoryDigest(mkEnv(), "ns", { dateLabel: "2025-07-18", force: true });
    expect(result.ran).toBe(true);
    // update + delete 同 target 视为冲突，两个都不执行
    expect(upsertMemoryByFactKey).not.toHaveBeenCalled();
    expect(supersedeMemory).not.toHaveBeenCalled();
    expect(archiveMemory).not.toHaveBeenCalled();
  });

  it("单次 update（无冲突）：正常执行", async () => {
    listMessagesByNamespaceInRange.mockResolvedValue([
      mkMsg("m1", "alice", "Alice", "hi", "2025-07-18T01:00:00.000Z"),
    ]);
    (getVectorMemory as any).mockImplementation(async (_env: any, id: string) => {
      if (id === "mem_a") return mkExistingMemory("mem_a", "id:alice", "alice", "Alice");
      return null;
    });
    fetchMemoryLifecycleRows.mockResolvedValue([{ fact_key: "fk_a" }]);
    callOpenAICompat.mockResolvedValue(makeResponseJson({
      groups: [
        {
          role_scope: "id:alice",
          daily_log: { title: "Alice", summary: "- hi" },
          baseline: "Alice baseline",
          memories_to_update: [{ target_id: "mem_a", content: "改后", type: "fact", importance: 0.8 }],
          memories_to_delete: [],
        },
      ],
    }));

    const result = await runDailyMemoryDigest(mkEnv(), "ns", { dateLabel: "2025-07-18", force: true });
    expect(result.ran).toBe(true);
    // 单次无冲突，应执行一次 update
    expect(upsertMemoryByFactKey).toHaveBeenCalledTimes(1);
    expect(archiveMemory).not.toHaveBeenCalled();
  });

  it("单次 delete（无冲突）：正常执行", async () => {
    listMessagesByNamespaceInRange.mockResolvedValue([
      mkMsg("m1", "alice", "Alice", "hi", "2025-07-18T01:00:00.000Z"),
    ]);
    (getVectorMemory as any).mockImplementation(async (_env: any, id: string) => {
      if (id === "mem_a") return mkExistingMemory("mem_a", "id:alice", "alice", "Alice");
      return null;
    });
    callOpenAICompat.mockResolvedValue(makeResponseJson({
      groups: [
        {
          role_scope: "id:alice",
          daily_log: { title: "Alice", summary: "- hi" },
          baseline: "Alice baseline",
          memories_to_update: [],
          memories_to_delete: [{ target_id: "mem_a", reason: "过时" }],
        },
      ],
    }));

    const result = await runDailyMemoryDigest(mkEnv(), "ns", { dateLabel: "2025-07-18", force: true });
    expect(result.ran).toBe(true);
    // 单次无冲突，应执行一次 delete
    expect(archiveMemory).toHaveBeenCalledTimes(1);
    expect(upsertMemoryByFactKey).not.toHaveBeenCalled();
  });
});
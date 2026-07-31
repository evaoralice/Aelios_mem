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

describe("DREAM_WRITE_DAILY_LOG 开关", () => {
  it("默认（未设置）：per-role 路径正常写 daily_log", async () => {
    listMessagesByNamespaceInRange.mockResolvedValue([
      mkMsg("m1", "alice", "Alice", "hi", "2025-07-18T01:00:00.000Z"),
    ]);
    callOpenAICompat.mockResolvedValue(makeResponseJson({
      groups: [
        {
          role_scope: "id:alice",
          daily_log: { title: "Alice", summary: "- Alice 互动" },
          baseline: "Alice 基线",
          memories_to_update: [],
          memories_to_delete: [],
        },
      ],
    }));

    const env = createMockEnv(createMockD1(), {
      ROLE_MEMORY_ENABLED: "true",
      MEMORY_LIFECYCLE_ENABLED: "true",
      DREAM_MODEL: "test-model",
      ENABLE_DREAM: "true",
    });

    const result = await runDailyMemoryDigest(env, "ns", { dateLabel: "2025-07-18", force: true });
    expect(result.ran).toBe(true);
    expect(upsertDailyLog).toHaveBeenCalled();
    const write = upsertDailyLog.mock.calls.find((c: any) => c[1].roleScope === "id:alice");
    expect(write).toBeTruthy();
  });

  it("设为 false：per-role 路径跳过 daily_log 写入（digest/baseline 不受影响）", async () => {
    listMessagesByNamespaceInRange.mockResolvedValue([
      mkMsg("m1", "alice", "Alice", "hi", "2025-07-18T01:00:00.000Z"),
    ]);
    callOpenAICompat.mockResolvedValue(makeResponseJson({
      title: "should-not-write",
      summary: "- digest 仍写",
      groups: [
        {
          role_scope: "id:alice",
          daily_log: { title: "Alice", summary: "- Alice 互动" },
          baseline: "Alice 基线",
          memories_to_update: [],
          memories_to_delete: [],
        },
      ],
    }));

    const env = createMockEnv(createMockD1(), {
      ROLE_MEMORY_ENABLED: "true",
      MEMORY_LIFECYCLE_ENABLED: "true",
      DREAM_MODEL: "test-model",
      ENABLE_DREAM: "true",
      DREAM_WRITE_DAILY_LOG: "false",
    });

    const result = await runDailyMemoryDigest(env, "ns", { dateLabel: "2025-07-18", force: true });
    expect(result.ran).toBe(true);

    // daily_log 不应被写
    expect(upsertDailyLog).not.toHaveBeenCalled();
    // baseline 仍正常写（pending changelog 路径不受影响，这里无 pending，故只验证 upsertDailyLog 被跳过）
  });

  it("设为 false：非角色路径跳过 shared daily_log 写入", async () => {
    listMessagesByNamespaceInRange.mockResolvedValue([
      mkMsg("m1", null, null, "互动", "2025-07-18T01:00:00.000Z"),
    ]);
    callOpenAICompat.mockResolvedValue(makeResponseJson({
      title: "shared 日",
      summary: "- shared 互动",
      sections: [],
      important_excerpts: [],
      memories_to_add: [],
      memories_to_update: [],
      memories_to_delete: [],
    }));

    const env = createMockEnv(createMockD1(), {
      MEMORY_LIFECYCLE_ENABLED: "true",
      DREAM_MODEL: "test-model",
      ENABLE_DREAM: "true",
      DREAM_WRITE_DAILY_LOG: "false",
    });

    const result = await runDailyMemoryDigest(env, "ns", { dateLabel: "2025-07-18", force: true });
    expect(result.ran).toBe(true);

    // shared daily_log 不应被写
    const sharedWrite = upsertDailyLog.mock.calls.find((c: any) => c[1].roleScope === "shared");
    expect(sharedWrite).toBeUndefined();
    expect(upsertDailyLog).not.toHaveBeenCalled();
    // digest 仍写（非角色路径且有 summary 时 upsertDigest 应被调用）
    expect(upsertDigest).toHaveBeenCalled();
  });

  it("设为 true（显式）：per-role 路径正常写 daily_log", async () => {
    listMessagesByNamespaceInRange.mockResolvedValue([
      mkMsg("m1", "alice", "Alice", "hi", "2025-07-18T01:00:00.000Z"),
    ]);
    callOpenAICompat.mockResolvedValue(makeResponseJson({
      groups: [
        {
          role_scope: "id:alice",
          daily_log: { title: "Alice", summary: "- Alice 互动" },
          baseline: "Alice 基线",
          memories_to_update: [],
          memories_to_delete: [],
        },
      ],
    }));

    const env = createMockEnv(createMockD1(), {
      ROLE_MEMORY_ENABLED: "true",
      MEMORY_LIFECYCLE_ENABLED: "true",
      DREAM_MODEL: "test-model",
      ENABLE_DREAM: "true",
      DREAM_WRITE_DAILY_LOG: "true",
    });

    const result = await runDailyMemoryDigest(env, "ns", { dateLabel: "2025-07-18", force: true });
    expect(result.ran).toBe(true);
    expect(upsertDailyLog).toHaveBeenCalled();
  });
});
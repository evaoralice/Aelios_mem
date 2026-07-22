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

function mkEnv() {
  return createMockEnv(createMockD1(), {
    ROLE_MEMORY_ENABLED: "true",
    MEMORY_LIFECYCLE_ENABLED: "true",
    DREAM_MODEL: "test-model",
    ENABLE_DREAM: "true",
  });
}

describe("P1 Dream 输出角色组写入白名单校验", () => {
  it("只有 Alice 输入，模型输出 Bob group：Bob 日记和 baseline 均不写入", async () => {
    listMessagesByNamespaceInRange.mockResolvedValue([
      mkMsg("m1", "alice", "Alice", "hi", "2025-07-18T01:00:00.000Z"),
    ]);
    callOpenAICompat.mockResolvedValue(makeResponseJson({
      groups: [
        {
          role_scope: "id:alice",
          daily_log: { title: "Alice 当天", summary: "- Alice 互动" },
          baseline: "Alice 基线",
          memories_to_update: [],
          memories_to_delete: [],
        },
        {
          role_scope: "id:bob",
          daily_log: { title: "Bob 凭空", summary: "- Bob 凭空内容" },
          baseline: "Bob 凭空基线",
          memories_to_update: [],
          memories_to_delete: [],
        },
      ],
    }));

    const result = await runDailyMemoryDigest(mkEnv(), "ns", { dateLabel: "2025-07-18", force: true });
    expect(result.ran).toBe(true);

    const bobDailyWrite = upsertDailyLog.mock.calls.find((c: any) => c[1].roleScope === "id:bob");
    const bobBaselineWrite = upsertBaseline.mock.calls.find((c: any) => c[1].roleScope === "id:bob");
    expect(bobDailyWrite).toBeUndefined();
    expect(bobBaselineWrite).toBeUndefined();

    // Alice 仍应正常写入
    const aliceDailyWrite = upsertDailyLog.mock.calls.find((c: any) => c[1].roleScope === "id:alice");
    expect(aliceDailyWrite).toBeTruthy();
  });

  it("Alice group 重复两次：只接受第一个，第二个跳过", async () => {
    listMessagesByNamespaceInRange.mockResolvedValue([
      mkMsg("m1", "alice", "Alice", "hi", "2025-07-18T01:00:00.000Z"),
    ]);
    callOpenAICompat.mockResolvedValue(makeResponseJson({
      groups: [
        {
          role_scope: "id:alice",
          daily_log: { title: "第一版", summary: "- 第一版要点" },
          baseline: "Alice 基线1",
          memories_to_update: [],
          memories_to_delete: [],
        },
        {
          role_scope: "id:alice",
          daily_log: { title: "第二版", summary: "- 第二版要点" },
          baseline: "Alice 基线2",
          memories_to_update: [],
          memories_to_delete: [],
        },
      ],
    }));

    const result = await runDailyMemoryDigest(mkEnv(), "ns", { dateLabel: "2025-07-18", force: true });
    expect(result.ran).toBe(true);

    const aliceDailyWrites = upsertDailyLog.mock.calls.filter((c: any) => c[1].roleScope === "id:alice");
    expect(aliceDailyWrites.length).toBe(1);
    expect((aliceDailyWrites[0] as any)[1].summary).toContain("第一版要点");
    // baseline 不再由做梦写入
    expect(upsertBaseline).not.toHaveBeenCalled();
  });

  it("模型漏掉 Alice：不得清空 Alice 原有日记或 baseline", async () => {
    listMessagesByNamespaceInRange.mockResolvedValue([
      mkMsg("m1", "alice", "Alice", "hi", "2025-07-18T01:00:00.000Z"),
    ]);
    // 模型只输出 Bob（漏掉 Alice）
    callOpenAICompat.mockResolvedValue(makeResponseJson({
      groups: [
        {
          role_scope: "id:bob",
          daily_log: { title: "Bob", summary: "- Bob 互动" },
          baseline: "Bob 基线",
          memories_to_update: [],
          memories_to_delete: [],
        },
      ],
    }));

    const result = await runDailyMemoryDigest(mkEnv(), "ns", { dateLabel: "2025-07-18", force: true });
    expect(result.ran).toBe(true);

    // 不应对 Alice 做任何 upsert（既不写 daily_log 也不写 baseline）
    const aliceDailyWrite = upsertDailyLog.mock.calls.find((c: any) => c[1].roleScope === "id:alice");
    const aliceBaselineWrite = upsertBaseline.mock.calls.find((c: any) => c[1].roleScope === "id:alice");
    expect(aliceDailyWrite).toBeUndefined();
    expect(aliceBaselineWrite).toBeUndefined();
    // Bob 也不应写入（不在 allowed scopes）
    const bobDailyWrite = upsertDailyLog.mock.calls.find((c: any) => c[1].roleScope === "id:bob");
    expect(bobDailyWrite).toBeUndefined();
  });

  it("未提供 shared group 时，模型输出 shared：不得写入", async () => {
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
        {
          role_scope: "shared",
          daily_log: { title: "凭空 shared", summary: "- shared 凭空" },
          baseline: "shared 凭空基线",
          memories_to_update: [],
          memories_to_delete: [],
        },
      ],
    }));

    const result = await runDailyMemoryDigest(mkEnv(), "ns", { dateLabel: "2025-07-18", force: true });
    expect(result.ran).toBe(true);

    // shared 不在 allowed scopes（本次只构造了 id:alice roleGroup）
    const sharedDailyWrite = upsertDailyLog.mock.calls.find((c: any) => c[1].roleScope === "shared");
    const sharedBaselineWrite = upsertBaseline.mock.calls.find((c: any) => c[1].roleScope === "shared");
    expect(sharedDailyWrite).toBeUndefined();
    expect(sharedBaselineWrite).toBeUndefined();
  });
});
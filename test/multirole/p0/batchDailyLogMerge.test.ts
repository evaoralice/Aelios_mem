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

describe("P0 同日分批日记合并", () => {
  it("非首批：prompt 能看到已有当日日记（单角色）", async () => {
    // 第一批已写入 daily_log；第二批跑时 getDailyLog 返回已有内容
    getDailyLog.mockResolvedValue({
      namespace: "ns", role_scope: "id:alice", date: "2025-07-18",
      title: "上午互动", summary: "- 上午聊了天气\n- 用户提到要出门",
      updated_at: "t1",
    });
    listMessagesByNamespaceInRange.mockResolvedValue([
      mkMsg("m3", "alice", "Alice", "下午好", "2025-07-18T13:00:00.000Z"),
    ]);
    callOpenAICompat.mockResolvedValue(makeResponseJson({
      groups: [
        {
          role_scope: "id:alice",
          daily_log: { title: "全天互动", summary: "- 上午聊了天气\n- 用户提到要出门\n- 下午打了招呼" },
          baseline: "Alice 旧基线继承",
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

    // 模型 prompt 应包含已有日记的两个要点
    const promptArg = callOpenAICompat.mock.calls[0][1] as any;
    const prompt = typeof promptArg === "string" ? promptArg : JSON.stringify(promptArg);
    // callOpenAICompat signature: (req, body) — body is the request body; prompt is in body.messages
    // Easier: scan all call args for the existing log text
    const allArgs = JSON.stringify(callOpenAICompat.mock.calls);
    expect(allArgs).toContain("上午聊了天气");
    expect(allArgs).toContain("用户提到要出门");
    expect(allArgs).toContain("已有当日日记");
  });

  it("非首批 upsertDailyLog 写入合并版（含前批要点 + 本批要点）", async () => {
    getDailyLog.mockResolvedValue({
      namespace: "ns", role_scope: "id:alice", date: "2025-07-18",
      title: "上午互动", summary: "- 上午聊了天气",
      updated_at: "t1",
    });
    listMessagesByNamespaceInRange.mockResolvedValue([
      mkMsg("m3", "alice", "Alice", "下午好", "2025-07-18T13:00:00.000Z"),
    ]);
    const mergedSummary = "- 上午聊了天气\n- 下午打了招呼";
    callOpenAICompat.mockResolvedValue(makeResponseJson({
      groups: [
        {
          role_scope: "id:alice",
          daily_log: { title: "全天互动", summary: mergedSummary },
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

    // upsertDailyLog 应被调用，写入的是合并版（含两个要点）
    expect(upsertDailyLog).toHaveBeenCalled();
    const writeCall = upsertDailyLog.mock.calls[0][1] as any;
    expect(writeCall.roleScope).toBe("id:alice");
    expect(writeCall.summary).toContain("上午聊了天气");
    expect(writeCall.summary).toContain("下午打了招呼");
  });

  it("首批：没有已有日记，prompt 标注“本批是首批”", async () => {
    getDailyLog.mockResolvedValue(null);
    listMessagesByNamespaceInRange.mockResolvedValue([
      mkMsg("m1", "alice", "Alice", "hi", "2025-07-18T01:00:00.000Z"),
    ]);
    callOpenAICompat.mockResolvedValue(makeResponseJson({
      groups: [
        {
          role_scope: "id:alice",
          daily_log: { title: "首批", summary: "- 打了招呼" },
          baseline: "Alice 首版基线",
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

    const allArgs = JSON.stringify(callOpenAICompat.mock.calls);
    expect(allArgs).toContain("本批是首批");
    // 首批不应出现"已有当日日记（本批不是首批"这种合并引导语
    expect(allArgs).not.toContain("已有当日日记（本批不是首批");
  });

  it("Alice 与 Bob 分批：各自只合并自己的日记，不串内容", async () => {
    // Alice 已有日记，Bob 没有
    getDailyLog.mockImplementation(async (_db: any, input: any) => {
      if (input.roleScope === "id:alice") {
        return { namespace: "ns", role_scope: "id:alice", date: "2025-07-18",
          title: "Alice 上午", summary: "- Alice 上午要点", updated_at: "t1" };
      }
      return null;
    });
    listMessagesByNamespaceInRange.mockResolvedValue([
      mkMsg("m3", "alice", "Alice", "Alice 下午", "2025-07-18T13:00:00.000Z"),
      mkMsg("m4", "bob", "Bob", "Bob 下午", "2025-07-18T14:00:00.000Z"),
    ]);
    callOpenAICompat.mockResolvedValue(makeResponseJson({
      groups: [
        {
          role_scope: "id:alice",
          daily_log: { title: "Alice 全天", summary: "- Alice 上午要点\n- Alice 下午互动" },
          baseline: "Alice 基线",
          memories_to_update: [],
          memories_to_delete: [],
        },
        {
          role_scope: "id:bob",
          daily_log: { title: "Bob 首批", summary: "- Bob 下午互动" },
          baseline: "Bob 首版基线",
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

    const allArgs = JSON.stringify(callOpenAICompat.mock.calls);
    // Alice 段应包含 Alice 旧日记
    expect(allArgs).toContain("Alice 上午要点");
    expect(allArgs).toContain("已有当日日记");
    // Bob 段应标注首批，不混入 Alice 内容
    expect(allArgs).toContain("本批是首批");
    // Bob 旧日记不应被读出（getDailyLog 对 Bob 返回 null）
    // upsertDailyLog 各写一次，Alice 合并版含上午要点
    const aliceWrite = upsertDailyLog.mock.calls.find((c: any) => c[1].roleScope === "id:alice");
    const bobWrite = upsertDailyLog.mock.calls.find((c: any) => c[1].roleScope === "id:bob");
    expect(aliceWrite).toBeTruthy();
    expect(bobWrite).toBeTruthy();
    expect((aliceWrite as any)[1].summary).toContain("Alice 上午要点");
    expect((bobWrite as any)[1].summary).toContain("Bob 下午互动");
    // Bob 写入不应包含 Alice 上午内容
    expect((bobWrite as any)[1].summary).not.toContain("Alice 上午要点");
  });

  it("非角色路径（无 role_id）：prompt 看到已有 shared daily_log", async () => {
    getDailyLog.mockImplementation(async (_db: any, input: any) => {
      if (input.roleScope === "shared") {
        return { namespace: "ns", role_scope: "shared", date: "2025-07-18",
          title: "上午", summary: "- 上午要点", updated_at: "t1" };
      }
      return null;
    });
    listMessagesByNamespaceInRange.mockResolvedValue([
      mkMsg("m3", null, null, "下午互动", "2025-07-18T13:00:00.000Z"),
    ]);
    callOpenAICompat.mockResolvedValue(makeResponseJson({
      title: "全天",
      summary: "- 上午要点\n- 下午互动",
      sections: [],
      important_excerpts: [],
      memories_to_add: [],
      memories_to_update: [],
      memories_to_delete: [],
    }));

    const env = createMockEnv(createMockD1(), {
      // ROLE_MEMORY_ENABLED not set — non-role path
      MEMORY_LIFECYCLE_ENABLED: "true",
      DREAM_MODEL: "test-model",
      ENABLE_DREAM: "true",
    });

    const result = await runDailyMemoryDigest(env, "ns", { dateLabel: "2025-07-18", force: true });
    expect(result.ran).toBe(true);

    const allArgs = JSON.stringify(callOpenAICompat.mock.calls);
    expect(allArgs).toContain("上午要点");
    expect(allArgs).toContain("已有当日日记");
    // upsertDailyLog 写入合并版到 shared
    expect(upsertDailyLog).toHaveBeenCalled();
    const writeCall = upsertDailyLog.mock.calls[0][1] as any;
    expect(writeCall.roleScope).toBe("shared");
    expect(writeCall.summary).toContain("上午要点");
  });
});
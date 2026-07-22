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
const listPendingBaselineChangelog = vi.fn<(...args: any[]) => Promise<any[]>>(async () => [] as any[]);
const markBaselineChangelogApplied = vi.fn<(...args: any[]) => Promise<void>>(async () => {});
const markBaselineChangelogConflict = vi.fn<(...args: any[]) => Promise<void>>(async () => {});
const markBaselineChangelogError = vi.fn<(...args: any[]) => Promise<void>>(async () => {});
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
    listPendingBaselineChangelog: (...args: any[]) => listPendingBaselineChangelog(...args),
    markBaselineChangelogApplied: (...args: any[]) => markBaselineChangelogApplied(...args),
    markBaselineChangelogConflict: (...args: any[]) => markBaselineChangelogConflict(...args),
    markBaselineChangelogError: (...args: any[]) => markBaselineChangelogError(...args),
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

function makeResponseText(text: string): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content: text }, finish_reason: "stop" }],
  }), { status: 200, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  vi.clearAllMocks();
  listMessagesByNamespaceInRange.mockResolvedValue([]);
  listMemoriesPage.mockResolvedValue({ records: [], hasMore: false, nextOffset: 0 });
  callOpenAICompat.mockResolvedValue(new Response("{}", { status: 200 }));
  listPendingChangelog.mockResolvedValue([]);
  listPendingBaselineChangelog.mockResolvedValue([]);
  markBaselineChangelogError.mockClear();
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

describe("Baseline pending 机制", () => {
  it("没有 baseline pending 时不调模型", async () => {
    listMessagesByNamespaceInRange.mockResolvedValue([
      mkMsg("m1", "alice", "Alice", "hi", "2025-07-18T01:00:00.000Z"),
    ]);
    callOpenAICompat.mockResolvedValue(makeResponseJson({
      groups: [
        {
          role_scope: "id:alice",
          daily_log: { title: "Alice", summary: "- hi" },
          memories_to_update: [],
          memories_to_delete: [],
        },
      ],
    }));

    const result = await runDailyMemoryDigest(mkEnv(), "ns", { dateLabel: "2025-07-18", force: true });
    expect(result.ran).toBe(true);
    // callOpenAICompat 被调用一次（dream 模型），不应再为 baseline 调模型
    expect(callOpenAICompat).toHaveBeenCalledTimes(1);
    expect(upsertBaseline).not.toHaveBeenCalled();
  });

  it("有 baseline pending → 调模型合并 → 写 baseline → 标记 applied", async () => {
    listPendingBaselineChangelog.mockResolvedValue([
      {
        id: "bch1", namespace: "ns", role_scope: "id:alice", op: "add",
        before_content: null, after_content: "用户是程序员", reason: "用户提到写代码",
        role_id: "alice", role_name: "Alice", created_at: "t1", status: "pending",
        error_message: null, applied_at: null,
      },
    ]);
    getBaselines.mockResolvedValue([{ namespace: "ns", role_scope: "id:alice", content: "旧 baseline", version: 1 }]);
    listMessagesByNamespaceInRange.mockResolvedValue([
      mkMsg("m1", "alice", "Alice", "hi", "2025-07-18T01:00:00.000Z"),
    ]);
    // 第一次调用 = baseline 合并模型（返回文本），第二次 = dream 模型（返回 groups）
    let callCount = 0;
    callOpenAICompat.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        // baseline 合并模型返回新 baseline 文本
        return makeResponseText("用户是程序员，旧 baseline 内容保留。");
      }
      // dream 模型
      return makeResponseJson({
        groups: [
          {
            role_scope: "id:alice",
            daily_log: { title: "Alice", summary: "- hi" },
            memories_to_update: [],
            memories_to_delete: [],
          },
        ],
      });
    });

    const result = await runDailyMemoryDigest(mkEnv(), "ns", { dateLabel: "2025-07-18", force: true });
    expect(result.ran).toBe(true);
    // 两次模型调用：dream + baseline 合并
    expect(callOpenAICompat).toHaveBeenCalledTimes(2);
    // baseline 写入
    expect(upsertBaseline).toHaveBeenCalled();
    const baselineWrite = upsertBaseline.mock.calls[0][1];
    expect(baselineWrite.roleScope).toBe("id:alice");
    expect(baselineWrite.content).toContain("用户是程序员");
    // 标记 applied
    expect(markBaselineChangelogApplied).toHaveBeenCalledWith(expect.anything(), { id: "bch1" });
  });

  it("模型返回空 → 标记 conflict，不写 baseline", async () => {
    listPendingBaselineChangelog.mockResolvedValue([
      {
        id: "bch2", namespace: "ns", role_scope: "id:alice", op: "update",
        before_content: "旧", after_content: "新", reason: "更新",
        role_id: "alice", role_name: "Alice", created_at: "t2", status: "pending",
        error_message: null, applied_at: null,
      },
    ]);
    listMessagesByNamespaceInRange.mockResolvedValue([
      mkMsg("m1", "alice", "Alice", "hi", "2025-07-18T01:00:00.000Z"),
    ]);
    let callCount = 0;
    callOpenAICompat.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        // baseline 合并返回空
        return makeResponseText("");
      }
      // dream 模型
      return makeResponseJson({ groups: [{ role_scope: "id:alice", daily_log: { title: "A", summary: "- hi" }, memories_to_update: [], memories_to_delete: [] }] });
    });

    await runDailyMemoryDigest(mkEnv(), "ns", { dateLabel: "2025-07-18", force: true });
    expect(upsertBaseline).not.toHaveBeenCalled();
    // 临时故障不标记 conflict，保持 pending 下次重试
    expect(markBaselineChangelogConflict).not.toHaveBeenCalled();
    expect(markBaselineChangelogError).toHaveBeenCalledWith(expect.anything(), { id: "bch2", errorMessage: "model returned empty" });
  });

  it("多个角色有 pending → 各自调一次模型合并", async () => {
    listPendingBaselineChangelog.mockImplementation(async (_db: any, input: any) => {
      if (input.roleScope === "id:alice") {
        return [{ id: "bch_a", namespace: "ns", role_scope: "id:alice", op: "add", before_content: null, after_content: "Alice 印象", reason: "r", role_id: "alice", role_name: "Alice", created_at: "t1", status: "pending", error_message: null, applied_at: null }];
      }
      if (input.roleScope === "id:bob") {
        return [{ id: "bch_b", namespace: "ns", role_scope: "id:bob", op: "add", before_content: null, after_content: "Bob 印象", reason: "r", role_id: "bob", role_name: "Bob", created_at: "t2", status: "pending", error_message: null, applied_at: null }];
      }
      return [];
    });
    // getBaselines 按 scope 返回不同内容
    getBaselines.mockImplementation(async (_db: any, input: any) => {
      if (input.roleScope === "id:alice") return [{ namespace: "ns", role_scope: "id:alice", content: "Alice 旧", version: 1 }];
      if (input.roleScope === "id:bob") return [{ namespace: "ns", role_scope: "id:bob", content: "Bob 旧", version: 1 }];
      return [];
    });
    listMessagesByNamespaceInRange.mockResolvedValue([
      mkMsg("m1", "alice", "Alice", "hi", "2025-07-18T01:00:00.000Z"),
      mkMsg("m2", "bob", "Bob", "hello", "2025-07-18T02:00:00.000Z"),
    ]);
    let callCount = 0;
    callOpenAICompat.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return makeResponseText("Alice 合并版");
      }
      if (callCount === 2) {
        return makeResponseText("Bob 合并版");
      }
      // dream 模型
      return makeResponseJson({
        groups: [
          { role_scope: "id:alice", daily_log: { title: "A", summary: "- hi" }, memories_to_update: [], memories_to_delete: [] },
          { role_scope: "id:bob", daily_log: { title: "B", summary: "- hello" }, memories_to_update: [], memories_to_delete: [] },
        ],
      });
    });

    // 注意: applyBaselineChanges 查所有 pending (不传 roleScope)，需 mock 返回全部
    listPendingBaselineChangelog.mockResolvedValue([
      { id: "bch_a", namespace: "ns", role_scope: "id:alice", op: "add", before_content: null, after_content: "Alice 印象", reason: "r", role_id: "alice", role_name: "Alice", created_at: "t1", status: "pending", error_message: null, applied_at: null },
      { id: "bch_b", namespace: "ns", role_scope: "id:bob", op: "add", before_content: null, after_content: "Bob 印象", reason: "r", role_id: "bob", role_name: "Bob", created_at: "t2", status: "pending", error_message: null, applied_at: null },
    ]);

    const result = await runDailyMemoryDigest(mkEnv(), "ns", { dateLabel: "2025-07-18", force: true });
    expect(result.ran).toBe(true);
    // 3 次调用：alice baseline + bob baseline + dream
    expect(callOpenAICompat).toHaveBeenCalledTimes(3);
    // 两次 baseline 写入
    expect(upsertBaseline).toHaveBeenCalledTimes(2);
    const scopes = upsertBaseline.mock.calls.map((c: any) => c[1].roleScope);
    expect(scopes).toContain("id:alice");
    expect(scopes).toContain("id:bob");
  });

  it("applied pending 原文保留不删", async () => {
    listPendingBaselineChangelog.mockResolvedValue([
      {
        id: "bch_keep", namespace: "ns", role_scope: "id:alice", op: "add",
        before_content: null, after_content: "新印象", reason: "测试保留",
        role_id: "alice", role_name: "Alice", created_at: "t1", status: "pending",
        error_message: null, applied_at: null,
      },
    ]);
    listMessagesByNamespaceInRange.mockResolvedValue([
      mkMsg("m1", "alice", "Alice", "hi", "2025-07-18T01:00:00.000Z"),
    ]);
    let callCount = 0;
    callOpenAICompat.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return makeResponseText("合并后 baseline");
      }
      return makeResponseJson({ groups: [{ role_scope: "id:alice", daily_log: { title: "A", summary: "- hi" }, memories_to_update: [], memories_to_delete: [] }] });
    });

    await runDailyMemoryDigest(mkEnv(), "ns", { dateLabel: "2025-07-18", force: true });
    // 标记 applied (不删)
    expect(markBaselineChangelogApplied).toHaveBeenCalledWith(expect.anything(), { id: "bch_keep" });
    // 没有调用 markChangelogConflict（原子记忆的）
    expect(markBaselineChangelogConflict).not.toHaveBeenCalled();
  });
});

describe("MCP baseline_change 工具校验", () => {
  it("源码: baseline_change 工具已暴露，memory_change_add/update/delete 已注释", () => {
    const src = require("fs").readFileSync(
      require("path").resolve(__dirname, "../../../src/api/mcp.ts"),
      "utf-8"
    );
    expect(src).toMatch(/name: "baseline_change"/);
    expect(src).toMatch(/createBaselineChangelogEntry/);
    // memory_change_add 应被注释掉
    expect(src).toMatch(/\/\/\s*{[\s\S]*?name:\s*"memory_change_add"/);
    expect(src).toMatch(/\/\/\s*{[\s\S]*?name:\s*"memory_change_update"/);
    expect(src).toMatch(/\/\/\s*{[\s\S]*?name:\s*"memory_change_delete"/);
  });

  it("源码: 校验 add 必须有 after / update 必须有 before+after / delete 必须有 before / role_id+reason 必填 / 不允许 shared", () => {
    const src = require("fs").readFileSync(
      require("path").resolve(__dirname, "../../../src/api/mcp.ts"),
      "utf-8"
    );
    expect(src).toMatch(/add requires after_content/);
    expect(src).toMatch(/update requires before_content and after_content/);
    expect(src).toMatch(/delete requires before_content/);
    expect(src).toMatch(/reason is required/);
    expect(src).toMatch(/role_id is required.*baseline is role-specific.*shared baseline is not allowed/);
    expect(src).toMatch(/shared baseline is not allowed/);
  });
});
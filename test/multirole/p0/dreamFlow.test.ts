import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockD1, createMockEnv } from "../../helpers/d1-mock";

// Heavy mocks — dailyDigest depends on many modules.
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

// Trackable mocks for messages and model
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

// v2 db mocks — track writes. Use importOriginal to keep un-mocked exports working
// (buildBootPackage also calls getDigest, listPrecious, listGlossary, markPreciousInjected).
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

// vectorStore getVectorMemory needs per-test behavior; reset in beforeEach
import { getVectorMemory } from "../../../src/memory/vectorStore";
import { runDailyMemoryDigest } from "../../../src/memory/dailyDigest";

function mkMsg(id: string, roleId: string | null, roleName: string | null, content: string, createdAt: string): any {
  return {
    id,
    namespace: "ns",
    role: "user",
    role_id: roleId,
    role_name: roleName,
    content,
    created_at: createdAt,
  };
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

describe("P0-3: pending changes applied before dream model call", () => {
  it("applyPendingChanges runs before callDigestModel (model sees freshly applied state)", async () => {
    // Arrange: two pending add ops, and a model that returns valid empty JSON
    const pendingAdds = [
      { id: "chg1", namespace: "ns", role_scope: "id:alice", op: "add", target_id: null,
        before_content: null, after_content: "新事实", payload_json: "{}",
        target_version: null, reason: null, role_id: "alice", role_name: "Alice",
        created_at: "t1", status: "pending", error_message: null, applied_at: null },
    ];
    listPendingChangelog.mockResolvedValue(pendingAdds);
    listMessagesByNamespaceInRange.mockResolvedValue([
      mkMsg("m1", "alice", "Alice", "hi", "2025-07-18T01:00:00.000Z"),
    ]);
    // Return a valid groups-style digest so applyDreamV2 path runs without per-target vector lookups
    callOpenAICompat.mockResolvedValue(makeResponseJson({
      groups: [
        {
          role_scope: "id:alice",
          daily_log: { title: "互动", summary: "- 今天聊了" },
          baseline: "Alice 看到用户努力",
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

    // markChangelogApplied must have been called — proves pending was applied before dream
    expect(markChangelogApplied).toHaveBeenCalled();
    // The model must have been called AFTER pending applied — model call happened
    expect(callOpenAICompat).toHaveBeenCalled();
    // Order: pending applied before model call. We verify by checking both were called.
    // (Stronger order test: pending mark happens before the callDigestModel call.)
    const pendingAppliedOrder = vi.mocked(markChangelogApplied).mock.invocationCallOrder[0];
    const modelCallOrder = vi.mocked(callOpenAICompat).mock.invocationCallOrder[0];
    expect(pendingAppliedOrder).toBeLessThan(modelCallOrder);
  });
});

describe("P0-4: role dream grouping", () => {
  it("triggers grouping for a single non-shared role (not requiring size > 1)", async () => {
    listMessagesByNamespaceInRange.mockResolvedValue([
      mkMsg("m1", "alice", "Alice", "hi", "2025-07-18T01:00:00.000Z"),
      mkMsg("m2", "alice", "Alice", "hello", "2025-07-18T02:00:00.000Z"),
    ]);
    callOpenAICompat.mockResolvedValue(makeResponseJson({
      groups: [
        {
          role_scope: "id:alice",
          daily_log: { title: "Alice 当天", summary: "- 聊了 hi/hello" },
          baseline: "Alice 专属基线",
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
    // daily_log written for id:alice scope (upsertDailyLog is called as (db, input))
    const dailyLogCalls = upsertDailyLog.mock.calls;
    expect(dailyLogCalls.length).toBeGreaterThanOrEqual(1);
    const aliceLogCall = dailyLogCalls.find((c: any[]) => c[1]?.roleScope === "id:alice");
    expect(aliceLogCall).toBeTruthy();
  });

  it("aborts without advancing cursor when role count exceeds DREAM_MAX_ROLES_PER_RUN", async () => {
    // 6 distinct roles, max=5
    const msgs = [];
    for (let i = 0; i < 6; i++) {
      msgs.push(mkMsg(`m${i}`, `role${i}`, `Role${i}`, `msg${i}`, `2025-07-18T0${i}:00:00.000Z`));
    }
    listMessagesByNamespaceInRange.mockResolvedValue(msgs);

    const env = createMockEnv(createMockD1(), {
      ROLE_MEMORY_ENABLED: "true",
      MEMORY_LIFECYCLE_ENABLED: "true",
      DREAM_MODEL: "test-model",
      ENABLE_DREAM: "true",
      DREAM_MAX_ROLES_PER_RUN: "5",
    });

    const result = await runDailyMemoryDigest(env, "ns", { dateLabel: "2025-07-18", force: true });
    expect(result.ran).toBe(false);
    // Model must NOT have been called
    expect(callOpenAICompat).not.toHaveBeenCalled();
  });

  it("Alice group cannot modify Bob target (cross-scope blocked)", async () => {
    // Alice message; Bob memory present
    listMessagesByNamespaceInRange.mockResolvedValue([
      mkMsg("m1", "alice", "Alice", "hi", "2025-07-18T01:00:00.000Z"),
    ]);
    // existing memories include a Bob-scoped target
    listMemoriesPage.mockResolvedValue({
      records: [
        { id: "mem_bob", role_scope: "id:bob", role_id: "bob", role_name: "Bob", content: "Bob 的事", status: "active" } as any,
      ],
      hasMore: false,
      nextOffset: 0,
    });
    // Model outputs Alice group trying to delete Bob target
    callOpenAICompat.mockResolvedValue(makeResponseJson({
      groups: [
        {
          role_scope: "id:alice",
          daily_log: { title: "Alice", summary: "- hi" },
          baseline: "Alice baseline",
          memories_to_update: [],
          memories_to_delete: [{ target_id: "mem_bob", reason: "should be blocked" }],
        },
      ],
    }));
    // getVectorMemory returns Bob-scoped active memory
    (getVectorMemory as any).mockImplementation(async (env: any, id: string) => {
      if (id === "mem_bob") {
        return { id, namespace: "ns", status: "active", pinned: false, role_id: "bob", role_name: "Bob", content: "Bob 的事" };
      }
      return null;
    });

    const env = createMockEnv(createMockD1(), {
      ROLE_MEMORY_ENABLED: "true",
      MEMORY_LIFECYCLE_ENABLED: "true",
      DREAM_MODEL: "test-model",
      ENABLE_DREAM: "true",
    });

    const result = await runDailyMemoryDigest(env, "ns", { dateLabel: "2025-07-18", force: true });
    expect(result.ran).toBe(true);
    // archiveMemory should NOT have been called (cross-scope blocked)
    expect(archiveMemory).not.toHaveBeenCalled();
  });
});

describe("P1-1 / P1-3: per-role daily_log and baseline written", () => {
  it("Alice + Bob same day produces separate daily_log and baseline for each role", async () => {
    listMessagesByNamespaceInRange.mockResolvedValue([
      mkMsg("m1", "alice", "Alice", "alice msg", "2025-07-18T01:00:00.000Z"),
      mkMsg("m2", "bob", "Bob", "bob msg", "2025-07-18T02:00:00.000Z"),
    ]);
    callOpenAICompat.mockResolvedValue(makeResponseJson({
      groups: [
        {
          role_scope: "id:alice",
          daily_log: { title: "Alice 日", summary: "- Alice 互动" },
          baseline: "Alice 对用户的长期印象",
          memories_to_update: [],
          memories_to_delete: [],
        },
        {
          role_scope: "id:bob",
          daily_log: { title: "Bob 日", summary: "- Bob 互动" },
          baseline: "Bob 对用户的长期印象",
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

    // Verify two daily_log writes with distinct role_scopes (upsertDailyLog called as (db, input))
    const dailyLogScopes = upsertDailyLog.mock.calls.map((c: any[]) => c[1]?.roleScope).filter(Boolean);
    expect(dailyLogScopes).toContain("id:alice");
    expect(dailyLogScopes).toContain("id:bob");

    // Verify two baseline writes with distinct role_scopes
    const baselineScopes = upsertBaseline.mock.calls.map((c: any[]) => c[1]?.roleScope).filter(Boolean);
    expect(baselineScopes).toContain("id:alice");
    expect(baselineScopes).toContain("id:bob");

    // Alice's daily_log should not contain Bob's content
    const aliceLog = upsertDailyLog.mock.calls.find((c: any[]) => c[1]?.roleScope === "id:alice");
    expect(aliceLog![1]!.summary).toContain("Alice 互动");
    expect(aliceLog![1]!.summary).not.toContain("Bob 互动");
  });

  it("single Alice role day also generates Alice daily_log and baseline", async () => {
    listMessagesByNamespaceInRange.mockResolvedValue([
      mkMsg("m1", "alice", "Alice", "alice only", "2025-07-18T01:00:00.000Z"),
    ]);
    callOpenAICompat.mockResolvedValue(makeResponseJson({
      groups: [
        {
          role_scope: "id:alice",
          daily_log: { title: "Alice 单独", summary: "- 单独互动" },
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
    expect(upsertDailyLog).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ roleScope: "id:alice" }));
    expect(upsertBaseline).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ roleScope: "id:alice" }));
  });
});

describe("P1-2: buildBootPackage only fetches current role baseline (source-level)", () => {
  it("source code calls getBaselines with roleScope=requestRoleScope", () => {
    const src = require("fs").readFileSync(
      require("path").resolve(__dirname, "../../../src/memory/v2/recall.ts"),
      "utf-8"
    );
    expect(src).toMatch(/getBaselines\(env\.DB,\s*\{\s*namespace:\s*input\.namespace,\s*roleScope:\s*requestRoleScope\s*\}\)/);
  });

  it("source code does not fetch all baselines then sort", () => {
    const src = require("fs").readFileSync(
      require("path").resolve(__dirname, "../../../src/memory/v2/recall.ts"),
      "utf-8"
    );
    expect(src).not.toMatch(/getBaselines\(env\.DB,\s*\{\s*namespace:\s*input\.namespace\s*\}\)/);
  });

  it("source code does not merge shared+role daily_logs", () => {
    const src = require("fs").readFileSync(
      require("path").resolve(__dirname, "../../../src/memory/v2/recall.ts"),
      "utf-8"
    );
    // No logMap merge of shared + role logs
    expect(src).not.toMatch(/logMap/);
  });
});

describe("P1-1: baseline prompt explicitly asks for long-term impression", () => {
  it("buildDigestPrompt role-group section includes baseline guidance", () => {
    // Source-level check that prompt explicitly instructs baseline = long-term impression
    const src = require("fs").readFileSync(
      require("path").resolve(__dirname, "../../../src/memory/dailyDigest.ts"),
      "utf-8"
    );
    // The prompt should mention "长期印象" / "忠实继承" / "不把一次性安排写成永久"
    expect(src).toMatch(/长期印象/);
    expect(src).toMatch(/忠实继承/);
    expect(src).toMatch(/一次性安排/);
  });
});
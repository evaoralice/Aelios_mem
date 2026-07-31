import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockD1, createMockEnv } from "../helpers/d1-mock";
import { callTool } from "../../src/api/mcp";

vi.mock("../../src/memory/vectorStore", () => ({
  searchVectorMemories: vi.fn(async () => []),
  createVectorMemory: vi.fn(async () => ({})),
  deleteVectorMemory: vi.fn(async () => true),
  getVectorMemory: vi.fn(async () => null),
  listVectorMemories: vi.fn(async () => ({ data: [], cursor: null, hasMore: false })),
}));
vi.mock("../../src/memory/filter", () => ({
  filterAndCompressMemories: vi.fn(async (_env: any, input: { memories: any[] }) => input.memories),
}));
vi.mock("../../src/memory/export", () => ({
  exportMemories: vi.fn(async () => ({ data: [] })),
}));
vi.mock("../../src/memory/v2/recall", () => ({
  buildBootPackage: vi.fn(async () => null),
  isV2Enabled: () => true,
  runRecall: vi.fn(async () => ({ hits: [], glossary_hits: [], meta: {} })),
}));
vi.mock("../../src/queue/producer", () => ({
  enqueueMemoryMaintenanceIfNeeded: vi.fn(),
}));
vi.mock("../../src/db/conversations", () => ({
  getOrCreateConversation: vi.fn(async () => ({ id: "c1" })),
}));
vi.mock("../../src/db/messages", () => ({
  saveIngestMessages: vi.fn(async () => ["m1"]),
}));

function makeProfile(scopes: string[] = ["memory:read", "memory:write"]) {
  return { scopes, namespace: "test", source: "mcp" } as any;
}

const ctx = { waitUntil: () => {} } as any;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("MCP daily_log_read", () => {
  it("缺少 memory:read scope 返回错误", async () => {
    const db = createMockD1({ onQuery: () => [], onRun: () => {} });
    const env = createMockEnv(db);
    const profile = makeProfile(["memory:write"]);
    const result = await callTool(env, ctx, profile, {
      name: "daily_log_read",
      arguments: {},
    } as any);
    expect((result as any).isError).toBe(true);
    expect((result as any).content[0].text).toMatch(/memory:read/);
  });

  it("传 date 返回单条", async () => {
    const db = createMockD1({
      onQuery: (sql) => {
        if (sql.includes("FROM daily_log") && sql.includes("date = ?")) {
          return [{ namespace: "test", role_scope: "shared", date: "2026-07-30", title: "T", summary: "S", updated_at: "u" }];
        }
        return [];
      },
      onRun: () => {},
    });
    const env = createMockEnv(db);
    const result = await callTool(env, ctx, makeProfile(), {
      name: "daily_log_read",
      arguments: { date: "2026-07-30" },
    } as any);
    expect((result as any).isError).toBeFalsy();
    const data = (result as any).structuredContent?.data;
    expect(data?.date).toBe("2026-07-30");
    expect(data?.title).toBe("T");
  });

  it("传 date 找不到时返回提示而非错误", async () => {
    const db = createMockD1({ onQuery: () => [], onRun: () => {} });
    const env = createMockEnv(db);
    const result = await callTool(env, ctx, makeProfile(), {
      name: "daily_log_read",
      arguments: { date: "2026-07-30" },
    } as any);
    expect((result as any).isError).toBeFalsy();
    const data = (result as any).structuredContent?.data;
    expect(data?.message).toMatch(/No log found/i);
  });

  it("不传 date 返回最近列表（默认 limit=7）", async () => {
    let capturedArgs: any[] = [];
    const db = createMockD1({
      onQuery: (sql, args) => {
        if (sql.includes("ORDER BY date DESC")) {
          capturedArgs = args;
          return [
            { namespace: "test", role_scope: "shared", date: "2026-07-30", title: "A", summary: "s", updated_at: "u" },
            { namespace: "test", role_scope: "shared", date: "2026-07-29", title: "B", summary: "s", updated_at: "u" },
          ];
        }
        return [];
      },
      onRun: () => {},
    });
    const env = createMockEnv(db);
    const result = await callTool(env, ctx, makeProfile(), {} as any);
    // 调用 daily_log_read
    const r = await callTool(env, ctx, makeProfile(), {
      name: "daily_log_read",
      arguments: {},
    } as any);
    expect((r as any).isError).toBeFalsy();
    const data = (r as any).structuredContent?.data as any[];
    expect(data).toHaveLength(2);
    // bind args: [namespace, roleScope, limit]
    expect(capturedArgs[0]).toBe("test");
    expect(capturedArgs[1]).toBe("shared");
    expect(capturedArgs[2]).toBe(7);
  });

  it("role_id 参数经 computeRoleScope 转换后透传到查询", async () => {
    let capturedArgs: any[] = [];
    const db = createMockD1({
      onQuery: (_sql, args) => {
        capturedArgs = args;
        return [];
      },
      onRun: () => {},
    });
    const env = createMockEnv(db);
    await callTool(env, ctx, makeProfile(), {
      name: "daily_log_read",
      arguments: { role_id: "alice" },
    } as any);
    expect(capturedArgs[1]).toBe("id:alice");
  });
});

describe("MCP daily_log_write", () => {
  it("缺少 memory:write scope 返回错误", async () => {
    const db = createMockD1({ onQuery: () => [], onRun: () => {} });
    const env = createMockEnv(db);
    const profile = makeProfile(["memory:read"]);
    const result = await callTool(env, ctx, profile, {
      name: "daily_log_write",
      arguments: { date: "2026-07-30", title: "T" },
    } as any);
    expect((result as any).isError).toBe(true);
    expect((result as any).content[0].text).toMatch(/memory:write/);
  });

  it("缺 date 返回错误", async () => {
    const db = createMockD1({ onQuery: () => [], onRun: () => {} });
    const env = createMockEnv(db);
    const result = await callTool(env, ctx, makeProfile(), {
      name: "daily_log_write",
      arguments: { title: "T" },
    } as any);
    expect((result as any).isError).toBe(true);
    expect((result as any).content[0].text).toMatch(/date is required/i);
  });

  it("缺 title 返回错误", async () => {
    const db = createMockD1({ onQuery: () => [], onRun: () => {} });
    const env = createMockEnv(db);
    const result = await callTool(env, ctx, makeProfile(), {
      name: "daily_log_write",
      arguments: { date: "2026-07-30" },
    } as any);
    expect((result as any).isError).toBe(true);
    expect((result as any).content[0].text).toMatch(/title is required/i);
  });

  it("title 超过 12 字返回错误", async () => {
    const db = createMockD1({ onQuery: () => [], onRun: () => {} });
    const env = createMockEnv(db);
    const result = await callTool(env, ctx, makeProfile(), {
      name: "daily_log_write",
      arguments: { date: "2026-07-30", title: "这是一个超过十二字的标题测试用例" },
    } as any);
    expect((result as any).isError).toBe(true);
    expect((result as any).content[0].text).toMatch(/<= 12 characters/i);
  });

  it("summary 超过 800 字返回错误", async () => {
    const db = createMockD1({ onQuery: () => [], onRun: () => {} });
    const env = createMockEnv(db);
    const longSummary = "- ".repeat(500);
    const result = await callTool(env, ctx, makeProfile(), {
      name: "daily_log_write",
      arguments: { date: "2026-07-30", title: "T", summary: longSummary },
    } as any);
    expect((result as any).isError).toBe(true);
    expect((result as any).content[0].text).toMatch(/<= 800 characters/i);
  });

  it("正常写入：返回 upsert 结果", async () => {
    let capturedSql = "";
    let capturedArgs: any[] = [];
    const db = createMockD1({
      onQuery: () => [],
      onRun: (sql, args) => {
        capturedSql = sql;
        capturedArgs = args;
      },
    });
    const env = createMockEnv(db);
    const result = await callTool(env, ctx, makeProfile(), {
      name: "daily_log_write",
      arguments: { date: "2026-07-30", title: "温柔的一天", summary: "- 聊天\n- 散步" },
    } as any);
    expect((result as any).isError).toBeFalsy();
    expect(capturedSql).toContain("INSERT INTO daily_log");
    expect(capturedArgs[0]).toBe("test");
    expect(capturedArgs[1]).toBe("shared");
    expect(capturedArgs[2]).toBe("2026-07-30");
    expect(capturedArgs[3]).toBe("温柔的一天");
    const data = (result as any).structuredContent?.data;
    expect(data.title).toBe("温柔的一天");
  });

  it("role_id 参数经 computeRoleScope 转换后透传到写入", async () => {
    let capturedArgs: any[] = [];
    const db = createMockD1({
      onQuery: () => [],
      onRun: (_sql, args) => { capturedArgs = args; },
    });
    const env = createMockEnv(db);
    await callTool(env, ctx, makeProfile(), {
      name: "daily_log_write",
      arguments: { date: "2026-07-30", title: "T", role_id: "alice" },
    } as any);
    expect(capturedArgs[1]).toBe("id:alice");
  });
});
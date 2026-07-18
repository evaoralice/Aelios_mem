import { describe, it, expect, vi } from "vitest";
import { createMockD1, createMockEnv } from "../../helpers/d1-mock";
import { callTool } from "../../../src/api/mcp";

// Mock heavy imports so callTool can run without real services
vi.mock("../../../src/memory/vectorStore", () => ({
  searchVectorMemories: vi.fn(async () => []),
  createVectorMemory: vi.fn(async () => ({})),
  deleteVectorMemory: vi.fn(async () => true),
  getVectorMemory: vi.fn(async () => null),
  listVectorMemories: vi.fn(async () => ({ data: [], cursor: null, hasMore: false })),
}));
vi.mock("../../../src/memory/filter", () => ({
  filterAndCompressMemories: vi.fn(async (_env: any, input: { memories: any[] }) => input.memories),
}));
vi.mock("../../../src/memory/export", () => ({
  exportMemories: vi.fn(async () => ({ data: [] })),
}));
vi.mock("../../../src/memory/v2/recall", () => ({
  buildBootPackage: vi.fn(async () => null),
  isV2Enabled: () => true,
  runRecall: vi.fn(async () => ({ hits: [], glossary_hits: [], meta: {} })),
}));
vi.mock("../../../src/queue/producer", () => ({
  enqueueMemoryMaintenanceIfNeeded: vi.fn(),
}));
vi.mock("../../../src/db/conversations", () => ({
  getOrCreateConversation: vi.fn(async () => ({ id: "c1" })),
}));
vi.mock("../../../src/db/messages", () => ({
  saveIngestMessages: vi.fn(async () => ["m1"]),
}));

function makeProfile(scopes: string[] = ["memory:read", "memory:write"]) {
  return { scopes, namespace: "test", source: "mcp" } as any;
}

const ctx = { waitUntil: () => {} } as any;

describe("Phase D: memory_change_* MCP tools", () => {
  it("memory_change_add creates a pending changelog entry", async () => {
    let capturedRow: any = null;
    const db = createMockD1({
      onQuery: () => [],
      onRun: () => {},
    });
    // Override prepare to capture INSERT into memory_changelog
    const origPrepare = db.prepare;
    (db as any).prepare = (sql: string) => {
      if (sql.includes("INSERT INTO memory_changelog")) {
        return {
          bind: (...vals: any[]) => ({
            run: async () => { capturedRow = { sql, vals }; },
          }),
        };
      }
      return (origPrepare as any).call(db, sql);
    };

    const env = createMockEnv(db);
    const result = await callTool(env, ctx, makeProfile(), {
      name: "memory_change_add",
      arguments: { content: "用户喜欢猫", type: "preference", role_id: "alice-001", role_name: "Alice" },
    } as any);

    const isError = (result as any).isError === true;
    expect(isError).toBeFalsy();
    expect(capturedRow).toBeTruthy();
    expect(capturedRow.sql).toContain("memory_changelog");
    expect(capturedRow.vals).toContain("add");
    expect(capturedRow.vals).toContain("alice-001");
    expect(capturedRow.vals).toContain("id:alice-001");
  });

  it("memory_change_add without role_id defaults to shared scope", async () => {
    let capturedRow: any = null;
    const db = createMockD1({
      onQuery: () => [],
      onRun: () => {},
    });
    const origPrepare = db.prepare;
    (db as any).prepare = (sql: string) => {
      if (sql.includes("INSERT INTO memory_changelog")) {
        return { bind: (...vals: any[]) => ({ run: async () => { capturedRow = { vals }; } }) };
      }
      return (origPrepare as any).call(db, sql);
    };

    const env = createMockEnv(db);
    await callTool(env, ctx, makeProfile(), {
      name: "memory_change_add",
      arguments: { content: "用户喜欢狗" },
    } as any);

    expect(capturedRow.vals).toContain("shared");
  });

  it("memory_change_update requires target_id", async () => {
    const env = createMockEnv(createMockD1());
    const result = await callTool(env, ctx, makeProfile(), {
      name: "memory_change_update",
      arguments: { content: "updated" },
    } as any);
    expect((result as any).isError).toBe(true);
  });

  it("memory_change_delete requires target_id", async () => {
    const env = createMockEnv(createMockD1());
    const result = await callTool(env, ctx, makeProfile(), {
      name: "memory_change_delete",
      arguments: {},
    } as any);
    expect((result as any).isError).toBe(true);
  });

  it("memory_change_add requires memory:write scope", async () => {
    const env = createMockEnv(createMockD1());
    const result = await callTool(env, ctx, makeProfile(["memory:read"]), {
      name: "memory_change_add",
      arguments: { content: "test" },
    } as any);
    expect((result as any).isError).toBe(true);
  });
});

describe("Phase D: memory_upsert passes role params", () => {
  it("memory_upsert accepts role_id and role_name", async () => {
    const db = createMockD1({
      onQuery: (sql: string) => {
        if (sql.includes("SELECT m.id FROM memories")) return [];
        return [];
      },
      onRun: () => {},
    });
    const env = createMockEnv(db);

    const result = await callTool(env, ctx, makeProfile(), {
      name: "memory_upsert",
      arguments: { fact_key: "test_key", content: "test content", role_id: "bob", role_name: "Bob" },
    } as any);

    const isError = (result as any).isError === true;
    expect(isError).toBeFalsy();
  });
});
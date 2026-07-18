import { describe, it, expect, vi } from "vitest";
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

import { listPendingChangelog, createChangelogEntry } from "../../../src/db/v2";

describe("Phase F: changelog pending injection", () => {
  it("listPendingChangelog returns pending entries for namespace + role_scope", async () => {
    const db = createMockD1({
      onQuery: (sql: string, args: any[]) => {
        if (sql.includes("memory_changelog") && sql.includes("pending")) {
          expect(args[0]).toBe("ns");
          expect(args[1]).toBe("shared");
          return [
            { id: "chg1", namespace: "ns", role_scope: "shared", op: "add", target_id: null,
              before_content: null, after_content: "新记忆", payload_json: "{}",
              target_version: null, reason: null, role_id: null, role_name: null,
              created_at: "t", status: "pending", error_message: null, applied_at: null },
          ];
        }
        return [];
      },
    });
    const rows = await listPendingChangelog(db, { namespace: "ns", roleScope: "shared" });
    expect(rows).toHaveLength(1);
    expect(rows[0].op).toBe("add");
  });

  it("createChangelogEntry writes pending entry with correct role_scope", async () => {
    let captured: any = null;
    const db = createMockD1({
      onQuery: () => [],
      onRun: (sql: string, args: any[]) => {
        if (sql.includes("INSERT INTO memory_changelog")) {
          captured = { sql, args };
        }
      },
    });
    await createChangelogEntry(db, {
      namespace: "ns",
      op: "add",
      afterContent: "test",
      payloadJson: "{}",
      roleId: "alice-001",
      roleName: "Alice",
    });
    expect(captured).toBeTruthy();
    expect(captured.args).toContain("id:alice-001");
    expect(captured.sql).toContain("'pending'");
  });
});
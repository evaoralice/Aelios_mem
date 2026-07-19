import { describe, it, expect, vi } from "vitest";
import { createMockD1, createMockEnv } from "../../helpers/d1-mock";

// This file tests buildBootPackage with D1-level mocks (no module-level vi.mock for db/v2),
// so that buildBootPackage's actual SQL queries can be inspected.
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

import { buildBootPackage } from "../../../src/memory/v2/recall";

describe("P1-2 / P1-3 behavior: buildBootPackage scopes baseline + daily_log to current role", () => {
  it("returns only the current role baseline (not other roles')", async () => {
    const db = createMockD1({
      onQuery: (sql: string, args: any[]) => {
        if (sql.includes("FROM long_term_baselines")) {
          // P1-2: query should filter by roleScope
          expect(args).toContain("id:alice");
          return [
            { namespace: "ns", role_scope: "id:alice", content: "Alice 基线", version: 1, generated_at: "t" },
          ];
        }
        if (sql.includes("FROM daily_log")) {
          expect(args).toContain("id:alice");
          return [];
        }
        return [];
      },
    });
    const env = createMockEnv(db, { ROLE_MEMORY_ENABLED: "true" });
    const pkg = await buildBootPackage(env, { namespace: "ns", roleId: "alice", roleName: "Alice" });
    expect(pkg.baselines).toHaveLength(1);
    expect(pkg.baselines[0].role_scope).toBe("id:alice");
  });

  it("returns empty baselines when no current role", async () => {
    const db = createMockD1({
      onQuery: () => [],
    });
    const env = createMockEnv(db, { ROLE_MEMORY_ENABLED: "true" });
    const pkg = await buildBootPackage(env, { namespace: "ns" });
    expect(pkg.baselines).toEqual([]);
  });

  it("daily_log fetch scoped to current role, not shared+role merge", async () => {
    const seenScopes: string[] = [];
    const db = createMockD1({
      onQuery: (sql: string, args: any[]) => {
        if (sql.includes("FROM daily_log")) {
          seenScopes.push(args[1]);
          return [
            { namespace: "ns", role_scope: "id:alice", date: "2025-07-18", title: "Alice 日", summary: "- x", updated_at: "t" },
          ];
        }
        if (sql.includes("FROM long_term_baselines")) return [];
        return [];
      },
    });
    const env = createMockEnv(db, { ROLE_MEMORY_ENABLED: "true" });
    const pkg = await buildBootPackage(env, { namespace: "ns", roleId: "alice", roleName: "Alice" });
    // Should only have queried the alice scope, not shared
    expect(seenScopes).toEqual(["id:alice"]);
    expect(pkg.recent_logs).toHaveLength(1);
    expect(pkg.recent_logs[0].title).toBe("Alice 日");
  });

  it("shared-scope request only queries shared daily_log + shared baseline", async () => {
    const seenScopes: string[] = [];
    const db = createMockD1({
      onQuery: (sql: string, args: any[]) => {
        if (sql.includes("FROM daily_log") || sql.includes("FROM long_term_baselines")) {
          seenScopes.push(args[1]);
          return [];
        }
        return [];
      },
    });
    const env = createMockEnv(db, { ROLE_MEMORY_ENABLED: "true" });
    await buildBootPackage(env, { namespace: "ns" });
    // No role → requestRoleScope = shared; both queries should use "shared"
    expect(seenScopes.every((s) => s === "shared")).toBe(true);
  });
});
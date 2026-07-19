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

import { buildBootPackage } from "../../../src/memory/v2/recall";

describe("Phase F: baselines in BootPackage", () => {
  it("BootPackage has baselines field", async () => {
    const db = createMockD1({
      onQuery: (sql: string) => {
        if (sql.includes("FROM long_term_baselines")) {
          return [
            { namespace: "ns", role_scope: "shared", content: "用户喜欢凌晨工作", version: 3, generated_at: "t" },
          ];
        }
        return [];
      },
    });
    const env = createMockEnv(db, { ROLE_MEMORY_ENABLED: "true" });
    const pkg = await buildBootPackage(env, { namespace: "ns" });
    expect(pkg).toHaveProperty("baselines");
    expect(pkg.baselines).toHaveLength(1);
    expect(pkg.baselines[0].content).toBe("用户喜欢凌晨工作");
    expect(pkg.baselines[0].role_scope).toBe("shared");
  });

  it("returns empty baselines when none exist", async () => {
    const db = createMockD1({ onQuery: () => [] });
    const env = createMockEnv(db, { ROLE_MEMORY_ENABLED: "true" });
    const pkg = await buildBootPackage(env, { namespace: "ns" });
    expect(pkg.baselines).toEqual([]);
  });

  it("returns multiple baselines for shared + role", async () => {
    const db = createMockD1({
      onQuery: (sql: string) => {
        if (sql.includes("FROM long_term_baselines")) {
          return [
            { namespace: "ns", role_scope: "shared", content: "共享基线", version: 1, generated_at: "t1" },
            { namespace: "ns", role_scope: "id:alice-001", content: "Alice基线", version: 2, generated_at: "t2" },
          ];
        }
        return [];
      },
    });
    const env = createMockEnv(db, { ROLE_MEMORY_ENABLED: "true" });
    const pkg = await buildBootPackage(env, { namespace: "ns" });
    expect(pkg.baselines).toHaveLength(2);
  });
});
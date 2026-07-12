import { describe, it, expect, vi } from "vitest";
import { createMockD1, createMockEnv } from "../helpers/d1-mock";
import { buildBootPackage } from "../../src/memory/v2/recall";

describe("buildBootPackage — recent_logs (two-day daily log)", () => {
  it("returns a recent_logs field (not yesterday_log)", async () => {
    const db = createMockD1({
      onQuery: () => [],
    });
    const env = createMockEnv(db);

    const pkg = await buildBootPackage(env, { namespace: "ns" });
    expect(pkg).toHaveProperty("recent_logs");
    expect(pkg).not.toHaveProperty("yesterday_log");
  });

  it("returns up to 2 most recent logs sorted by date DESC", async () => {
    const db = createMockD1({
      onQuery: (sql) => {
        if (sql.includes("FROM daily_log")) {
          return [
            { namespace: "ns", date: "2025-07-10", title: "A", summary: "a", updated_at: "t1" },
            { namespace: "ns", date: "2025-07-09", title: "B", summary: "b", updated_at: "t2" },
          ];
        }
        if (sql.includes("FROM precious")) return [];
        if (sql.includes("FROM glossary")) return [];
        return [];
      },
    });
    const env = createMockEnv(db);

    const pkg = await buildBootPackage(env, { namespace: "ns" });
    expect(pkg.recent_logs).toHaveLength(2);
    expect(pkg.recent_logs[0].date).toBe("2025-07-10");
    expect(pkg.recent_logs[1].date).toBe("2025-07-09");
  });

  it("returns empty recent_logs when no daily logs exist", async () => {
    const db = createMockD1({ onQuery: () => [] });
    const env = createMockEnv(db);

    const pkg = await buildBootPackage(env, { namespace: "ns" });
    expect(pkg.recent_logs).toEqual([]);
  });

  it("returns 1 log when only 1 exists", async () => {
    const db = createMockD1({
      onQuery: (sql) => {
        if (sql.includes("FROM daily_log")) {
          return [
            { namespace: "ns", date: "2025-07-09", title: "T", summary: "S", updated_at: "u" },
          ];
        }
        return [];
      },
    });
    const env = createMockEnv(db);

    const pkg = await buildBootPackage(env, { namespace: "ns" });
    expect(pkg.recent_logs).toHaveLength(1);
    expect(pkg.recent_logs[0].date).toBe("2025-07-09");
  });

  it("calls getRecentDailyLogs (not getDailyLog) to fetch logs", async () => {
    const db = createMockD1({
      onQuery: (sql) => {
        // getRecentDailyLogs uses ORDER BY date DESC LIMIT
        // getDailyLog uses WHERE namespace = ? AND date = ?
        if (sql.includes("FROM daily_log") && sql.includes("ORDER BY date DESC")) {
          return [];
        }
        if (sql.includes("FROM daily_log")) {
          // This is the old getDailyLog path — should NOT be called anymore.
          throw new Error("getDailyLog should not be called; use getRecentDailyLogs");
        }
        return [];
      },
    });
    const env = createMockEnv(db);

    // Should not throw — getDailyLog must not be called.
    await expect(buildBootPackage(env, { namespace: "ns" })).resolves.toBeDefined();
  });

  it("preserves digest and precious and glossary fields", async () => {
    const db = createMockD1({
      onQuery: (sql) => {
        if (sql.includes("FROM digest")) {
          return [{ namespace: "ns", content: "用户喜欢凌晨工作", updated_at: "t" }];
        }
        if (sql.includes("FROM precious")) {
          return [{ id: "p1", content: "用户有焦虑倾向", created_at: "2025-01-01" }];
        }
        if (sql.includes("FROM glossary")) {
          return [{ term: "MCP", definition: "Model Context Protocol", aliases: "[]" }];
        }
        return [];
      },
    });
    const env = createMockEnv(db);

    const pkg = await buildBootPackage(env, { namespace: "ns" });
    expect(pkg.digest).toBeTruthy();
    expect(pkg.digest?.content).toBe("用户喜欢凌晨工作");
    expect(pkg.precious).toHaveLength(1);
    expect(pkg.glossary).toHaveLength(1);
  });
});
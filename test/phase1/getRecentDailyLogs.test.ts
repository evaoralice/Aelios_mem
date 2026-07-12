import { describe, it, expect } from "vitest";
import { createMockD1 } from "../helpers/d1-mock";
import { getRecentDailyLogs, type DailyLogRow } from "../../src/db/v2";

describe("getRecentDailyLogs", () => {
  it("should be exported as a function from db/v2", () => {
    expect(typeof getRecentDailyLogs).toBe("function");
  });

  it("returns the most recent N rows ordered by date DESC", async () => {
    const db = createMockD1({
      onQuery: (sql) => {
        expect(sql).toContain("FROM daily_log");
        expect(sql).toContain("ORDER BY date DESC");
        expect(sql).toContain("LIMIT");
        return [
          { namespace: "ns", date: "2025-07-10", title: "D", summary: "s4", updated_at: "t4" },
          { namespace: "ns", date: "2025-07-09", title: "C", summary: "s3", updated_at: "t3" },
        ];
      },
    });

    const rows = await getRecentDailyLogs(db, { namespace: "ns", limit: 2 });
    expect(rows).toHaveLength(2);
    expect(rows[0].date).toBe("2025-07-10");
    expect(rows[1].date).toBe("2025-07-09");
  });

  it("passes namespace and limit as bind params", async () => {
    let capturedArgs: any[] = [];
    const db = createMockD1({
      onQuery: (_sql, args) => {
        capturedArgs = args;
        return [];
      },
    });

    await getRecentDailyLogs(db, { namespace: "user42", limit: 2 });
    expect(capturedArgs).toEqual(["user42", 2]);
  });

  it("returns empty array when no logs exist", async () => {
    const db = createMockD1({ onQuery: () => [] });
    const rows = await getRecentDailyLogs(db, { namespace: "ns", limit: 2 });
    expect(rows).toEqual([]);
  });

  it("returns only 1 row when only 1 exists even with limit=2", async () => {
    const db = createMockD1({
      onQuery: () => [
        { namespace: "ns", date: "2025-07-09", title: "T", summary: "S", updated_at: "u" },
      ],
    });
    const rows = await getRecentDailyLogs(db, { namespace: "ns", limit: 2 });
    expect(rows).toHaveLength(1);
  });

  it("respects namespace filter (only returns rows for requested namespace)", async () => {
    let capturedArgs: any[] = [];
    const db = createMockD1({
      onQuery: (_sql, args) => {
        capturedArgs = args;
        return [
          { namespace: args[0], date: "2025-07-09", title: "T", summary: "S", updated_at: "u" },
        ];
      },
    });
    await getRecentDailyLogs(db, { namespace: "specific-ns", limit: 2 });
    expect(capturedArgs[0]).toBe("specific-ns");
  });

  it("returns rows matching DailyLogRow shape", async () => {
    const db = createMockD1({
      onQuery: () => [
        {
          namespace: "ns",
          date: "2025-07-10",
          title: "T1",
          summary: "S1",
          updated_at: "2025-07-10T01:00:00Z",
        },
      ],
    });
    const rows = await getRecentDailyLogs(db, { namespace: "ns", limit: 2 });
    const row = rows[0] as DailyLogRow;
    expect(row).toHaveProperty("namespace");
    expect(row).toHaveProperty("date");
    expect(row).toHaveProperty("title");
    expect(row).toHaveProperty("summary");
    expect(row).toHaveProperty("updated_at");
  });
});
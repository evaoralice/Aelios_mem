import { describe, it, expect, vi } from "vitest";
import { createMockD1, createMockEnv } from "../helpers/d1-mock";
import worker from "../../src/index";

vi.mock("../../src/api/health", () => ({ handleHealth: vi.fn(async () => new Response("ok")) }));

const PRECIOUS_ROW = {
  id: "pcz_001",
  namespace: "default",
  content: "用户说这句话很重要",
  context_message_ids: "[]",
  source: "human",
  pinned: 1,
  created_at: "2026-08-01T00:00:00Z",
  last_injected_at: null,
  status: "active",
};

function makeAuthedRequest(method: string, pathname: string): Request {
  return new Request(`https://aelios.test${pathname}`, {
    method,
    headers: { authorization: "Bearer test-key" },
  });
}

describe("precious soft delete", () => {
  it("DELETE 软删：UPDATE status='deleted' 而非 DELETE FROM", async () => {
    let executedSql = "";
    const db = createMockD1({
      onRun: (sql) => {
        executedSql = sql;
      },
      onQuery: () => [],
    });
    const env = { ...createMockEnv(db), CHATBOX_API_KEY: "test-key" } as any;
    const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any;

    const res = await worker.fetch!(
      makeAuthedRequest("DELETE", "/v1/precious/pcz_001"),
      env,
      ctx
    );
    expect(res.status).toBe(200);
    // 应该是 UPDATE 软删，不是 DELETE FROM
    expect(executedSql).toContain("UPDATE precious SET status");
    expect(executedSql).toContain("'deleted'");
    expect(executedSql).not.toContain("DELETE FROM");
  });

  it("listPrecious 只返回 status='active' 的行", async () => {
    let capturedSql = "";
    const db = createMockD1({
      onQuery: (sql) => {
        if (sql.includes("FROM precious")) {
          capturedSql = sql;
          return [PRECIOUS_ROW];
        }
        return [];
      },
    });
    const env = { ...createMockEnv(db), CHATBOX_API_KEY: "test-key" } as any;
    const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any;

    await worker.fetch!(makeAuthedRequest("GET", "/v1/precious"), env, ctx);
    expect(capturedSql).toContain("status = 'active'");
  });

  it("DELETE 已删除的 mock 不匹配时返回 404", async () => {
    let executedSql = "";
    const db = createMockD1({
      onRun: (sql) => {
        executedSql = sql;
      },
      onQuery: () => [],
    });
    const env = { ...createMockEnv(db), CHATBOX_API_KEY: "test-key" } as any;
    const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any;

    const res = await worker.fetch!(
      makeAuthedRequest("DELETE", "/v1/precious/pcz_001"),
      env,
      ctx
    );
    expect(res.status).toBe(200);
    expect(executedSql).toContain("UPDATE precious SET status");
  });
});
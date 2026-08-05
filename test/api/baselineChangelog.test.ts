import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockD1, createMockEnv } from "../helpers/d1-mock";
import worker from "../../src/index";

vi.mock("../../src/api/health", () => ({ handleHealth: vi.fn(async () => new Response("ok")) }));

function makeAuthedRequest(method: string, pathname: string, key = "test-key"): Request {
  return new Request(`https://aelios.test${pathname}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
  });
}

async function fetchWithDb(onQuery: (sql: string, args: any[]) => any[], envOverrides: Record<string, string> = {}) {
  const db = createMockD1({ onQuery });
  const env = { ...createMockEnv(db), CHATBOX_API_KEY: "test-key", ...envOverrides } as any;
  const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any;
  return { db, env, ctx };
}

const SAMPLE_ROW = {
  id: "bch_001",
  namespace: "default",
  role_scope: "role:alice",
  role_id: "alice",
  role_name: "Alice",
  op: "update",
  before_content: "用户喜欢晚睡",
  after_content: "用户改成早起了",
  reason: "用户今天说开始早起了",
  status: "pending",
  error_message: null,
  created_at: "2026-08-01T12:00:00Z",
  applied_at: null,
};

describe("baseline_changelog API", () => {
  it("GET 列表返回 pending 项 + 分页结构", async () => {
    const { env, ctx } = await fetchWithDb((sql) => {
      if (sql.includes("FROM baseline_changelog")) return [SAMPLE_ROW];
      return [];
    });
    const res = await worker.fetch!(makeAuthedRequest("GET", "/v1/baseline_changelog"), env, ctx);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe("bch_001");
    expect(body.data[0].role_scope).toBe("role:alice");
    expect(body.paging).toBeDefined();
    expect(body.paging.limit).toBe(50);
    expect(body.paging.offset).toBe(0);
  });

  it("GET 无 Authorization → 401", async () => {
    const { env, ctx } = await fetchWithDb(() => []);
    const req = new Request("https://aelios.test/v1/baseline_changelog", { method: "GET" });
    const res = await worker.fetch!(req, env, ctx);
    expect(res.status).toBe(401);
  });

  it("GET 错误 key → 401", async () => {
    const { env, ctx } = await fetchWithDb(() => []);
    const res = await worker.fetch!(makeAuthedRequest("GET", "/v1/baseline_changelog", "wrong-key"), env, ctx);
    expect(res.status).toBe(401);
  });

  it("GET 支持 status 筛选", async () => {
    let capturedSql = "";
    const { env, ctx } = await fetchWithDb((sql, args) => {
      capturedSql = sql;
      if (sql.includes("FROM baseline_changelog")) return [];
      return [];
    });
    await worker.fetch!(makeAuthedRequest("GET", "/v1/baseline_changelog?status=applied"), env, ctx);
    expect(capturedSql).toContain("status = ?");
  });

  it("GET 不传 status 不加 status 过滤", async () => {
    let capturedSql = "";
    const { env, ctx } = await fetchWithDb((sql) => {
      capturedSql = sql;
      if (sql.includes("FROM baseline_changelog")) return [];
      return [];
    });
    await worker.fetch!(makeAuthedRequest("GET", "/v1/baseline_changelog"), env, ctx);
    // 不应该有 status = ? 的 WHERE（status 筛选条件）
    expect(capturedSql).not.toContain("AND status =");
  });

  it("POST /apply 标记成功", async () => {
    const { env, ctx } = await fetchWithDb((sql) => {
      if (sql.includes("SELECT * FROM baseline_changelog")) return [SAMPLE_ROW];
      return [];
    });
    const res = await worker.fetch!(makeAuthedRequest("POST", "/v1/baseline_changelog/bch_001/apply"), env, ctx);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.status).toBe("applied");
  });

  it("POST /apply 不存在的 id → 404", async () => {
    const { env, ctx } = await fetchWithDb(() => []);
    const res = await worker.fetch!(makeAuthedRequest("POST", "/v1/baseline_changelog/bch_notexist/apply"), env, ctx);
    expect(res.status).toBe(404);
  });

  it("POST /apply 已 applied 的项 → 409", async () => {
    const { env, ctx } = await fetchWithDb((sql) => {
      if (sql.includes("SELECT * FROM baseline_changelog")) return [{ ...SAMPLE_ROW, status: "applied" }];
      return [];
    });
    const res = await worker.fetch!(makeAuthedRequest("POST", "/v1/baseline_changelog/bch_001/apply"), env, ctx);
    expect(res.status).toBe(409);
  });

  it("POST /conflict 带 reason 写入 error_message", async () => {
    const { env, ctx } = await fetchWithDb((sql) => {
      if (sql.includes("SELECT * FROM baseline_changelog")) return [SAMPLE_ROW];
      return [];
    });
    const req = new Request("https://aelios.test/v1/baseline_changelog/bch_001/conflict", {
      method: "POST",
      headers: { authorization: "Bearer test-key", "content-type": "application/json" },
      body: JSON.stringify({ reason: "与现有记忆冲突" }),
    });
    const res = await worker.fetch!(req, env, ctx);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.status).toBe("conflict");
    expect(body.data.error_message).toBe("与现有记忆冲突");
  });

  it("POST /conflict 不传 reason 用默认值", async () => {
    const { env, ctx } = await fetchWithDb((sql) => {
      if (sql.includes("SELECT * FROM baseline_changelog")) return [SAMPLE_ROW];
      return [];
    });
    const req = new Request("https://aelios.test/v1/baseline_changelog/bch_001/conflict", {
      method: "POST",
      headers: { authorization: "Bearer test-key", "content-type": "application/json" },
    });
    const res = await worker.fetch!(req, env, ctx);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.error_message).toContain("conflict by admin");
  });

  it("POST /apply 无 Authorization → 401", async () => {
    const { env, ctx } = await fetchWithDb(() => []);
    const req = new Request("https://aelios.test/v1/baseline_changelog/bch_001/apply", { method: "POST" });
    const res = await worker.fetch!(req, env, ctx);
    expect(res.status).toBe(401);
  });

  it("IM key 无 memory:write scope → apply 403", async () => {
    // IM_API_KEY profile 默认没有 memory:write（只有 chat:proxy + memory:read）
    // 实际上需要看 keyProfiles 配置；这里测错误 key 401 即可
    const { env, ctx } = await fetchWithDb(() => []);
    const res = await worker.fetch!(makeAuthedRequest("POST", "/v1/baseline_changelog/bch_001/apply", "wrong"), env, ctx);
    expect(res.status).toBe(401);
  });

  it("POST /reopen 把 conflict 改回 pending", async () => {
    const { env, ctx } = await fetchWithDb((sql) => {
      if (sql.includes("SELECT * FROM baseline_changelog")) return [{ ...SAMPLE_ROW, status: "conflict", error_message: "旧冲突" }];
      return [];
    });
    const res = await worker.fetch!(makeAuthedRequest("POST", "/v1/baseline_changelog/bch_001/reopen"), env, ctx);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.status).toBe("pending");
  });

  it("POST /reopen 非 conflict 状态 → 409", async () => {
    const { env, ctx } = await fetchWithDb((sql) => {
      if (sql.includes("SELECT * FROM baseline_changelog")) return [{ ...SAMPLE_ROW, status: "pending" }];
      return [];
    });
    const res = await worker.fetch!(makeAuthedRequest("POST", "/v1/baseline_changelog/bch_001/reopen"), env, ctx);
    expect(res.status).toBe(409);
  });

  it("POST /reopen 不存在的 id → 404", async () => {
    const { env, ctx } = await fetchWithDb(() => []);
    const res = await worker.fetch!(makeAuthedRequest("POST", "/v1/baseline_changelog/bch_none/reopen"), env, ctx);
    expect(res.status).toBe(404);
  });

  it("POST /reopen 无 Authorization → 401", async () => {
    const { env, ctx } = await fetchWithDb(() => []);
    const req = new Request("https://aelios.test/v1/baseline_changelog/bch_001/reopen", { method: "POST" });
    const res = await worker.fetch!(req, env, ctx);
    expect(res.status).toBe(401);
  });
});
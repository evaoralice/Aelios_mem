import { describe, it, expect, vi } from "vitest";
import { createMockEnv } from "../helpers/d1-mock";

// 路由会命中 /health，需要 mock handleHealth 返回的依赖（db 等）。
// 这里直接测 fetch 入口的行为，不依赖具体 handler 逻辑。
vi.mock("../../src/api/health", () => ({
  handleHealth: vi.fn(async () => new Response("ok", { status: 200 })),
}));
vi.mock("../../src/api/models", () => ({
  handleModels: vi.fn(async () => new Response("{}", { status: 200 })),
}));
vi.mock("../../src/api/admin", () => ({
  handleAdmin: vi.fn(async () => new Response("<html></html>", { status: 200 })),
}));
// 屏蔽 mcp 的 OPTIONS 分支（入口已拦截 OPTIONS，不会进到这里）
vi.mock("../../src/api/mcp", () => ({
  handleMcp: vi.fn(async () => new Response("{}", { status: 200 })),
}));

import worker from "../../src/index";

function makeRequest(
  method: string,
  pathname: string,
  origin?: string
): Request {
  const headers: Record<string, string> = {};
  if (origin) headers["origin"] = origin;
  return new Request(`https://aelios.test${pathname}`, { method, headers });
}

async function fetchWithEnv(
  request: Request,
  envOverrides: Record<string, string> = {}
): Promise<Response> {
  const env = { ...createMockEnv(), ...envOverrides } as any;
  const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any;
  return worker.fetch!(request, env, ctx);
}

describe("CORS whitelist middleware", () => {
  it("未配置 CORS_ALLOW_ORIGINS 时不返回任何 CORS 头（保持现状）", async () => {
    const req = makeRequest("GET", "/health", "https://memoria.pages.dev");
    const res = await fetchWithEnv(req, {});
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("vary")).toBeNull();
  });

  it("未配置时 OPTIONS 请求进路由（不拦截）", async () => {
    const req = makeRequest("OPTIONS", "/health");
    const res = await fetchWithEnv(req, {});
    // /health 不匹配 OPTIONS，会落到 404
    expect(res.status).toBe(404);
  });

  it("配置白名单 + Origin 匹配 → 响应带 Access-Control-Allow-Origin", async () => {
    const allowed = "https://memoria.pages.dev";
    const req = makeRequest("GET", "/health", allowed);
    const res = await fetchWithEnv(req, {
      CORS_ALLOW_ORIGINS: "https://memoria.pages.dev",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(allowed);
    expect(res.headers.get("vary")).toBe("Origin");
  });

  it("配置白名单 + Origin 不匹配 → 不带 CORS 头", async () => {
    const req = makeRequest("GET", "/health", "https://evil.com");
    const res = await fetchWithEnv(req, {
      CORS_ALLOW_ORIGINS: "https://memoria.pages.dev",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("配置白名单 + 无 Origin 头 → 不带 CORS 头", async () => {
    const req = makeRequest("GET", "/health");
    const res = await fetchWithEnv(req, {
      CORS_ALLOW_ORIGINS: "https://memoria.pages.dev",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("OPTIONS 预检 + Origin 匹配 → 204 + 完整 CORS 头", async () => {
    const allowed = "https://memoria.pages.dev";
    const req = makeRequest("OPTIONS", "/v1/chat/completions", allowed);
    const res = await fetchWithEnv(req, {
      CORS_ALLOW_ORIGINS: "https://memoria.pages.dev",
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(allowed);
    expect(res.headers.get("access-control-allow-methods")).toContain("GET");
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    expect(res.headers.get("access-control-allow-headers")).toContain("Authorization");
    expect(res.headers.get("access-control-max-age")).toBe("86400");
    expect(res.headers.get("vary")).toBe("Origin");
  });

  it("OPTIONS 预检 + Origin 不匹配 → 204 无 CORS 头", async () => {
    const req = makeRequest("OPTIONS", "/v1/chat/completions", "https://evil.com");
    const res = await fetchWithEnv(req, {
      CORS_ALLOW_ORIGINS: "https://memoria.pages.dev",
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("多个 Origin 白名单精确匹配", async () => {
    const req = makeRequest("GET", "/health", "https://b.example.com");
    const res = await fetchWithEnv(req, {
      CORS_ALLOW_ORIGINS: "https://a.example.com, https://b.example.com",
    });
    expect(res.headers.get("access-control-allow-origin")).toBe("https://b.example.com");
  });

  it("精确匹配不会被前缀绕过（evil.memoria.pages.dev 不应通过）", async () => {
    const req = makeRequest("GET", "/health", "https://evil.memoria.pages.dev");
    const res = await fetchWithEnv(req, {
      CORS_ALLOW_ORIGINS: "https://memoria.pages.dev",
    });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("仍带 x-robots-tag 头（与 CORS 互不影响）", async () => {
    const req = makeRequest("GET", "/health", "https://memoria.pages.dev");
    const res = await fetchWithEnv(req, {
      CORS_ALLOW_ORIGINS: "https://memoria.pages.dev",
    });
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });
});
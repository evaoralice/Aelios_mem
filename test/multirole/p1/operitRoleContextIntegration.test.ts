import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

describe("Operit 角色标记 — chatCompletions 集成不变量 (源码扫描)", () => {
  const src = readFileSync(resolve(__dirname, "../../../src/api/chatCompletions.ts"), "utf-8");

  it("调用了 extractOperitRoleContext 解析标记", () => {
    expect(src).toMatch(/extractOperitRoleContext\(body\.messages\)/);
  });

  it("顶层 role_id 优先于标记 (?? operitRole?.role_id)", () => {
    // readString(body.role_id) ?? operitRole?.role_id ?? null — 顶层在前, 标记在后
    expect(src).toMatch(/readString\(body\.role_id\)\s*\?\?\s*\(operitRole\?\.role_id\s*\?\?\s*null\)/);
  });

  it("顶层 role_name 优先于标记", () => {
    expect(src).toMatch(/readString\(body\.role_name\)\s*\?\?\s*\(operitRole\?\.role_name\s*\?\?\s*null\)/);
  });

  it("解析后替换 body.messages 为清理后的 messages", () => {
    expect(src).toMatch(/body\.messages\s*=\s*strippedMessages/);
  });

  it("saveUserMessages 使用 body.messages (清理后), 不接触原始标记", () => {
    // saveUserMessages 收到的 messages 应是 body.messages (已被替换为 strippedMessages)
    expect(src).toMatch(/messages:\s*body\.messages/);
  });

  it("assemble 调用使用 request: body (body.messages 已被替换为清理后)", () => {
    const assembleCalls = src.match(/assemble\(\{[\s\S]*?\}\)/g) ?? [];
    expect(assembleCalls.length).toBeGreaterThan(0);
    for (const call of assembleCalls) {
      expect(call).toMatch(/request:\s*body/);
    }
  });

  it("extractLastUserText 使用 body.messages (清理后)", () => {
    expect(src).toMatch(/extractLastUserText\(body\.messages\)/);
  });

  it("标记在 JSON body 校验后立即解析 (位于 resolveTargetModel 调用之前)", () => {
    const parseIdx = src.indexOf("extractOperitRoleContext");
    // 找 resolveTargetModel 的调用 (非 import), 即 "resolveTargetModel(" 后跟参数
    const resolveCallMatch = src.match(/=\s*resolveTargetModel\(/);
    expect(resolveCallMatch).toBeTruthy();
    const resolveIdx = resolveCallMatch!.index!;
    expect(parseIdx).toBeGreaterThan(0);
    expect(resolveIdx).toBeGreaterThan(0);
    expect(parseIdx).toBeLessThan(resolveIdx);
  });
});
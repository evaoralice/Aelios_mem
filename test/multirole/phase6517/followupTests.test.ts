import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

describe("Phase 6: update/delete ownership semantics", () => {
  it("memory_change_update schema does NOT accept role_id/role_name", () => {
    const src = readFileSync(resolve(__dirname, "../../../src/api/mcp.ts"), "utf-8");
    const section = src.match(/name:\s*"memory_change_update"[\s\S]*?required:/);
    expect(section).toBeTruthy();
    // Check the properties block specifically (not the description text)
    const propsMatch = section![0].match(/properties:\s*\{([\s\S]*?)\}/);
    if (propsMatch) {
      expect(propsMatch[1]).not.toMatch(/role_id/);
      expect(propsMatch[1]).not.toMatch(/role_name/);
    }
  });

  it("memory_change_delete schema does NOT accept role_id/role_name", () => {
    const src = readFileSync(resolve(__dirname, "../../../src/api/mcp.ts"), "utf-8");
    const section = src.match(/name:\s*"memory_change_delete"[\s\S]*?required:/);
    expect(section).toBeTruthy();
    expect(section![0]).not.toMatch(/role_id/);
    expect(section![0]).not.toMatch(/role_name/);
  });

  it("applyPendingChanges update does NOT pass roleId/roleName from changelog", () => {
    const src = readFileSync(resolve(__dirname, "../../../src/memory/dailyDigest.ts"), "utf-8");
    // The update branch should NOT have roleId: entry.role_id
    const updateSection = src.match(/entry\.op === "update"[\s\S]*?entry\.op === "delete"/);
    expect(updateSection).toBeTruthy();
    expect(updateSection![0]).not.toMatch(/roleId:\s*entry\.role_id/);
    expect(updateSection![0]).not.toMatch(/roleName:\s*entry\.role_name/);
  });
});

describe("Phase 5: daily_log role scope", () => {
  it("upsertDailyLog accepts roleScope param", () => {
    const src = readFileSync(resolve(__dirname, "../../../src/db/v2.ts"), "utf-8");
    expect(src).toMatch(/upsertDailyLog[\s\S]*?roleScope/);
  });

  it("buildBootPackage accepts roleId/roleName", () => {
    const src = readFileSync(resolve(__dirname, "../../../src/memory/v2/recall.ts"), "utf-8");
    expect(src).toMatch(/buildBootPackage[\s\S]*?roleId/);
  });

  it("daily_log write in dailyDigest passes roleScope", () => {
    const src = readFileSync(resolve(__dirname, "../../../src/memory/dailyDigest.ts"), "utf-8");
    expect(src).toMatch(/upsertDailyLog[\s\S]*?roleScope/);
  });
});

describe("Phase 1: multi-role dream grouping wired", () => {
  it("buildDigestPrompt accepts roleGroups param", () => {
    const src = readFileSync(resolve(__dirname, "../../../src/memory/dailyDigest.ts"), "utf-8");
    expect(src).toMatch(/roleGroups/);
    // No TODO about "not yet wired"
    expect(src).not.toMatch(/TODO.*multi-role prompt.*wired/);
  });

  it("runDailyMemoryDigest computes roleGroups before buildDigestPrompt", () => {
    const src = readFileSync(resolve(__dirname, "../../../src/memory/dailyDigest.ts"), "utf-8");
    // roleGroups should be computed before buildDigestPrompt call
    const roleGroupsIdx = src.indexOf("roleGroups");
    const promptIdx = src.indexOf("buildDigestPrompt({");
    expect(roleGroupsIdx).toBeGreaterThan(-1);
    expect(promptIdx).toBeGreaterThan(-1);
    // There should be a roleGroups computation before the prompt call
    expect(roleGroupsIdx).toBeLessThan(promptIdx);
  });

  it("DREAM_MAX_ROLES_PER_RUN is in Env type", () => {
    const src = readFileSync(resolve(__dirname, "../../../src/types.ts"), "utf-8");
    expect(src).toMatch(/DREAM_MAX_ROLES_PER_RUN/);
  });

  it("DREAM_MAX_ROLES_PER_RUN is read in dailyDigest", () => {
    const src = readFileSync(resolve(__dirname, "../../../src/memory/dailyDigest.ts"), "utf-8");
    expect(src).toMatch(/DREAM_MAX_ROLES_PER_RUN/);
  });
});
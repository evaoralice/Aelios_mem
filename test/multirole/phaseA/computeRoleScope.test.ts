import { describe, it, expect } from "vitest";
import { computeRoleScope, isSharedScope } from "../../../src/utils/role";

describe("computeRoleScope", () => {
  it("returns 'shared' when both roleId and roleName are null/undefined/empty", () => {
    expect(computeRoleScope()).toBe("shared");
    expect(computeRoleScope(null, null)).toBe("shared");
    expect(computeRoleScope(undefined, "")).toBe("shared");
    expect(computeRoleScope("", "")).toBe("shared");
  });

  it("returns 'id:<roleId>' when roleId is present", () => {
    expect(computeRoleScope("alice-001", "Alice")).toBe("id:alice-001");
    expect(computeRoleScope("abc123", null)).toBe("id:abc123");
  });

  it("returns 'name:<normalized>' when only roleName is present", () => {
    expect(computeRoleScope(null, "Alice")).toBe("name:Alice");
    expect(computeRoleScope(undefined, "Bob")).toBe("name:Bob");
  });

  it("trims and NFKC-normalizes the name", () => {
    expect(computeRoleScope(null, "  Alice  ")).toBe("name:Alice");
    expect(computeRoleScope(null, "\u3000\uFF21lice")).toBe("name:Alice");
  });

  it("falls back to 'shared' when name is only whitespace", () => {
    expect(computeRoleScope(null, "   ")).toBe("shared");
    expect(computeRoleScope(null, "\t\n")).toBe("shared");
  });

  it("roleId takes precedence over roleName", () => {
    expect(computeRoleScope("id1", "Name1")).toBe("id:id1");
  });

  it("empty string roleId falls through to name logic", () => {
    expect(computeRoleScope("", "Alice")).toBe("name:Alice");
  });
});

describe("isSharedScope", () => {
  it("returns true for 'shared'", () => {
    expect(isSharedScope("shared")).toBe(true);
  });

  it("returns false for any non-shared scope", () => {
    expect(isSharedScope("id:alice-001")).toBe(false);
    expect(isSharedScope("name:Alice")).toBe(false);
  });
});
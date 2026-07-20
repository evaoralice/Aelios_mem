import { describe, it, expect } from "vitest";
import { stripRoleContextFromMessages } from "../../src/utils/roleContext";
import type { OpenAIChatMessage } from "../../src/types";

describe("Operit 角色身份标记解析", () => {
  it("从 system 消息解析 role_id + role_name", () => {
    const messages: OpenAIChatMessage[] = [
      {
        role: "system",
        content: "你是助手。\n<aelios_role_context>\n{\"role_id\":\"card-alice-001\",\"role_name\":\"Alice\"}\n</aelios_role_context>",
      },
      { role: "user", content: "hi" },
    ];
    const { messages: cleaned, roleContext } = stripRoleContextFromMessages(messages);
    expect(roleContext).toEqual({ role_id: "card-alice-001", role_name: "Alice" });
    // 标记应从 system 内容中剥离
    const sysContent = typeof cleaned[0].content === "string" ? cleaned[0].content : "";
    expect(sysContent).not.toContain("<aelios_role_context>");
    expect(sysContent).toContain("你是助手。");
    // user 消息不变
    expect(cleaned[1].content).toBe("hi");
  });

  it("无标记时返回原 messages 不修改", () => {
    const messages: OpenAIChatMessage[] = [
      { role: "system", content: "你是助手" },
      { role: "user", content: "hi" },
    ];
    const { messages: cleaned, roleContext } = stripRoleContextFromMessages(messages);
    expect(roleContext).toBeNull();
    expect(cleaned).toBe(messages);
  });

  it("标记在 user 消息中也能解析（system 无标记时回退）", () => {
    const messages: OpenAIChatMessage[] = [
      { role: "system", content: "你是助手" },
      {
        role: "user",
        content: "<aelios_role_context>{\"role_id\":\"bob-002\",\"role_name\":\"Bob\"}</aelios_role_context>\n帮个忙",
      },
    ];
    const { messages: cleaned, roleContext } = stripRoleContextFromMessages(messages);
    expect(roleContext).toEqual({ role_id: "bob-002", role_name: "Bob" });
    const userContent = typeof cleaned[1].content === "string" ? cleaned[1].content : "";
    expect(userContent).not.toContain("<aelios_role_context>");
    expect(userContent).toContain("帮个忙");
  });

  it("system 优先于 user（同存时取 system）", () => {
    const messages: OpenAIChatMessage[] = [
      {
        role: "system",
        content: "<aelios_role_context>{\"role_id\":\"sys-id\",\"role_name\":\"SysName\"}</aelios_role_context>",
      },
      {
        role: "user",
        content: "<aelios_role_context>{\"role_id\":\"user-id\",\"role_name\":\"UserName\"}</aelios_role_context>",
      },
    ];
    const { roleContext } = stripRoleContextFromMessages(messages);
    expect(roleContext).toEqual({ role_id: "sys-id", role_name: "SysName" });
  });

  it("JSON 无效时忽略，不报错", () => {
    const messages: OpenAIChatMessage[] = [
      { role: "system", content: "<aelios_role_context>not json</aelios_role_context>" },
    ];
    const { roleContext } = stripRoleContextFromMessages(messages);
    expect(roleContext).toBeNull();
  });

  it("只有 role_id 没有 role_name 也能解析", () => {
    const messages: OpenAIChatMessage[] = [
      { role: "system", content: "<aelios_role_context>{\"role_id\":\"only-id\"}</aelios_role_context>" },
    ];
    const { roleContext } = stripRoleContextFromMessages(messages);
    expect(roleContext).toEqual({ role_id: "only-id", role_name: null });
  });

  it("只有 role_name 没有 role_id 也能解析", () => {
    const messages: OpenAIChatMessage[] = [
      { role: "system", content: "<aelios_role_context>{\"role_name\":\"OnlyName\"}</aelios_role_context>" },
    ];
    const { roleContext } = stripRoleContextFromMessages(messages);
    expect(roleContext).toEqual({ role_id: null, role_name: "OnlyName" });
  });

  it("字段都为空时不解析", () => {
    const messages: OpenAIChatMessage[] = [
      { role: "system", content: "<aelios_role_context>{}</aelios_role_context>" },
    ];
    const { roleContext } = stripRoleContextFromMessages(messages);
    expect(roleContext).toBeNull();
  });

  it("闭合标签缺失时不解析也不删内容", () => {
    const messages: OpenAIChatMessage[] = [
      { role: "system", content: "<aelios_role_context>{\"role_id\":\"x\"}" },
    ];
    const { messages: cleaned, roleContext } = stripRoleContextFromMessages(messages);
    expect(roleContext).toBeNull();
    expect(cleaned[0].content).toBe("<aelios_role_context>{\"role_id\":\"x\"}");
  });

  it("array content 也能解析", () => {
    const messages: OpenAIChatMessage[] = [
      {
        role: "system",
        content: [
          { type: "text", text: "你是助手" },
          { type: "text", text: "<aelios_role_context>{\"role_id\":\"arr-id\",\"role_name\":\"ArrName\"}</aelios_role_context>" },
        ] as any,
      },
    ];
    const { roleContext } = stripRoleContextFromMessages(messages);
    expect(roleContext).toEqual({ role_id: "arr-id", role_name: "ArrName" });
  });
});
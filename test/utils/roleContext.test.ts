import { describe, it, expect, vi, beforeEach } from "vitest";
import { extractOperitRoleContext } from "../../src/utils/roleContext";
import type { OpenAIChatMessage } from "../../src/types";

function sys(content: string): OpenAIChatMessage {
  return { role: "system", content };
}
function user(content: string): OpenAIChatMessage {
  return { role: "user", content };
}

function mkTag(json: string): string {
  return `<aelios_role_context>\n${json}\n</aelios_role_context>`;
}

beforeEach(() => {
  vi.clearAllMocks();
  // 抑制 console.warn 噪音
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("Operit 角色身份标记解析 — extractOperitRoleContext", () => {
  describe("顶层优先级 (由调用方实现, 本模块只解析)", () => {
    it("解析独立 SYSTEM 标记消息返回 role_id + role_name", () => {
      const messages = [sys(mkTag(`{"role_id":"card-alice-001","role_name":"Alice"}`)), user("hi")];
      const { messages: cleaned, roleContext } = extractOperitRoleContext(messages);
      expect(roleContext).toEqual({ role_id: "card-alice-001", role_name: "Alice" });
      // 标记 SYSTEM 消息应被删除
      expect(cleaned.length).toBe(1);
      expect(cleaned[0].role).toBe("user");
      expect(cleaned[0].content).toBe("hi");
    });
  });

  describe("只解析独立 SYSTEM 消息", () => {
    it("user 消息中的相同标记不生效且不被剥离", () => {
      const messages = [
        user(mkTag(`{"role_id":"bob-002","role_name":"Bob"}`)),
      ];
      const { messages: cleaned, roleContext } = extractOperitRoleContext(messages);
      expect(roleContext).toBeNull();
      // user 消息保留原样 (不剥离)
      expect(cleaned.length).toBe(1);
      expect(cleaned[0].content).toContain("<aelios_role_context>");
    });

    it("assistant 消息中的相同标记不生效", () => {
      const messages = [
        { role: "assistant", content: mkTag(`{"role_id":"asst","role_name":"A"}`) } as OpenAIChatMessage,
      ];
      const { roleContext } = extractOperitRoleContext(messages);
      expect(roleContext).toBeNull();
    });

    it("system 消息含标记但前后有其他文字 (非独立) 不生效", () => {
      const messages = [
        sys(`你是助手。\n${mkTag(`{"role_id":"embedded","role_name":"E"}`)}\n更多内容`),
      ];
      const { roleContext } = extractOperitRoleContext(messages);
      // 前后非空白内容 → 非独立 → 不解析
      expect(roleContext).toBeNull();
    });

    it("system 消息只含标记 + 前后空白 (独立) 生效", () => {
      const messages = [
        sys(`  \n${mkTag(`{"role_id":"standalone","role_name":"S"}`)}\n  `),
      ];
      const { roleContext } = extractOperitRoleContext(messages);
      expect(roleContext).toEqual({ role_id: "standalone", role_name: "S" });
    });
  });

  describe("严格 JSON 解析与字段限制", () => {
    it("非法 JSON 不生效并剥离标记 + warn", () => {
      const messages = [sys(mkTag(`not json`))];
      const { messages: cleaned, roleContext } = extractOperitRoleContext(messages);
      expect(roleContext).toBeNull();
      // 疑似标记消息被删除
      expect(cleaned.length).toBe(0);
      expect(console.warn).toHaveBeenCalled();
    });

    it("字段超长 (>200) 不生效并剥离", () => {
      const longId = "x".repeat(201);
      const messages = [sys(mkTag(`{"role_id":"${longId}","role_name":"X"}`))];
      const { roleContext } = extractOperitRoleContext(messages);
      expect(roleContext).toBeNull();
    });

    it("role_id 非字符串不生效", () => {
      const messages = [sys(mkTag(`{"role_id":123,"role_name":"X"}`))];
      const { roleContext } = extractOperitRoleContext(messages);
      expect(roleContext).toBeNull();
    });

    it("含未知字段不生效 (严格白名单)", () => {
      const messages = [sys(mkTag(`{"role_id":"x","role_name":"X","extra":"bad"}`))];
      const { roleContext } = extractOperitRoleContext(messages);
      expect(roleContext).toBeNull();
    });

    it("只有 role_id 没有 role_name 生效", () => {
      const messages = [sys(mkTag(`{"role_id":"only-id"}`))];
      const { roleContext } = extractOperitRoleContext(messages);
      expect(roleContext).toEqual({ role_id: "only-id", role_name: null });
    });

    it("只有 role_name 没有 role_id 生效", () => {
      const messages = [sys(mkTag(`{"role_name":"OnlyName"}`))];
      const { roleContext } = extractOperitRoleContext(messages);
      expect(roleContext).toEqual({ role_id: null, role_name: "OnlyName" });
    });

    it("字段都为空不生效", () => {
      const messages = [sys(mkTag(`{}`))];
      const { roleContext } = extractOperitRoleContext(messages);
      expect(roleContext).toBeNull();
    });
  });

  describe("多标记策略", () => {
    it("多个有效标记: 拒绝全部并回退 null", () => {
      const messages = [
        sys(mkTag(`{"role_id":"a","role_name":"A"}`)),
        sys(mkTag(`{"role_id":"b","role_name":"B"}`)),
      ];
      const { messages: cleaned, roleContext } = extractOperitRoleContext(messages);
      expect(roleContext).toBeNull();
      // 所有标记消息都删除
      expect(cleaned.length).toBe(0);
      expect(console.warn).toHaveBeenCalled();
    });

    it("三个有效标记也全部拒绝", () => {
      const messages = [
        sys(mkTag(`{"role_id":"a","role_name":"A"}`)),
        sys(mkTag(`{"role_id":"b","role_name":"B"}`)),
        sys(mkTag(`{"role_id":"c","role_name":"C"}`)),
      ];
      const { roleContext } = extractOperitRoleContext(messages);
      expect(roleContext).toBeNull();
    });
  });

  describe("无标记时不修改 messages", () => {
    it("无任何标记: 返回原 messages 引用", () => {
      const messages = [sys("你是助手"), user("hi")];
      const { messages: cleaned, roleContext } = extractOperitRoleContext(messages);
      expect(roleContext).toBeNull();
      expect(cleaned).toBe(messages);
    });
  });

  describe("array content 不识别为独立 SYSTEM", () => {
    it("array content 即使含标记也不生效 (不字符串化为独立)", () => {
      const messages: OpenAIChatMessage[] = [
        {
          role: "system",
          content: [
            { type: "text", text: mkTag(`{"role_id":"arr","role_name":"A"}`) },
          ] as any,
        },
      ];
      const { roleContext } = extractOperitRoleContext(messages);
      // array content 拼接后虽可能匹配, 但协议要求"独立 SYSTEM message",
      // 此处 array 不视为独立单一字符串标记, 保持严格不识别
      // (实际生产环境 Operit 插件只发字符串 content)
      expect(roleContext).toBeNull();
    });
  });

  describe("残缺标记 (闭合缺失) 必须删除不转发", () => {
    it("闭合标签缺失: 不解析但删除疑似标记 + warn", () => {
      const messages: OpenAIChatMessage[] = [
        { role: "system", content: "<aelios_role_context>{\"role_id\":\"x\"}" },
      ];
      const { messages: cleaned, roleContext } = extractOperitRoleContext(messages);
      expect(roleContext).toBeNull();
      // 残缺标记必须删除, 不转发上游
      expect(cleaned.length).toBe(0);
      expect(console.warn).toHaveBeenCalled();
    });

    it("闭合缺失 + 其他正常消息: 只删残缺标记, 保留其他", () => {
      const messages: OpenAIChatMessage[] = [
        sys("<aelios_role_context>{\"role_id\":\"x\"}"),
        user("hi"),
      ];
      const { messages: cleaned, roleContext } = extractOperitRoleContext(messages);
      expect(roleContext).toBeNull();
      expect(cleaned.length).toBe(1);
      expect(cleaned[0].content).toBe("hi");
    });

    it("闭合缺失 + 一个完整标记: 完整的正常解析, 残缺的删除", () => {
      const messages: OpenAIChatMessage[] = [
        sys(mkTag(`{"role_id":"good","role_name":"G"}`)),
        sys("<aelios_role_context>{\"role_id\":\"bad\"}"),
        user("hi"),
      ];
      const { messages: cleaned, roleContext } = extractOperitRoleContext(messages);
      expect(roleContext).toEqual({ role_id: "good", role_name: "G" });
      // 完整标记解析后删除 + 残缺标记删除, 只剩 user
      expect(cleaned.length).toBe(1);
      expect(cleaned[0].content).toBe("hi");
    });

    it("多个残缺标记: 全部删除 + warn", () => {
      const messages: OpenAIChatMessage[] = [
        sys("<aelios_role_context>bad1"),
        sys("<aelios_role_context>bad2"),
        user("hi"),
      ];
      const { messages: cleaned, roleContext } = extractOperitRoleContext(messages);
      expect(roleContext).toBeNull();
      expect(cleaned.length).toBe(1);
      expect(cleaned[0].content).toBe("hi");
      expect(console.warn).toHaveBeenCalled();
    });
  });
});
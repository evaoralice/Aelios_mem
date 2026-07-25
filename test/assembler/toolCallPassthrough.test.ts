import { describe, it, expect } from "vitest";
import { assemble } from "../../src/assembler/assemble";
import { assembledToOpenAIMessages } from "../../src/assembler/toOpenAI";
import type { OpenAIChatRequest, OpenAIChatMessage } from "../../src/types";

function mkMsg(role: string, content: string, extra: Partial<OpenAIChatMessage> = {}): OpenAIChatMessage {
  return { role: role as OpenAIChatMessage["role"], content, ...extra } as OpenAIChatMessage;
}

function mkRequest(messages: OpenAIChatMessage[]): OpenAIChatRequest {
  return { model: "companion", messages } as OpenAIChatRequest;
}

describe("tool_call/tool_result 透传", () => {
  it("历史里的 assistant tool_calls + tool result 成对保留", () => {
    const messages: OpenAIChatMessage[] = [
      mkMsg("user", "帮我记一下"),
      mkMsg("assistant", "", {
        tool_calls: [
          {
            id: "call_001",
            type: "function",
            function: { name: "memory_upsert", arguments: '{"fact_key":"test","content":"test"}' },
          },
        ],
      }),
      mkMsg("tool", '{"id":"mem_1","created":true}', { tool_call_id: "call_001" }),
      mkMsg("assistant", "已经记好了"),
      mkMsg("user", "谢谢"),
    ];

    const assembled = assemble({
      request: mkRequest(messages),
      pinnedPersonaMemories: null,
      boot: null,
      ragMemories: [],
      visionOutput: null,
    });

    // 历史消息里应该有 4 条（去掉最后一条 user "谢谢"）
    // user, assistant(tool_calls), tool, assistant
    const history = assembled.messages;

    // 找到带 tool_calls 的 assistant 消息
    const toolCallMsg = history.find((m) => m.role === "assistant" && m.tool_calls != null);
    expect(toolCallMsg).toBeDefined();
    expect(toolCallMsg!.tool_calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "call_001",
          type: "function",
          function: expect.objectContaining({ name: "memory_upsert" }),
        }),
      ])
    );

    // 找到 tool result 消息
    const toolResultMsg = history.find((m) => m.role === "tool");
    expect(toolResultMsg).toBeDefined();
    expect(toolResultMsg!.tool_call_id).toBe("call_001");
    expect(toolResultMsg!.content).toContain("mem_1");
  });

  it("多个 tool_call/tool_result 对都保留", () => {
    const messages: OpenAIChatMessage[] = [
      mkMsg("user", "查两个记忆"),
      mkMsg("assistant", "", {
        tool_calls: [
          { id: "call_a", type: "function", function: { name: "memory_search", arguments: '{"query":"cat"}' } },
          { id: "call_b", type: "function", function: { name: "memory_search", arguments: '{"query":"dog"}' } },
        ],
      }),
      mkMsg("tool", "cat results", { tool_call_id: "call_a" }),
      mkMsg("tool", "dog results", { tool_call_id: "call_b" }),
      mkMsg("assistant", "找到了"),
      mkMsg("user", "谢谢"),
    ];

    const assembled = assemble({
      request: mkRequest(messages),
      pinnedPersonaMemories: null,
      boot: null,
      ragMemories: [],
      visionOutput: null,
    });

    const toolResults = assembled.messages.filter((m) => m.role === "tool");
    expect(toolResults.length).toBe(2);
    expect(toolResults[0].tool_call_id).toBe("call_a");
    expect(toolResults[1].tool_call_id).toBe("call_b");
  });

  it("OpenAI 格式输出透传 tool_calls 和 tool_call_id", () => {
    const messages: OpenAIChatMessage[] = [
      mkMsg("user", "记一下"),
      mkMsg("assistant", "", {
        tool_calls: [
          { id: "call_x", type: "function", function: { name: "memory_upsert", arguments: "{}" } },
        ],
      }),
      mkMsg("tool", "ok", { tool_call_id: "call_x" }),
      mkMsg("assistant", "done"),
      mkMsg("user", "谢谢"),
    ];

    const assembled = assemble({
      request: mkRequest(messages),
      pinnedPersonaMemories: null,
      boot: null,
      ragMemories: [],
      visionOutput: null,
    });

    // assembledToOpenAIMessages 应该透传
    const openaiMessages = assembledToOpenAIMessages(assembled.messages);

    const assistantWithTools = openaiMessages.find((m) => m.tool_calls != null);
    expect(assistantWithTools).toBeDefined();
    expect(assistantWithTools!.tool_calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "call_x", function: { name: "memory_upsert", arguments: "{}" } }),
      ])
    );

    const toolMsg = openaiMessages.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.tool_call_id).toBe("call_x");
  });

  it("没有 tool 消息时不受影响", () => {
    const messages: OpenAIChatMessage[] = [
      mkMsg("user", "你好"),
      mkMsg("assistant", "你好！"),
      mkMsg("user", "再见"),
    ];

    const assembled = assemble({
      request: mkRequest(messages),
      pinnedPersonaMemories: null,
      boot: null,
      ragMemories: [],
      visionOutput: null,
    });

    const toolMessages = assembled.messages.filter((m) => m.role === "tool");
    expect(toolMessages.length).toBe(0);
    // 普通消息正常保留（history 2 条 + current_user 1 条 = 3 条）
    expect(assembled.messages.length).toBe(3);
  });

  it("请求以 tool result 结尾时：不拆分 current_user，保持原始顺序", () => {
    const messages: OpenAIChatMessage[] = [
      mkMsg("user", "帮我记一下"),
      mkMsg("assistant", "", {
        tool_calls: [
          { id: "call_end", type: "function", function: { name: "memory_upsert", arguments: "{}" } },
        ],
      }),
      mkMsg("tool", '{"id":"mem_1","created":true}', { tool_call_id: "call_end" }),
    ];

    const assembled = assemble({
      request: mkRequest(messages),
      pinnedPersonaMemories: null,
      boot: null,
      ragMemories: [],
      visionOutput: null,
    });

    // 请求以 tool result 结尾 → current_user 不拆分，全部留在 history
    // 3 条消息都在 history 里，顺序保持原始
    expect(assembled.messages.length).toBe(3);
    expect(assembled.messages[0].role).toBe("user");
    expect(assembled.messages[0].content).toBe("帮我记一下");
    expect(assembled.messages[1].role).toBe("assistant");
    expect(assembled.messages[1].tool_calls).toBeDefined();
    expect(assembled.messages[2].role).toBe("tool");
    expect(assembled.messages[2].tool_call_id).toBe("call_end");

    // OpenAI 格式也保持顺序
    const openaiMessages = assembledToOpenAIMessages(assembled.messages);
    expect(openaiMessages.length).toBe(3);
    expect(openaiMessages[2].role).toBe("tool");
    expect(openaiMessages[2].tool_call_id).toBe("call_end");
  });

  it("tool result content 为空但有 tool_call_id 时必须保留", () => {
    const messages: OpenAIChatMessage[] = [
      mkMsg("user", "记一下"),
      mkMsg("assistant", "", {
        tool_calls: [
          { id: "call_empty", type: "function", function: { name: "memory_upsert", arguments: "{}" } },
        ],
      }),
      mkMsg("tool", "", { tool_call_id: "call_empty" }),
      mkMsg("assistant", "记好了"),
      mkMsg("user", "谢谢"),
    ];

    const assembled = assemble({
      request: mkRequest(messages),
      pinnedPersonaMemories: null,
      boot: null,
      ragMemories: [],
      visionOutput: null,
    });

    // 空内容 tool result 必须保留（因为有 tool_call_id）
    const toolMsg = assembled.messages.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.tool_call_id).toBe("call_empty");
    // content 可以是空字符串但不能是 null（需要传给上游）
    expect(toolMsg!.content).not.toBeNull();
  });

  it("assistant tool_calls content 为 null 时也保留", () => {
    const messages: OpenAIChatMessage[] = [
      mkMsg("user", "查一下"),
      mkMsg("assistant", "", {
        tool_calls: [
          { id: "call_null", type: "function", function: { name: "memory_search", arguments: '{"query":"test"}' } },
        ],
      }),
      mkMsg("tool", "results", { tool_call_id: "call_null" }),
      mkMsg("assistant", "找到了"),
      mkMsg("user", "谢谢"),
    ];

    // 把 assistant 的 content 改成 null
    messages[1].content = null;

    const assembled = assemble({
      request: mkRequest(messages),
      pinnedPersonaMemories: null,
      boot: null,
      ragMemories: [],
      visionOutput: null,
    });

    // assistant 带 tool_calls 即使 content 为 null 也必须保留
    const assistantWithTools = assembled.messages.find((m) => m.role === "assistant" && m.tool_calls != null);
    expect(assistantWithTools).toBeDefined();
    expect(assistantWithTools!.tool_calls).toBeDefined();
  });

  it("请求以 tool result 结尾：OpenAI 格式 call_id 和 result 配对", () => {
    const messages: OpenAIChatMessage[] = [
      mkMsg("user", "查两个"),
      mkMsg("assistant", "", {
        tool_calls: [
          { id: "call_multi_a", type: "function", function: { name: "memory_search", arguments: '{"query":"a"}' } },
          { id: "call_multi_b", type: "function", function: { name: "memory_search", arguments: '{"query":"b"}' } },
        ],
      }),
      mkMsg("tool", "result a", { tool_call_id: "call_multi_a" }),
      mkMsg("tool", "result b", { tool_call_id: "call_multi_b" }),
    ];

    const assembled = assemble({
      request: mkRequest(messages),
      pinnedPersonaMemories: null,
      boot: null,
      ragMemories: [],
      visionOutput: null,
    });

    // 以 tool result 结尾 → 全部留在 history，顺序不变
    expect(assembled.messages.length).toBe(4);
    expect(assembled.messages[0].role).toBe("user");
    expect(assembled.messages[1].role).toBe("assistant");
    expect(assembled.messages[2].role).toBe("tool");
    expect(assembled.messages[2].tool_call_id).toBe("call_multi_a");
    expect(assembled.messages[3].role).toBe("tool");
    expect(assembled.messages[3].tool_call_id).toBe("call_multi_b");

    // OpenAI 格式
    const openaiMessages = assembledToOpenAIMessages(assembled.messages);
    const assistant = openaiMessages.find((m) => m.tool_calls != null);
    expect(assistant).toBeDefined();
    const toolResults = openaiMessages.filter((m) => m.role === "tool");
    expect(toolResults.length).toBe(2);
    // call_id 配对
    const callIds = (assistant!.tool_calls as Array<{ id: string }>).map((tc) => tc.id);
    const resultIds = toolResults.map((t) => t.tool_call_id);
    expect(callIds).toEqual(expect.arrayContaining(resultIds));
  });
});
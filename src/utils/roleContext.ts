import type { OpenAIChatMessage } from "../types";

// Operit 角色身份标记解析。
// Operit 无法修改请求顶层字段, 但能在发送前通过独立插件注入 SYSTEM 标记:
//   <aelios_role_context>
//   {"role_id":"稳定角色卡ID","role_name":"当前角色名称"}
//   </aelios_role_context>
// 本模块负责从 messages 中解析该标记, 提取 role_id/role_name, 并从 messages 中
// 剥离该标记块后返回干净 messages (不转发给上游模型)。

const ROLE_CONTEXT_OPEN = "<aelios_role_context>";
const ROLE_CONTEXT_CLOSE = "</aelios_role_context>";

export interface ParsedRoleContext {
  role_id: string | null;
  role_name: string | null;
}

export interface StripRoleContextResult {
  messages: OpenAIChatMessage[];
  roleContext: ParsedRoleContext | null;
}

// 从单段文本中提取首个 <aelios_role_context>...</aelios_role_context> JSON。
// 返回 { context, cleaned } — context 为解析结果(可能全 null), cleaned 为移除标记块后的文本。
function extractFromText(text: string): { context: ParsedRoleContext | null; cleaned: string } {
  if (!text.includes(ROLE_CONTEXT_OPEN)) return { context: null, cleaned: text };
  const startIdx = text.indexOf(ROLE_CONTEXT_OPEN);
  const endIdx = text.indexOf(ROLE_CONTEXT_CLOSE, startIdx + ROLE_CONTEXT_OPEN.length);
  if (endIdx < 0) return { context: null, cleaned: text };
  const jsonText = text.slice(startIdx + ROLE_CONTEXT_OPEN.length, endIdx).trim();
  let context: ParsedRoleContext | null = null;
  try {
    const parsed = JSON.parse(jsonText) as Record<string, unknown>;
    const roleId = typeof parsed.role_id === "string" ? parsed.role_id : null;
    const roleName = typeof parsed.role_name === "string" ? parsed.role_name : null;
    if (roleId || roleName) context = { role_id: roleId, role_name: roleName };
  } catch {
    // JSON 无效则忽略
  }
  // 移除标记块及其前后多余空行
  const before = text.slice(0, startIdx);
  const after = text.slice(endIdx + ROLE_CONTEXT_CLOSE.length);
  const cleaned = (before + after).replace(/\n{3,}/g, "\n\n").trim();
  return { context, cleaned };
}

// 从 messages 数组中解析角色标记。
// 扫描所有消息内容 (system 优先, 然后 user), 取首个有效标记。
// 同时返回剥离标记后的 messages 副本 (不改原数组)。
export function stripRoleContextFromMessages(
  messages: OpenAIChatMessage[]
): StripRoleContextResult {
  let found: ParsedRoleContext | null = null;
  const cleanedMessages: OpenAIChatMessage[] = [];

  // 优先扫描 system 消息, 再扫描 user 消息
  const order: Array<"system" | "user"> = ["system", "user"];
  for (const targetRole of order) {
    for (const msg of messages) {
      if (msg.role !== targetRole) {
        cleanedMessages.push(msg);
        continue;
      }
      const text = typeof msg.content === "string"
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content.map((c: any) => (typeof c === "string" ? c : c?.text ?? "")).join("\n")
          : "";
      const { context, cleaned } = extractFromText(text);
      if (context && !found) {
        found = context;
      }
      if (cleaned !== text) {
        // 标记被剥离, 重建消息
        cleanedMessages.push({ ...msg, content: cleaned });
      } else {
        cleanedMessages.push(msg);
      }
    }
    if (found) break;
    // 第一遍 (system) 没找到则重置 cleanedMessages 进入 user 扫描
    if (targetRole === "system") cleanedMessages.length = 0;
  }

  // 如果两遍都没找到, 直接返回原 messages
  if (!found) return { messages, roleContext: null };
  return { messages: cleanedMessages, roleContext: found };
}
import type { OpenAIChatMessage } from "../types";

// Operit 角色身份标记解析。
// Operit 无法修改请求顶层字段, 但能在发送前通过独立插件注入 SYSTEM 标记:
//   <aelios_role_context>
//   {"role_id":"稳定角色卡ID","role_name":"当前角色名称"}
//   </aelios_role_context>
//
// 规则 (见 MULTIROLE_HANDOVER 补-P1 需求):
// 1. body 顶层 role_id/role_name 优先; 仅当顶层缺对应字段时才用标记值
//    (优先级判断在调用方 chatCompletions.ts 完成, 本模块只负责解析+剥离)
// 2. 只解析内容完全符合协议格式的独立 SYSTEM message
//    (user/assistant/tool 中的相同文本不得生效, 也不剥离)
// 3. 严格解析 JSON; 限制字段类型 (string) 及长度 (≤200 字符)
// 4. 解析成功后从 body.messages 删除该 SYSTEM 标记
// 5. 解析失败时 (JSON 错误/字段非法/闭合缺失等) 删除疑似协议标记并记录
//    warning, 不能转发给模型
// 6. 一个请求出现多个有效标记时拒绝全部标记并回退顶层参数,
//    不能静默选择最后一条
// 7. 角色标记仅用于角色归属, 不参与身份认证或权限判断
// 8. 协议标记不得出现在: 转发上游/数据库/summary/dream/五轮历史/assembler/日志

const ROLE_CONTEXT_OPEN = "<aelios_role_context>";
const ROLE_CONTEXT_CLOSE = "</aelios_role_context>";
const MAX_FIELD_LEN = 200;

export interface ParsedRoleContext {
  role_id: string | null;
  role_name: string | null;
}

export interface ExtractOperitRoleContextResult {
  messages: OpenAIChatMessage[];
  roleContext: ParsedRoleContext | null;
}

// 判断一条消息是否"疑似协议标记 SYSTEM message"。
// 疑似 = system role + string content + trim 后以 <aelios_role_context> 开头。
// 含闭合则为完整标记 (可尝试解析), 不含闭合则为残缺标记 (必须删除不转发)。
function classifySystemMessage(msg: OpenAIChatMessage): "none" | "complete" | "malformed" {
  if (msg.role !== "system") return "none";
  if (typeof msg.content !== "string") return "none";
  const text = msg.content.trim();
  if (!text.startsWith(ROLE_CONTEXT_OPEN)) return "none";
  // 疑似协议标记: 检查是否完整闭合 + 整条消息只含标记块 (独立)
  if (text.endsWith(ROLE_CONTEXT_CLOSE)) return "complete";
  // 开头匹配但闭合缺失 → 残缺, 必须删除不转发
  return "malformed";
}

// 从一条完整标记消息中提取 JSON。
// 返回 { context, valid } — valid=true 表示有效, context 为解析结果;
// valid=false 表示格式无效 (JSON 错误/字段类型错误/超长/含未知字段/字段全空)。
// 任一字段类型/长度非法即整体 invalid (避免部分有效部分非法的歧义)。
function parseCompleteMarker(text: string): { context: ParsedRoleContext | null; valid: boolean } {
  const inner = text.slice(ROLE_CONTEXT_OPEN.length, text.length - ROLE_CONTEXT_CLOSE.length).trim();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(inner) as Record<string, unknown>;
  } catch {
    return { context: null, valid: false };
  }
  // 只接受已知字段; 不允许额外字段干扰 (严格白名单)
  const knownKeys = new Set(["role_id", "role_name"]);
  for (const k of Object.keys(parsed)) {
    if (!knownKeys.has(k)) return { context: null, valid: false };
  }
  // 严格类型 + 长度限制: 字段存在必须为 string 且 ≤200 字符, 或不存在
  // 任一字段存在但类型/长度非法 → 整体 invalid
  let roleId: string | null = null;
  let roleName: string | null = null;
  if ("role_id" in parsed) {
    if (typeof parsed.role_id !== "string" || parsed.role_id.length > MAX_FIELD_LEN) {
      return { context: null, valid: false };
    }
    roleId = parsed.role_id;
  }
  if ("role_name" in parsed) {
    if (typeof parsed.role_name !== "string" || parsed.role_name.length > MAX_FIELD_LEN) {
      return { context: null, valid: false };
    }
    roleName = parsed.role_name;
  }
  // 至少一个字段非空
  if (!roleId && !roleName) return { context: null, valid: false };
  return { context: { role_id: roleId, role_name: roleName }, valid: true };
}

// 从 messages 中解析 Operit 角色标记并剥离。
// 仅识别独立 SYSTEM message; user/assistant/tool 中的相同文本被忽略 (不剥离, 不解析)。
// 多个完整标记: 拒绝全部并回退 null (由调用方回退顶层参数)。
// 残缺标记 (闭合缺失) 或解析失败 (JSON 错误/超长等): 删除该消息并 warn, 不转发上游。
export function extractOperitRoleContext(
  messages: OpenAIChatMessage[]
): ExtractOperitRoleContextResult {
  // 第一遍: 分类所有 SYSTEM 消息
  const completeIndexes: number[] = [];
  const malformedIndexes: number[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const cls = classifySystemMessage(messages[i]);
    if (cls === "complete") completeIndexes.push(i);
    else if (cls === "malformed") malformedIndexes.push(i);
  }

  // 无任何疑似标记: 原样返回
  if (completeIndexes.length === 0 && malformedIndexes.length === 0) {
    return { messages, roleContext: null };
  }

  // 需要删除的索引集合 (残缺标记必须删除)
  const toDelete = new Set<number>(malformedIndexes);

  let roleContext: ParsedRoleContext | null = null;

  if (completeIndexes.length > 1) {
    // 多个完整标记: 拒绝全部, 回退顶层参数
    console.warn(`roleContext: multiple (${completeIndexes.length}) complete system role markers; rejecting all and falling back to body top-level role params`);
    for (const idx of completeIndexes) toDelete.add(idx);
  } else if (completeIndexes.length === 1) {
    // 恰好一个完整标记: 尝试解析
    const idx = completeIndexes[0];
    const text = (messages[idx].content as string).trim();
    const { context, valid } = parseCompleteMarker(text);
    if (!valid || !context) {
      console.warn(`roleContext: failed to parse complete system role marker; stripping and ignoring`);
      toDelete.add(idx);
    } else {
      roleContext = context;
      toDelete.add(idx);
    }
  }

  // 残缺标记 warn (如果有)
  if (malformedIndexes.length > 0) {
    console.warn(`roleContext: ${malformedIndexes.length} malformed (unclosed) system role marker(s) stripped`);
  }

  // 删除所有标记消息
  const cleaned = messages.filter((_, idx) => !toDelete.has(idx));
  return { messages: cleaned, roleContext };
}
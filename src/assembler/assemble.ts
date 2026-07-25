/**
 * assemble — main entry point for the v4 Prompt Assembler.
 *
 * Converts an OpenAIChatRequest into an AssembledPrompt.
 * The adapters (anthropic/openai) consume the output via the
 * buildAnthropicRequestFromAssembled / buildOpenAIRequestFromAssembled helpers.
 *
 * Determinism: given the same request + pre-fetched data, the output is
 * bit-for-bit identical across calls. No timestamps, no request ids.
 */

import type {
  MemoryApiRecord,
  OpenAIChatMessage,
  OpenAIChatRequest,
} from "../types";
import type { BootPackage } from "../memory/v2/recall";
import type { AssembledPrompt, AssemblerContext } from "./types";
import { assemble as assembleBlocks } from "./blocks";

// ---------------------------------------------------------------------------
// Input for assemble — pre-fetched data, no DB calls here
// ---------------------------------------------------------------------------

export interface AssembleInput {
  /** The incoming OpenAI-compatible chat request. */
  request: OpenAIChatRequest;

  /**
   * Pre-filtered pinned memories of type "persona" or "identity".
   * Caller is responsible for filtering and initial sort;
   * the assembler applies its own deterministic sort as a safety net.
   */
  pinnedPersonaMemories: MemoryApiRecord[] | null;

  /** v2 boot package (digest + recent_logs + precious + glossary). null = v1 path. */
  boot: BootPackage | null;

  /** RAG hits for the current round (v1) or recall hits (v2). */
  ragMemories: MemoryApiRecord[];

  /** Vision assistant output (image present + main model non-multimodal). */
  visionOutput: string | null;
}

// ---------------------------------------------------------------------------
// assemble() — main entry
// ---------------------------------------------------------------------------

/**
 * Build an AssembledPrompt from an OpenAI request + pre-fetched context data.
 *
 * The caller (adapter) is responsible for:
 * - Fetching pinnedPersonaMemories from D1
 * - Running RAG search for ragMemories
 * - Running vision model for visionOutput
 * - Converting AssembledPrompt to Anthropic/OpenAI wire format
 */
export function assemble(input: AssembleInput): AssembledPrompt {
  const { request } = input;

  const ctx: AssemblerContext = {
    systemMessages: extractSystemMessages(request.messages),
    pinnedPersonaMemories: input.pinnedPersonaMemories,
    boot: input.boot,
    ragMemories: input.ragMemories,
    visionOutput: input.visionOutput,
    historyMessages: extractHistoryMessages(request.messages),
    currentUserMessage: extractLastUserMessage(request.messages),
  };

  return assembleBlocks(ctx);
}

// ---------------------------------------------------------------------------
// Message extraction helpers
// ---------------------------------------------------------------------------

function extractSystemMessages(messages: OpenAIChatMessage[]): OpenAIChatMessage[] {
  return messages.filter((m) => m.role === "system");
}

/**
 * All user/assistant/tool messages EXCEPT the last user message.
 * Skips system messages.
 * Preserves original message objects (no content flattening).
 *
 * Only the last message is treated as "current" for splitting purposes.
 * If the request ends with a user message, that user message is split out
 * as current_user and excluded from history. If the request ends with a
 * tool result (e.g. after an MCP tool call), nothing is split — the full
 * user→assistant(tool_call)→tool(result) sequence stays in history in
 * original order, and current_user is null.
 */
function extractHistoryMessages(messages: OpenAIChatMessage[]): OpenAIChatMessage[] {
  const result: OpenAIChatMessage[] = [];
  // Only split out the last message if it's a user message
  const endsWithUser = messages.length > 0 && messages[messages.length - 1].role === "user";

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "user" && msg.role !== "assistant" && msg.role !== "tool") continue;
    // If the request ends with user, skip the last user message (it becomes current_user)
    if (endsWithUser && i === messages.length - 1) continue;
    result.push(msg);
  }

  return result;
}

/**
 * The last user message, preserving original content (including image_url).
 * Only returned when the request ends with a user message — if the request
 * ends with a tool result (e.g. after MCP tool call), returns null so the
 * full tool round stays in history.
 * Returns null if no user message exists.
 */
function extractLastUserMessage(messages: OpenAIChatMessage[]): OpenAIChatMessage | null {
  if (messages.length === 0) return null;
  const last = messages[messages.length - 1];
  if (last.role !== "user") return null;
  return last;
}

// Re-export for adapter convenience
export { assembleBlocks };
export type { AssembledPrompt, AssemblerContext };

import type { AssembledPrompt, PendingChange } from "../assembler/types";
import { assembledToOpenAIChatMessages } from "../assembler/toOpenAI";
import type { Env, OpenAIChatRequest } from "../types";

function stripClaudeNativeThinkingFields(req: OpenAIChatRequest): OpenAIChatRequest {
  const cleaned: OpenAIChatRequest = { ...req };
  delete cleaned.thinking;
  // Remove Aelios private fields that must not be forwarded to upstream
  delete (cleaned as any).role_id;
  delete (cleaned as any).role_name;
  return cleaned;
}

/**
 * Format pending changes as text for injection into the last user message.
 */
function formatPendingChangesText(pendingChanges?: PendingChange[]): string | null {
  if (!pendingChanges || pendingChanges.length === 0) return null;
  const lines = ["=== 待处理变更（今日）==="];
  for (const c of pendingChanges) {
    const isBaseline = c.op.startsWith("baseline_");
    const opVerb = isBaseline ? c.op.replace("baseline_", "") : c.op;
    const tag = isBaseline ? "[baseline] " : "";
    let desc: string;
    if (opVerb === "delete") {
      desc = isBaseline
        ? `${tag}删除：${c.before_content ?? ""}`
        : `删除记忆 ${c.target_id}`;
    } else if (opVerb === "add") {
      desc = `${tag}新增：${c.after_content ?? ""}`;
    } else {
      // update
      desc = `${tag}修改：${c.before_content ?? ""} → ${c.after_content ?? ""}`;
    }
    if (c.reason) desc += `（理由：${c.reason}）`;
    lines.push(desc);
  }
  return lines.join("\n");
}

export function buildOpenAICompatRequest(req: OpenAIChatRequest, targetModel: string): OpenAIChatRequest {
  const cleaned = stripClaudeNativeThinkingFields(req);
  return {
    ...cleaned,
    model: targetModel,
    stream: Boolean(cleaned.stream)
  };
}

/**
 * Build an OpenAI-compatible request from an AssembledPrompt.
 * System blocks are merged into one system message; conversation messages
 * (including image_url) are preserved as-is.
 */
export function buildOpenAIRequestFromAssembled(
  req: OpenAIChatRequest,
  targetModel: string,
  assembled: AssembledPrompt
): OpenAIChatRequest {
  const messages = assembledToOpenAIChatMessages(assembled);
  // Inject pending changes into the last user message for OpenAI path
  const pendingText = formatPendingChangesText(assembled.pending_changes);
  if (pendingText) {
    let injected = false;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === "user") {
        const existing = messages[i].content;
        if (typeof existing === "string") {
          messages[i].content = `${existing}\n\n${pendingText}`;
          injected = true;
        }
        // For array content (multimodal), don't modify — append separate message below
        break;
      }
    }
    if (!injected) {
      messages.push({ role: "user", content: pendingText });
    }
  }
  return buildOpenAICompatRequest({ ...req, messages }, targetModel);
}

export function getOpenAICompatUrl(env: Env): string {
  return `${normalizeAiGatewayBaseUrl(env)}/compat/chat/completions`;
}

export function normalizeAiGatewayBaseUrl(env: Env): string {
  const base = env.AI_GATEWAY_BASE_URL;
  if (!base) {
    throw new Error("Missing AI_GATEWAY_BASE_URL");
  }

  return base
    .replace(/\/+$/, "")
    .replace(/\/compat$/i, "")
    .replace(/\/compat\/chat\/completions$/i, "")
    .replace(/\/compat\/embeddings$/i, "")
    .replace(/\/anthropic\/v1\/messages$/i, "");
}

export function buildOpenAICompatHeaders(env: Env): Headers {
  const headers = new Headers({
    "content-type": "application/json"
  });

  if (env.CF_AIG_TOKEN) {
    headers.set("cf-aig-authorization", `Bearer ${env.CF_AIG_TOKEN}`);
  }

  return headers;
}

export async function callOpenAICompat(env: Env, body: OpenAIChatRequest): Promise<Response> {
  return fetch(getOpenAICompatUrl(env), {
    method: "POST",
    headers: buildOpenAICompatHeaders(env),
    body: JSON.stringify(body)
  });
}

export async function callOpenAICompatEmbeddings(
  env: Env,
  body: { model: string; input: string | string[]; dimensions?: number }
): Promise<Response> {
  const headers = buildOpenAICompatHeaders(env);
  if (body.model.startsWith("workers-ai/") && env.CLOUDFLARE_API_TOKEN) {
    headers.set("authorization", `Bearer ${env.CLOUDFLARE_API_TOKEN}`);
  }

  return fetch(`${normalizeAiGatewayBaseUrl(env)}/compat/embeddings`, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
}

import {
  applyBaselineGroup,
  getBaseline,
  listPendingBaselineChangelog,
  markBaselineChangelogError
} from "../db/v2";
import { callOpenAICompat } from "../proxy/openaiAdapter";
import type { Env, OpenAIChatRequest, OpenAIChatResponse } from "../types";
import { readDreamModel } from "./dreamEnv";
import { baselineSnapshotKeep } from "../gateway/background";

// =====================================================================
// applyBaselineChanges — Dream 夜间把 pending baseline 变更合并进旧 baseline。
// 语义沿用旧分支 dailyDigest.ts 的实现（plan 阶段 3）：
//   - 没有 pending 不调模型，baseline 不变；
//   - 整组 pending 一次合并（旧 baseline 全文 + 变更清单 → 模型输出新全文）；
//   - 模型成功 + 写库成功才把整组标 applied；任一步失败整组保留 pending 并记 error，
//     不做单条部分应用；
//   - 长度是软限制：合并 prompt 给目标长度，超限时追加一次压缩请求由模型自行调整，
//     不做静默硬截断。
// =====================================================================

export interface BaselineMergeResult {
  ran: boolean;
  applied: number;
  kept_pending: number;
  model_calls: number;
  reason?: string;
}

function buildMergePrompt(oldBaseline: string, changeLines: string[], maxChars: number): string {
  return [
    "你是 baseline 合并器。以下是某个记忆空间的旧 baseline 和对话模型提交的修改请求。",
    "请合并成新的完整 baseline 文本。",
    "- add：在合适位置追加新内容",
    "- update：用修改后文本替换原文描述的意思",
    "- delete：移除原文描述的内容",
    "- 保留未被修改的部分",
    "- 不写流水账，只写长期印象",
    `- 目标长度 ≤${maxChars} 字符`,
    "",
    "旧 baseline：",
    oldBaseline || "（空）",
    "",
    "修改请求：",
    ...changeLines,
    "",
    "输出新 baseline 文本（只输出正文，不要 JSON，不要解释）："
  ].join("\n");
}

function buildCompressPrompt(baseline: string, maxChars: number): string {
  return [
    "下面这份 baseline 超过了目标长度。请在保留全部长期印象要点的前提下压缩它。",
    `- 压缩后 ≤${maxChars} 字符`,
    "- 不丢条目，只压缩每条的表述；重复含义的条目可合并",
    "",
    baseline,
    "",
    "输出压缩后的 baseline 文本（只输出正文，不要 JSON，不要解释）："
  ].join("\n");
}

function changeLine(entry: { op: string; before_content: string | null; after_content: string | null; reason: string }): string {
  const before = entry.before_content ? `原文：${entry.before_content}` : "";
  const after = entry.after_content ? `修改后：${entry.after_content}` : "";
  const parts = [`[${entry.op}]`, before, after].filter(Boolean);
  return `${parts.join("，")}。理由：${entry.reason}`;
}

async function callMergeModel(env: Env, prompt: string, maxTokens: number): Promise<string | null> {
  const model = readDreamModel(env);
  if (!model) return null;
  const request: OpenAIChatRequest = {
    model,
    messages: [
      { role: "system", content: "你是严格的文本生成器。只输出合并后的 baseline 正文，不要 JSON，不要解释，不要思考过程。" },
      { role: "user", content: prompt }
    ],
    temperature: 0,
    max_tokens: maxTokens,
    stream: false
  };
  const response = await callOpenAICompat(env, request);
  if (!response.ok) return null;
  const parsed = (await response.json()) as OpenAIChatResponse;
  const content = parsed.choices?.[0]?.message?.content;
  return typeof content === "string" && content.trim() ? content.trim() : null;
}

export async function applyBaselineChanges(env: Env, namespace: string): Promise<BaselineMergeResult> {
  const pending = await listPendingBaselineChangelog(env.DB, { namespace, limit: 100 });
  if (pending.length === 0) return { ran: false, applied: 0, kept_pending: 0, model_calls: 0 };

  const maxChars = Math.max(200, Number(env.BASELINE_MAX_CHARS_PER_ROLE ?? "2000") || 2000);
  const changeLines = pending.map(changeLine);

  // 读旧 baseline：读失败（表损坏/瞬时故障）时整组记 error 保持 pending，
  // 不做探针兜底——瞬时失败和"真没有 baseline"不可分辨时，宁可下次重试也不能用空文本覆盖。
  let oldBaseline = "";
  try {
    const oldRow = await getBaseline(env.DB, { namespace });
    oldBaseline = oldRow?.content ?? "";
  } catch (error) {
    console.error("baseline merge: failed to read old baseline", { namespace, error });
    for (const entry of pending) {
      await markBaselineChangelogError(env.DB, { id: entry.id, errorMessage: "failed to read old baseline" });
    }
    return { ran: false, applied: 0, kept_pending: pending.length, model_calls: 0, reason: "read_failed" };
  }

  let modelCalls = 0;
  let newBaseline: string | null = null;
  try {
    modelCalls++;
    newBaseline = await callMergeModel(env, buildMergePrompt(oldBaseline, changeLines, maxChars), 2000);
  } catch (error) {
    console.error("baseline merge: model call failed", { namespace, error });
  }
  if (!newBaseline) {
    for (const entry of pending) {
      await markBaselineChangelogError(env.DB, { id: entry.id, errorMessage: "model call failed" });
    }
    return { ran: false, applied: 0, kept_pending: pending.length, model_calls: modelCalls, reason: "model_failed" };
  }

  // 软长度限制：超目标长度追加一次压缩请求，由模型自行调整；再超就原样接受（不硬截断）。
  if (newBaseline.length > maxChars) {
    try {
      modelCalls++;
      const compressed = await callMergeModel(env, buildCompressPrompt(newBaseline, maxChars), 2000);
      if (compressed && compressed.length < newBaseline.length) newBaseline = compressed;
    } catch (error) {
      console.warn("baseline merge: compress pass failed; keeping long baseline", { namespace, error });
    }
  }

  try {
    // 原子应用：baseline 新版本 + 上一版快照 + 整组标 applied 在同一次 batch，
    // 任一步失败整体回滚（baseline 不变、pending 保留），下次 Dream 安全重试。
    await applyBaselineGroup(env.DB, {
      namespace, content: newBaseline, snapshotKeep: baselineSnapshotKeep(env),
      pendingIds: pending.map((entry) => entry.id)
    });
    return { ran: true, applied: pending.length, kept_pending: 0, model_calls: modelCalls };
  } catch (error) {
    console.error("baseline merge: write failed", { namespace, error });
    for (const entry of pending) {
      await markBaselineChangelogError(env.DB, { id: entry.id, errorMessage: "write failed" });
    }
    return { ran: false, applied: 0, kept_pending: pending.length, model_calls: modelCalls, reason: "write_failed" };
  }
}
import { getBaseline, listPendingBaselineChangelog, listRecentDailyLogs } from "../db/v2";
import type { Env } from "../types";
import { formatAffectChordLine } from "../extensions/affectChord";
import { object, type Identity } from "./config";
import { identityNamespace } from "./config";

// =====================================================================
// 固定背景（baseline + 最近两天日记 + 今日 pending 回执）的读取与注入。
// 这些与动态召回无关：不参与召回排名、不占召回条数，
// 属于每个主模型请求都会带的稳定背景（plan 阶段 1/2）。
// =====================================================================

export function baselineMaxCharsPerRole(env: Env): number {
  const raw = Number(env.BASELINE_MAX_CHARS_PER_ROLE ?? "2000");
  return Number.isFinite(raw) && raw >= 200 ? raw : 2000;
}

/** 软限制阈值：合并 prompt 用它提醒模型，注入层不做硬截断。 */
export function baselineMaxCharsTotal(env: Env): number {
  const raw = Number(env.BASELINE_MAX_CHARS_TOTAL ?? "8000");
  return Number.isFinite(raw) && raw >= baselineMaxCharsPerRole(env) ? raw : 8000;
}

/** Pending 回执注入上限，沿用旧 MEMORY_CHANGELOG_MAX_INJECT / _MAX_CHARS 数值语义。 */
export function pendingInjectMaxEntries(env: Env): number {
  const raw = Number(env.MEMORY_CHANGELOG_MAX_INJECT ?? "10");
  return Number.isInteger(raw) && raw >= 0 ? raw : 10;
}

/** Baseline 历史快照保留版本数（默认 7，旧 BASELINE_SNAPSHOT_KEEP 语义）。 */
export function baselineSnapshotKeep(env: Env): number {
  const raw = Number(env.BASELINE_SNAPSHOT_KEEP ?? "7");
  return Number.isInteger(raw) && raw >= 1 ? raw : 7;
}

export function pendingInjectMaxChars(env: Env): number {
  const raw = Number(env.MEMORY_CHANGELOG_MAX_CHARS ?? "1500");
  return Number.isFinite(raw) && raw >= 0 ? raw : 1500;
}

export interface BackgroundContext {
  baseline: string | null;
  dailyLogs: Array<{ date: string; title: string; summary: string; affect_chord: string | null }>;
  pendingText: string | null;
}

/**
 * 读当前写入 namespace 的 baseline、最近两个有记录日期的日记和今日 pending baseline 变更。
 * baseline 只看本 ns（与旧 recall.ts:278-289 一致）；shared 是独立 namespace，
 * 仅当写入 ns 就是 shared 时才会被读到，不走 readNamespaces。
 * 日记是最近两个**有记录的日期**，不是强行补齐两个自然日（plan 阶段 2）。
 */
export async function loadBackgroundContext(env: Env, identity: Identity): Promise<BackgroundContext> {
  const namespace = identityNamespace(identity);
  // 读失败直接抛给调用方（handler 会记日志并把 x-aelios-background 置为 unavailable）——
  // 表损坏/瞬时故障不该被吞成"没有背景"，否则故障被静默掩盖。
  const [baselineRow, logRows, pending] = await Promise.all([
    getBaseline(env.DB, { namespace }),
    listRecentDailyLogs(env.DB, { namespace, limit: 2 }),
    listPendingBaselineChangelog(env.DB, { namespace, limit: 20 })
  ]);

  const baseline = baselineRow?.content?.trim() || null;
  // 注入顺序固定为旧日期在前、新日期在后（listRecentDailyLogs 返回 DESC）。
  const dailyLogs = logRows
    .map((row) => ({ date: row.date, title: row.title, summary: row.summary, affect_chord: row.affect_chord }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const limited = pending.slice(0, pendingInjectMaxEntries(env));
  let pendingText: string | null = null;
  if (limited.length) {
    const lines = ["=== 待处理变更（今日）==="];
    let usedChars = 0;
    for (const entry of limited) {
      let desc: string;
      if (entry.op === "delete") desc = `[baseline] 删除：${entry.before_content ?? ""}`;
      else if (entry.op === "add") desc = `[baseline] 新增：${entry.after_content ?? ""}`;
      else desc = `[baseline] 修改：${entry.before_content ?? ""} → ${entry.after_content ?? ""}`;
      desc += `（理由：${entry.reason}）`;
      if (usedChars + desc.length > pendingInjectMaxChars(env)) break;
      lines.push(desc);
      usedChars += desc.length;
    }
    pendingText = lines.length > 1 ? lines.join("\n") : null;
  }
  return { baseline, dailyLogs, pendingText };
}

export function formatBackgroundBlock(ctx: BackgroundContext): string {
  const parts: string[] = [];
  if (ctx.baseline) {
    parts.push("<long_term_baseline>", ctx.baseline, "</long_term_baseline>");
  }
  if (ctx.dailyLogs.length) {
    // 每篇日记显式带原始日期，让模型知道中间隔了几天；更早的细节走 daily_log_read 工具查询。
    // 有 affect_chord 时在 summary 后渲染独立一行 "♪ <chord>"（旧 assembler/types.ts:206 同款）。
    parts.push("<daily_log>");
    for (const log of ctx.dailyLogs) {
      parts.push(`<daily_log date="${log.date}">`, `【${log.title}】`, log.summary);
      const chordLine = formatAffectChordLine(log.affect_chord);
      if (chordLine) parts.push(chordLine);
      parts.push("</daily_log>");
    }
    parts.push("</daily_log>");
  }
  if (ctx.pendingText) {
    parts.push(ctx.pendingText);
  }
  return parts.join("\n");
}

/**
 * 把固定背景作为一段独立 system 文本注入请求。
 * - messages：追加到 body.system（字符串或块数组都能接）
 * - chat：追加到第一条 system 消息（没有则新建一条在最前）
 * - responses：追加到 instructions
 * 注入的是同一段文本、同一个位置语义：system 区域的末尾。
 * 返回 false 表示客户端回放的 system 里已带旧背景标记——此时不能再往
 * system 追加（会同时存在两份、且旧的在前更权威），调用方应把最新背景
 * 转投到动态 patch 区，让模型看到当前内容。
 */
// biome-ignore lint/suspicious/noExplicitAny: request bodies are arbitrary JSON read field by field, same exception as Body in protocol.ts
export function injectBackground(body: Record<string, any>, protocol: string, block: string): boolean {
  if (!block) return false;
  // 客户端可能回放上一轮已注入背景（例如把 system 原样带回）；按标记判重。
  // 命中时不能再往 system 追加（会出现两份且旧的在前），调用方把最新背景转投动态区。
  const marker = block.includes("<long_term_baseline>") ? "<long_term_baseline>" : "<daily_log>";
  const systemText = (value: unknown): string => {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.map((b: unknown) => object(b) && typeof b.text === "string" ? b.text : "").join("\n");
    return "";
  };
  if (systemText(body.system).includes(marker)) return false;
  if (systemText(body.instructions).includes(marker)) return false;
  if (Array.isArray(body.messages) && body.messages.some((m: unknown) =>
    object(m) && m.role === "system" && systemText(m.content).includes(marker))) return false;
  if (protocol === "messages") {
    if (typeof body.system === "string") body.system = `${body.system}\n\n${block}`;
    else if (Array.isArray(body.system)) {
      body.system = [...body.system, { type: "text", text: block }];
    } else body.system = [{ type: "text", text: block }];
    return true;
  }
  if (protocol === "responses") {
    body.instructions = body.instructions ? `${body.instructions}\n\n${block}` : block;
    return true;
  }
  // chat
  const messages = body.messages;
  if (Array.isArray(messages)) {
    const firstSystem = messages.findIndex((m: unknown) => object(m) && m.role === "system");
    if (firstSystem >= 0) {
      const content = messages[firstSystem].content;
      if (typeof content === "string") messages[firstSystem].content = `${content}\n\n${block}`;
      else if (Array.isArray(content)) messages[firstSystem].content = [...content, { type: "text", text: block }];
      else messages[firstSystem].content = block;
    } else {
      messages.unshift({ role: "system", content: block });
    }
  }
  return true;
}
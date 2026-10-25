// =====================================================================
// P4 · affect_chord（plan 工作包 P4）—— daily_log 的可选情绪和弦。
// 旧分支 fix/logic-review 行为考古（2026-08-27 上线）：
//   - 只有 MCP daily_log_write 通道写 chord（旧 REST /v1/daily_log 就没接，保持不接）；
//   - 生成语义靠工具描述引导：有明确情绪温度才写，普通/中性会话省略；
//   - 新值替换旧值、省略保留旧值（DB 层 COALESCE）；
//   - 无运行期格式校验（“最多 4 个和弦”等规则只活在工具描述里，靠模型自觉）；
//   - 注入渲染为独立一行 "♪ <chord>"（旧 assembler/types.ts:206）。
// 本模块集中 chord 的输入归一、渲染文本和生成说明；上游日志层只保存/返回
// 可选字段。P4 不新增格式校验——会拒收旧系统已接受的值，属行为变更（plan 默认不做）。
// =====================================================================

/**
 * MCP 工具入参归一（旧 `readString(args.affect_chord) || null` 语义）：
 * 非空字符串 → trim 后原样；空串/空白/非字符串 → null（= 省略，走保留语义）。
 */
export function normalizeAffectChord(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * 注入渲染：有 chord → "♪ <chord>" 独立一行；无 → null（不渲染任何额外行）。
 * 旧格式是 truthy 判断后追加 "\n♪ <chord>"，本函数只产出该行本身。
 */
export function formatAffectChordLine(chord: string | null | undefined): string | null {
  return chord ? `♪ ${chord}` : null;
}

/** daily_log_write 工具描述末尾的 chord 提示句（旧版逐字移植）。 */
export const AFFECT_CHORD_TOOL_HINT =
  "Optionally attach an affect_chord to capture the emotional temperature of the day in chord notation.";

/** daily_log_write 的 affect_chord 参数说明（旧版逐字移植，含格式与省略语义）。 */
export const AFFECT_CHORD_TOOL_DESCRIPTION =
  "Optional chord-progression line capturing today's emotional temperature. " +
  "Format: concrete chord names joined by ' → ', optionally followed by ' · <bpm>bpm' and/or a dynamic mark (pp/p/mp/mf/f/ff). " +
  "Example: 'Fmaj9 → C/E → Am add9 → G6sus4 · 60bpm · mp'. " +
  "Max 4 chords per line. Use absolute chord names (Cmaj7, not I), because key color matters. " +
  "Only write this when the conversation carried meaningful emotional weight — skip for routine/neutral sessions. " +
  "If today's log already has a chord, a new chord will replace it.";
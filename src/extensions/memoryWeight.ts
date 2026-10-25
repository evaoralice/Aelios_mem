// =====================================================================
// 四维权重纯领域模块（plan P1 · 后续工作包拆分 2026-10-07）。
// 规则忠实取自旧分支 fix/logic-review（feat/memory-dimensions 同源，
// 公式自 b71c941 引入后无第二个版本）：
//   - 公式：旧 src/db/v2.ts:16 computeWeight
//   - clamp：旧 dailyDigest.ts / extractPipeline.ts / merge.ts 三处一致的 clampScore
//   - 默认值：旧各写路径的历史行为，见 MEMORY_DIMENSION_DEFAULTS
// 本模块不碰数据库、MCP、召回和迁移；computeWeight 不 clamp、不取默认、
// 不清洗输入（超界输入原样放大，importance=5 → weight=1.75），与旧实现一致。
// 边界收敛与缺省由调用方按场景选用 clampDimension / DEFAULTS。
// =====================================================================

export interface MemoryWeightDimensions {
  importance: number;
  emotional: number;
  recurrence: number;
  unresolved: number;
}

export const MEMORY_WEIGHT_COEFFICIENTS = {
  importance: 0.35,
  emotional: 0.25,
  recurrence: 0.25,
  unresolved: 0.15
} as const;

// importance*0.35 + emotional*0.25 + recurrence*0.25 + unresolved*0.15，
// 四舍五入到 3 位小数。浮点行为与旧实现逐位一致（含 0.65*0.35 → 0.227 这类
// 因二进制误差向下取整的样例），不要"数学正确地"重写。
export function computeWeight(dims: MemoryWeightDimensions): number {
  return Math.round(
    (dims.importance * 0.35 + dims.emotional * 0.25 + dims.recurrence * 0.25 + dims.unresolved * 0.15) * 1000
  ) / 1000;
}

// 旧 clampScore 忠实移植：有限数字 → 收敛到 [0,1]；非数字 / NaN / ±Infinity → fallback。
// 旧系统里 MCP 入口用 isValidRange 直接拒绝超界（不 clamp），Dream 归一化用本函数收敛，
// 两种边界策略并存是有意行为，本模块两者都不替调用方做决定。
export function clampDimension(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : fallback;
}

// Dream 归一化专用规则：模型输出了该维度 → clamp 到 [0,1]（fallback 0 仅吞非有限数字）；
// 没输出 → undefined，让写入层走默认/继承旧值，不强行归零。
// （旧 dailyDigest.ts:355-357 / extractPipeline.ts:178-180）
export function optionalDimension(value: unknown): number | undefined {
  return typeof value === "number" ? clampDimension(value, 0) : undefined;
}

// 旧各写路径的四维缺省值——历史行为就是按路径分裂的，不是笔误，P2 接入时逐路径取用：
export const MEMORY_DIMENSION_DEFAULTS = {
  // 旧 db/memories.ts createMemory、MCP memory_create（readNumber 0.5）、迁移 0001 DDL DEFAULT 0.5
  create: { importance: 0.5, emotional: 0, recurrence: 0, unresolved: 0 },
  // 旧 db/v2.ts upsertMemoryByFactKey 新建、MCP memory_upsert（readNumber 0.6，工具描述 "Defaults to 0.6"）
  upsertByFactKey: { importance: 0.6, emotional: 0, recurrence: 0, unresolved: 0 }
} as const;

// Dream 归一化的 importance 缺省（其余三维走 optionalDimension，无数值缺省）：
// digest 0.7 —— 旧 dailyDigest.ts normalizeDigestResult clampScore(raw.importance, 0.7)
// extract 0.65 —— 旧 extractPipeline.ts normalizeCandidate clampScore(raw.importance, 0.65)
export const DREAM_IMPORTANCE_DEFAULTS = {
  digest: 0.7,
  extract: 0.65
} as const;
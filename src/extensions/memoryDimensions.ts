// =====================================================================
// P2 四维写入 adapter/helper（plan/Aelios-upstream-v2-baseline-integration.md
// 后续工作包 P2 · 四维存储与写入保持）。
// 旧语义（fix/logic-review，P1 验收已裁定为唯一契约，见 plan P0「已裁定」节）：
//   - 新建：未提供的维度取该写路径默认值（create 0.5 / upsertByFactKey 0.6）。
//   - upsert 命中 / supersede / update 显式提供维度后的重算：未提供的维度继承旧值。
//   - update 仅在至少显式提供一个四维字段时才重算 weight（裁定 #5），纯文本更新不改权重。
// 公式只调 computeWeight（唯一权威实现，memoryWeight.ts）；本模块不做边缘收敛
// （MCP 入口 isValidRange 拒绝、Dream clampScore 收敛由各入口自行执行，裁定 #2）。
// =====================================================================

import { computeWeight, type MemoryWeightDimensions } from "./memoryWeight";

export interface ResolvedMemoryDimensions extends MemoryWeightDimensions {
  weight: number;
}

// 写路径的四维可选入参（importance 之外的输入字段由调用方自己的接口持有）。
export type MemoryDimensionInput = Partial<MemoryWeightDimensions>;

// 新建路径（createMemory / upsertMemoryByFactKey 新建 / supersede 无旧条）：
// input 未提供的维度取 defaults（?? 语义，null 同样回退），weight = computeWeight。
export function dimensionsForCreate(
  input: MemoryDimensionInput,
  defaults: MemoryWeightDimensions
): ResolvedMemoryDimensions {
  const dims: MemoryWeightDimensions = {
    importance: input.importance ?? defaults.importance,
    emotional: input.emotional ?? defaults.emotional,
    recurrence: input.recurrence ?? defaults.recurrence,
    unresolved: input.unresolved ?? defaults.unresolved
  };
  return { ...dims, weight: computeWeight(dims) };
}

// 继承路径（upsert 命中 / supersede 有旧条）：input 未提供的维度继承 existing。
export function dimensionsForInherit(
  input: MemoryDimensionInput,
  existing: MemoryWeightDimensions
): ResolvedMemoryDimensions {
  const dims: MemoryWeightDimensions = {
    importance: input.importance ?? existing.importance,
    emotional: input.emotional ?? existing.emotional,
    recurrence: input.recurrence ?? existing.recurrence,
    unresolved: input.unresolved ?? existing.unresolved
  };
  return { ...dims, weight: computeWeight(dims) };
}

// updateMemory 条件重算判定（裁定 #5）：至少显式提供一个四维字段才重算 weight。
export function hasDimensionOverride(patch: MemoryDimensionInput): boolean {
  return (
    patch.importance !== undefined ||
    patch.emotional !== undefined ||
    patch.recurrence !== undefined ||
    patch.unresolved !== undefined
  );
}
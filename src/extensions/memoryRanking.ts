// =====================================================================
// P3 · 召回排序因子（plan 工作包 P3）。
// 旧分支 fix/logic-review 的唯一召回排序公式（search.ts:274/284、
// vectorStore.ts:669 三处一致）：
//   rank = score + importance * 0.05
// weight 只存储与透出，不参与排序（忠实旧行为）。v2 的闸三降权、E 轴
// 加成、namespace boost 都在排序分之外另行乘算，与此因子无关。
// 召回主链只准调用本函数取排序因子，不得散落复制公式（防双源漂移）。
// =====================================================================

// 旧版 importance 加成系数，0.05。改动它就是改召回排序，须有数据依据另开包。
export const RECALL_ORDER_IMPORTANCE_FACTOR = 0.05;

export function memoryRankScore(score: number, importance: number): number {
  return score + importance * RECALL_ORDER_IMPORTANCE_FACTOR;
}
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  MEMORY_DIMENSION_DEFAULTS,
  DREAM_IMPORTANCE_DEFAULTS,
  clampDimension,
  computeWeight,
  optionalDimension
} from "../src/extensions/memoryWeight";

// P1 四维权重纯领域模块（plan 后续工作包拆分 2026-10-07）验收：
// 边界值、缺省值、clamp、旧版样例结果一致。

// 旧分支 fix/logic-review src/db/v2.ts:16-18 的函数体逐字拷贝，作一致性 oracle。
function oldComputeWeight(dims: { importance: number; emotional: number; recurrence: number; unresolved: number }): number {
  return Math.round((dims.importance * 0.35 + dims.emotional * 0.25 + dims.recurrence * 0.25 + dims.unresolved * 0.15) * 1000) / 1000;
}

test("computeWeight 边界值：全 0 → 0，全 1 → 1，系数和为 1", () => {
  assert.equal(computeWeight({ importance: 0, emotional: 0, recurrence: 0, unresolved: 0 }), 0);
  assert.equal(computeWeight({ importance: 1, emotional: 1, recurrence: 1, unresolved: 1 }), 1);
});

test("computeWeight 旧版样例结果一致（含浮点逐位一致的舍入样例）", () => {
  // 期望值由旧分支公式直接执行得出，不是手算的"数学正确值"：
  // 0.65*0.35 二进制上略小于 0.2275，round 后是 0.227 而非 0.228。
  assert.equal(computeWeight({ importance: 0.5, emotional: 0, recurrence: 0, unresolved: 0 }), 0.175);
  assert.equal(computeWeight({ importance: 0.6, emotional: 0, recurrence: 0, unresolved: 0 }), 0.21);
  assert.equal(computeWeight({ importance: 0.8, emotional: 0.6, recurrence: 0.4, unresolved: 0.2 }), 0.56);
  assert.equal(computeWeight({ importance: 0.1, emotional: 0.2, recurrence: 0.3, unresolved: 0.4 }), 0.22);
  assert.equal(computeWeight({ importance: DREAM_IMPORTANCE_DEFAULTS.digest, emotional: 0, recurrence: 0, unresolved: 0 }), 0.245);
  assert.equal(computeWeight({ importance: DREAM_IMPORTANCE_DEFAULTS.extract, emotional: 0, recurrence: 0, unresolved: 0 }), 0.227);

  const samples: Array<[number, number, number, number]> = [
    [0, 0, 0, 0],
    [1, 1, 1, 1],
    [0.5, 0.5, 0.5, 0.5],
    [0.9, 0.9, 0.9, 0.9],
    [0.33, 0.44, 0.55, 0.66],
    [0.7, 0.3, 0.1, 0],
    [0.12, 0.87, 0.34, 0.91]
  ];
  for (const [importance, emotional, recurrence, unresolved] of samples) {
    assert.equal(
      computeWeight({ importance, emotional, recurrence, unresolved }),
      oldComputeWeight({ importance, emotional, recurrence, unresolved })
    );
  }
});

test("computeWeight 不 clamp：超界输入原样放大（旧实现语义）", () => {
  assert.equal(computeWeight({ importance: 5, emotional: 0, recurrence: 0, unresolved: 0 }), 1.75);
  assert.equal(computeWeight({ importance: 2, emotional: 2, recurrence: 2, unresolved: 2 }), 2);
});

test("缺省值：各写路径默认四维与旧分支一致，直接代入公式", () => {
  assert.deepEqual(MEMORY_DIMENSION_DEFAULTS.create, { importance: 0.5, emotional: 0, recurrence: 0, unresolved: 0 });
  assert.deepEqual(MEMORY_DIMENSION_DEFAULTS.upsertByFactKey, { importance: 0.6, emotional: 0, recurrence: 0, unresolved: 0 });
  assert.equal(computeWeight(MEMORY_DIMENSION_DEFAULTS.create), 0.175);
  assert.equal(computeWeight(MEMORY_DIMENSION_DEFAULTS.upsertByFactKey), 0.21);
  assert.equal(DREAM_IMPORTANCE_DEFAULTS.digest, 0.7);
  assert.equal(DREAM_IMPORTANCE_DEFAULTS.extract, 0.65);
});

test("clampDimension：[0,1] 收敛，非数字/非有限数字走 fallback", () => {
  assert.equal(clampDimension(0, 0.5), 0);
  assert.equal(clampDimension(1, 0.5), 1);
  assert.equal(clampDimension(0.5, 0.5), 0.5);
  assert.equal(clampDimension(1.5, 0.5), 1);
  assert.equal(clampDimension(-0.3, 0.5), 0);
  assert.equal(clampDimension(Number.NaN, 0.5), 0.5);
  assert.equal(clampDimension(Number.POSITIVE_INFINITY, 0.5), 0.5);
  assert.equal(clampDimension("0.5", 0.5), 0.5);
  assert.equal(clampDimension(null, 0.5), 0.5);
  assert.equal(clampDimension(undefined, 0.5), 0.5);
});

test("optionalDimension：有数字 → clamp，没输出 → undefined，非有限数字 → 0", () => {
  assert.equal(optionalDimension(0.5), 0.5);
  assert.equal(optionalDimension(2), 1);
  assert.equal(optionalDimension(-1), 0);
  assert.equal(optionalDimension(Number.POSITIVE_INFINITY), 0);
  assert.equal(optionalDimension(Number.NaN), 0);
  assert.equal(optionalDimension("0.5"), undefined);
  assert.equal(optionalDimension(undefined), undefined);
  assert.equal(optionalDimension(null), undefined);
});
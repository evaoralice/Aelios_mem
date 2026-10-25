// =====================================================================
// P7 迁移预演 · 报告落盘与 stdout 摘要。
//
// 报告只含 schema、迁移形状、逐表计数、字段非空数、状态/namespace 分布、
// 冲突数量与抽样哈希——这是硬边界：正文列只以 COUNT/SUM/掩码哈希进入，
// 任何值级输出在写这里之前就已被统计层消灭。
//
// stdout 摘要的隐私口径（2026-10-11 收口）：**只打表名与数量**，不打任何
// namespace、role_scope、角色名、冲突键、allowlist 内容；具体值只在本地
// JSON 报告里。报告与脱敏副本即使经过掩码，仍属本地敏感文件，不可提交或外发。
// =====================================================================

import { writeFileSync } from "node:fs";
import type { ConflictEntry, InspectStats, MapStatEntry, ScopePair } from "./inspect";
import { computeBaselineConflicts, computeDailyLogConflicts, computeMapStats, unknownScopePairs } from "./inspect";
import { ROLE_SCOPED_TABLES, SENSITIVITY_NOTE } from "./schema";
import { REHEARSAL_TOOL_VERSION } from "./rehearse";
import type { RehearseReport } from "./rehearse";

// 随每份报告落盘的敏感文件标注（定义见 schema.ts）。
export { SENSITIVITY_NOTE };

export interface InspectReport {
  tool: string;
  tool_version: string;
  mode: "inspect";
  generated_at: string;
  sensitivity_note: string;
  source: {
    path: string;
    kind: string;
    sha256_before: string;
    sha256_after: string;
    unchanged: boolean;
    bytes: number;
    counts_before: Record<string, number>;
    counts_after: Record<string, number>;
  };
  inspection: InspectStats;
  map_stats: Record<string, MapStatEntry[]>;
  unknown_scope_pairs: Record<string, ScopePair[]>;
  conflicts: {
    daily_log: ConflictEntry[];
    long_term_baselines: ConflictEntry[];
    note: string;
  };
}

export function writeReportFile(path: string, report: object): void {
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function fmtCounts(counts: Record<string, number>): string {
  return Object.entries(counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([t, n]) => `${t}=${n}`)
    .join("  ");
}

export function printInspectSummary(report: InspectReport): void {
  const shape = report.inspection.migration_shape;
  console.log(`[inspect] 源: ${report.source.path} (${report.source.kind}, ${report.source.bytes} bytes)`);
  console.log(`[inspect] 源库 sha256 前后一致: ${report.source.unchanged}`);
  console.log(`[inspect] 形状核对: ${shape.shape_ok ? "与旧分支 0001–0010 期望一致" : "!! 形状偏离（迁移方案须重审）"}`);
  if (!shape.shape_ok) {
    const d = shape.deviations;
    if (d.missing_tables.length) console.log(`[inspect]   缺表: ${d.missing_tables.join(", ")}`);
    if (d.unexpected_tables.length) console.log(`[inspect]   多表: ${d.unexpected_tables.join(", ")}`);
    if (d.missing_columns.length) console.log(`[inspect]   缺列: ${d.missing_columns.map((c) => `${c.table}.${c.column}`).join(", ")}`);
    if (d.unexpected_columns.length) console.log(`[inspect]   多列: ${d.unexpected_columns.map((c) => `${c.table}.${c.column}`).join(", ")}`);
    if (shape.migration_ledger_deviations.length)
      console.log(`[inspect]   账本: ${shape.migration_ledger_deviations.join("; ")}`);
  }
  console.log(`[inspect] 逐表行数: ${fmtCounts(report.source.counts_after)}`);
  const dims = report.inspection.four_dims;
  if (dims) {
    for (const d of dims.dimensions) {
      console.log(
        `[inspect] 四维 ${d.column}: 非空 ${d.non_null} 非默认 ${d.non_default} min ${d.min} max ${d.max} 超界 ${d.out_of_range}`
      );
    }
  }
  const w = report.inspection.weight;
  if (w) {
    console.log(
      `[inspect] weight: 非空 ${w.non_null} min ${w.min} max ${w.max} >1 ${w.gt_1} 与公式不一致 ${w.formula_mismatch}（只报告不修）`
    );
  }
  if (report.inspection.affect_chord) {
    console.log(
      `[inspect] daily_log: ${report.inspection.affect_chord.rows} 行，affect_chord 非空 ${report.inspection.affect_chord.chord_non_null}`
    );
  }
  const vc = report.inspection.version_chain;
  console.log(
    `[inspect] 版本链: superseded 行 ${vc.memories_superseded_rows ?? "-"}，lifecycle 孤儿 ${vc.lifecycle_orphan_rows ?? "-"}，fact_key 非空 ${vc.fact_key_non_null ?? "-"}，superseded_by 非空 ${vc.superseded_by_non_null ?? "-"}`
  );
  for (const [table, pairs] of Object.entries(report.map_stats)) {
    if (pairs.length === 0) continue;
    const rows = pairs.reduce((acc, p) => acc + p.rows, 0);
    console.log(`[inspect] 映射统计 ${table}: ${pairs.length} 组 (namespace, role_scope) → 新 namespace，共 ${rows} 行（值与行数分布见本地报告）`);
  }
  for (const [table, pairs] of Object.entries(report.unknown_scope_pairs)) {
    if (pairs.length === 0) continue;
    const rows = pairs.reduce((acc, p) => acc + p.rows, 0);
    console.log(`[inspect] !! 未知 role_scope（${table}，原样保留待裁定）: ${pairs.length} 个取值共 ${rows} 行（取值见本地报告）`);
  }
  console.log(`[inspect] daily_log 映射后 PK 冲突: ${report.conflicts.daily_log.length} 处（键与参与组见本地报告）`);
  console.log(`[inspect] long_term_baselines 映射后 PK 冲突: ${report.conflicts.long_term_baselines.length} 处（键与参与组见本地报告）`);
  const rl = report.inspection.role_less_namespaces;
  for (const [table, nsDist] of Object.entries(rl)) {
    if (Object.keys(nsDist).length > 0) {
      console.log(`[inspect] role-less 表 ${table}: ${Object.keys(nsDist).length} 个 distinct namespace（值见本地报告）`);
    }
  }
  if (report.inspection.messages.rows !== null) {
    console.log(
      `[inspect] messages: ${report.inspection.messages.rows} 行，role_id 非空 ${report.inspection.messages.role_id_non_null ?? "-"}，client_message_hash 非空 ${report.inspection.messages.client_message_hash_non_null ?? "-"}（P8 置 NULL）`
    );
  }
  if (report.inspection.conversations.rows !== null) {
    console.log(
      `[inspect] conversations: ${report.inspection.conversations.rows} 行，role_id 非空 ${report.inspection.conversations.role_id_non_null ?? "-"}`
    );
  }
}

export function printRehearseSummary(report: RehearseReport): void {
  console.log(`[rehearse] 副本: ${report.copy.path}（${report.copy.built ? "本轮新建（正文已掩码）" : `复用已有副本（第 ${report.copy.state_match === "post" ? "2+" : "1"} 次之后重放，未重复复制）`}）`);
  console.log(`[rehearse] 源库只读校验: sha256 前后一致=${report.source.unchanged}，计数前后一致=${JSON.stringify(report.source.counts_before) === JSON.stringify(report.source.counts_after)}`);
  const badSample = report.copy.build_sample_check.filter((c) => !c.structuralHashMatch || !c.maskedContentMatch);
  console.log(
    `[rehearse] 副本构建抽样: ${report.copy.build_sample_check.length} 行，结构/掩码不一致 ${badSample.length}`
  );
  for (const a of report.audit.scope_tables) {
    if (a.mismatches !== a.awaiting_ruling) {
      console.log(`[rehearse] !! 映射审计 ${a.table}: ${a.mismatches} 行不一致（等裁定 ${a.awaiting_ruling} 行之外还有偏差）`);
    } else if (a.awaiting_ruling > 0) {
      console.log(`[rehearse] 映射审计 ${a.table}: ${a.awaiting_ruling} 行撞行参与者原样保留（等裁定，审计通过）`);
    }
  }
  for (const a of report.audit.follow_tables) {
    if (a.mismatches > 0) console.log(`[rehearse] !! 跟随审计 ${a.table}: ${a.mismatches} 行不一致`);
  }
  if (report.audit.allowlist) {
    if (report.audit.allowlist.violations.length === 0) {
      console.log(`[rehearse] identity 白名单核对: ${report.audit.allowlist.allowed.length} 个允许值（含 shared），全部落位（清单见本地报告）`);
    } else {
      const total = report.audit.allowlist.violations.reduce((acc, v) => acc + v.count, 0);
      console.log(`[rehearse] !! identity 白名单外行共 ${total}（表名×行数见本地报告）`);
    }
  } else {
    console.log("[rehearse] identity 白名单核对: 未提供 --allow，跳过（部署时传入 identity namespace 清单可启用）");
  }
  console.log(`[rehearse] 冲突清单（只报告等裁定）: daily_log ${report.conflicts.daily_log.length} 处，baseline ${report.conflicts.long_term_baselines.length} 处，迁移后口径一致=${report.conflicts.keys_consistent}（键与参与组见本地报告）`);
  console.log(
    `[rehearse] 保真: findings=${report.fidelity.findings.length}${report.fidelity.findings.length > 0 ? `（${report.fidelity.findings.join("；")}）` : ""}`
  );
  if (report.copy.post_matches_previous !== null) {
    console.log(`[rehearse] 与上一轮结果一致: ${report.copy.post_matches_previous}`);
  }
}

// 从 §1 统计派生 inspect 报告的映射/冲突/未知清单（源库上的计划口径，零写入）。
export function deriveInspectSections(stats: InspectStats): {
  map_stats: Record<string, MapStatEntry[]>;
  unknown_scope_pairs: Record<string, ScopePair[]>;
  conflicts: InspectReport["conflicts"];
} {
  return {
    map_stats: Object.fromEntries(
      ROLE_SCOPED_TABLES.map((table) => [table, computeMapStats(stats.scope_pairs[table] ?? [])])
    ),
    unknown_scope_pairs: Object.fromEntries(
      ROLE_SCOPED_TABLES.map((table) => [table, unknownScopePairs(stats.scope_pairs[table] ?? [])])
    ),
    conflicts: {
      daily_log: computeDailyLogConflicts(stats.daily_log_groups),
      long_term_baselines: computeBaselineConflicts(stats.scope_pairs.long_term_baselines ?? []),
      note: "冲突只报告，等用户裁定合并/取舍（P0 manifest §1）"
    }
  };
}

export const TOOL_VERSION = REHEARSAL_TOOL_VERSION;
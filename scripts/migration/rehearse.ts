// =====================================================================
// P7 迁移预演 · 副本演练（rehearse）。
//
// 执行原则（P0 迁移验收 §2/§3/§4）：
//   - 只写 --copy 指定的脱敏副本与它的 .meta.json，绝不写源库；
//   - 幂等可重复：副本已存在且溯源匹配时不重复复制；映射 UPDATE 用
//     role_scope 重算计划 namespace，重放结果一致，计数与数据不变；
//   - 冲突只进报告（等用户裁定），绝不合并/覆盖/丢弃；
//   - 未知 role_scope、孤儿侧车/事件：原样保留 + 计数入报告，不猜去向；
//   - 本模块是"预演执行"，与 P8 的正式迁移 SQL（0021+）物理分离：
//     P8 不复用这里的 UPDATE 语句，只复用 P0 契约与检查逻辑。
// =====================================================================

import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildSanitizedCopy, detectSourceKind, listTables, openSource, sha256File, tableCount } from "./dbio";
import type { CopyBuildResult, SourceHandle } from "./dbio";
import {
  collectInspectStats,
  computeBaselineConflicts,
  computeDailyLogConflicts,
  computeMapStats,
  unknownScopePairs
} from "./inspect";
import type { ConflictEntry, InspectStats, MapStatEntry, ScopePair } from "./inspect";
import { FOLLOW_MEMORY_TABLES, mappedNamespaceSql, ROLE_SCOPED_TABLES, SENSITIVITY_NOTE, SCOPE_MAPPED_TABLES } from "./schema";

export const REHEARSAL_TOOL_VERSION = "p7-1";

export interface RehearseOptions {
  sourcePath: string;
  copyPath: string;
  forceRebuild: boolean;
  allowNamespaces: string[] | null; // 部署 identity 清单（shared 自动并入）
}

export interface CopyProvenance {
  tool: string;
  tool_version: string;
  source_kind: string;
  source_path: string;
  source_sha256: string;
  source_bytes: number;
  built_at: string;
  drill: { applied: boolean; runs: number; last_run_at: string | null };
  pre_baseline: InspectStats;
  post_baseline: InspectStats | null;
}

export interface RehearseReport {
  tool: string;
  tool_version: string;
  mode: "rehearse";
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
  copy: {
    path: string;
    meta_path: string;
    built: boolean;
    reused: boolean;
    masked: true;
    build_sample_check: CopyBuildResult["sourceSampleCheck"];
    state_match: "pre" | "post" | "fresh" | "drifted";
    post_matches_previous: boolean | null;
    repeat_run: boolean;
  };
  inspection: InspectStats; // 源库 §1 只读统计
  copy_pre: InspectStats; // 副本迁移前（构建时快照）
  copy_post: InspectStats; // 副本迁移后
  mapping: {
    order: string[];
    map_stats: Record<string, MapStatEntry[]>;
    unknown_scope_pairs: Record<string, ScopePair[]>;
    follow_memory: { table: string; followed: number; kept_original: number }[];
  };
  conflicts: {
    daily_log: ConflictEntry[];
    long_term_baselines: ConflictEntry[];
    post_conflicts_daily_log: ConflictEntry[];
    post_conflicts_baselines: ConflictEntry[];
    awaiting_ruling_rows: { daily_log: number; long_term_baselines: number };
    keys_consistent: boolean;
    note: string;
  };
  audit: {
    scope_tables: { table: string; mismatches: number; awaiting_ruling: number }[];
    follow_tables: { table: string; mismatches: number }[];
    allowlist: { provided: boolean; allowed: string[]; violations: { table: string; count: number }[] } | null;
  };
  fidelity: {
    rows_equal: Record<string, boolean>;
    non_null_equal: Record<string, boolean>;
    numeric_sums_equal: Record<string, boolean>;
    sample_hashes_equal: Record<string, boolean>;
    four_dims_equal: boolean;
    weight_equal: boolean;
    chord_equal: boolean;
    status_dists_equal: Record<string, boolean>;
    namespace_dist_pre: Record<string, Record<string, number>>;
    namespace_dist_post: Record<string, Record<string, number>>;
    findings: string[];
  };
}

export type RehearseResult =
  | { status: "ok"; report: RehearseReport }
  | { status: "refused"; reason: string; partial_report: RehearseReport | null };

function nowIso(): string {
  return new Date().toISOString();
}

function countsOf(db: DatabaseSync): Record<string, number> {
  const out: Record<string, number> = {};
  for (const table of listTables(db)) out[table] = tableCount(db, table);
  return out;
}

function readMeta(metaPath: string): CopyProvenance {
  return JSON.parse(readFileSync(metaPath, "utf8")) as CopyProvenance;
}

function writeMeta(metaPath: string, meta: CopyProvenance): void {
  writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
}

// 副本状态识别：行数 + 抽样哈希 + 非空数 + namespace 分布（全部不含正文，
// 可安全存盘）。映射只改 namespace，namespace 分布是区分迁移前后状态的关键。
function stateSignature(stats: InspectStats): string {
  const perTable: Record<string, unknown> = {};
  for (const [table, ts] of Object.entries(stats.tables)) {
    perTable[table] = {
      rows: ts.rows,
      hashes: ts.sample_hashes,
      non_null: ts.non_null,
      namespace_dist: ts.namespace_dist
    };
  }
  return JSON.stringify(perTable);
}

// —— 映射 apply（幂等 + 字节稳定：只动仍未落位的行，重放不改任何字节） ——

function applyScopeMapping(db: DatabaseSync, table: string): void {
  const mapped = mappedNamespaceSql('"role_scope"');
  db.prepare(`UPDATE ${table} SET namespace = ${mapped} WHERE ${mapped} IS NOT NULL AND namespace <> ${mapped}`).run();
}

// PK 型表（daily_log / long_term_baselines）的撞行参与者**原样保留**（等用户裁定），
// 不参与本轮 namespace 重写——这是 manifest §1 的"不静默合并"在预演侧的落法，
// 也避免了 UPDATE 直接撞旧主键（两组不同旧键映射到同一新键时必然违反）。
function applyScopeMappingWithRulingHoldback(
  db: DatabaseSync,
  table: string,
  holdback: Array<(string | null)[]>,
  whereColumns: string[]
): void {
  db.exec("CREATE TEMP TABLE IF NOT EXISTS _p7_holdback (rid INTEGER PRIMARY KEY)");
  db.exec("DELETE FROM _p7_holdback");
  const select = db.prepare(
    `INSERT INTO _p7_holdback (rid) SELECT rowid FROM ${table} WHERE ${whereColumns.join(" AND ")}`
  );
  for (const key of holdback) select.run(...key);
  const mapped = mappedNamespaceSql('"role_scope"');
  db.prepare(
    `UPDATE ${table} SET namespace = ${mapped}
     WHERE ${mapped} IS NOT NULL AND namespace <> ${mapped} AND rowid NOT IN (SELECT rid FROM _p7_holdback)`
  ).run();
  db.exec("DROP TABLE _p7_holdback");
}

function applyFollowMemoryMapping(db: DatabaseSync, table: string, fkColumn: string): void {
  db.prepare(
    `UPDATE ${table} SET namespace = (SELECT m.namespace FROM memories m WHERE m.id = ${table}.${fkColumn})
     WHERE EXISTS (SELECT 1 FROM memories m WHERE m.id = ${table}.${fkColumn})
       AND namespace <> (SELECT m.namespace FROM memories m WHERE m.id = ${table}.${fkColumn})`
  ).run();
}

function countScopeAuditMismatches(db: DatabaseSync, table: string): number {
  const mapped = mappedNamespaceSql('"role_scope"');
  const row = db
    .prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE namespace <> COALESCE(${mapped}, namespace)`)
    .get() as { c: number };
  return Number(row.c);
}

function countFollowAuditMismatches(db: DatabaseSync, table: string, fkColumn: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM ${table} t JOIN memories m ON m.id = t.${fkColumn} WHERE t.namespace <> m.namespace`
    )
    .get() as { c: number };
  return Number(row.c);
}

export async function runRehearse(opts: RehearseOptions): Promise<RehearseResult> {
  const sourceAbs = resolve(opts.sourcePath);
  const copyAbs = resolve(opts.copyPath);
  if (sourceAbs === copyAbs) {
    return { status: "refused", reason: "--source 与 --copy 指向同一文件：源库只读，副本必须分开", partial_report: null };
  }
  if (existsSync(copyAbs) && !statSync(copyAbs).isFile()) {
    return { status: "refused", reason: "--copy 路径存在但不是文件", partial_report: null };
  }

  const kind = detectSourceKind(sourceAbs);
  const shaBefore = await sha256File(sourceAbs);
  const bytes = statSync(sourceAbs).size;
  const source: SourceHandle = openSource(sourceAbs, kind);
  const sourceCountsBefore = countsOf(source.db);
  let buildCheck: CopyBuildResult["sourceSampleCheck"] = [];

  try {
    const inspection = collectInspectStats(source.db);

    if (!inspection.migration_shape.shape_ok) {
      return { status: "refused", reason: shapeRefusalReason(inspection), partial_report: null };
    }

    const metaPath = `${copyAbs}.meta.json`;
    if (opts.forceRebuild) {
      rmSync(copyAbs, { force: true });
      rmSync(metaPath, { force: true });
    }

    let reused = false;
    let preBaseline: InspectStats;
    let previousPost: InspectStats | null = null;
    let stateMatch: RehearseReport["copy"]["state_match"] = "fresh";
    let copyDb: DatabaseSync;

    if (existsSync(copyAbs)) {
      if (!existsSync(metaPath)) {
        return {
          status: "refused",
          reason: `副本 ${copyAbs} 已存在但没有溯源文件 ${metaPath}。不猜测其来源：换一个 --copy 路径，或用 --force-rebuild 从源库重建`,
          partial_report: null
        };
      }
      const meta = readMeta(metaPath);
      if (meta.source_sha256 !== shaBefore) {
        return {
          status: "refused",
          reason: `源文件 sha256 与副本构建时不一致（副本建于 ${meta.built_at}）。源库可能已变化：确认后用 --force-rebuild 重建副本`,
          partial_report: null
        };
      }
      previousPost = meta.post_baseline;
      preBaseline = meta.pre_baseline;
      copyDb = new DatabaseSync(copyAbs);
      const current = collectInspectStats(copyDb);
      const sig = stateSignature(current);
      const alreadyDrilled = meta.drill.applied;
      if (alreadyDrilled && previousPost && sig === stateSignature(previousPost)) {
        stateMatch = "post";
      } else if (sig === stateSignature(preBaseline)) {
        stateMatch = "pre";
      } else {
        copyDb.close();
        return {
          status: "refused",
          reason: "副本状态与溯源基线都不匹配（可能被外部改动或上次演练中断）。用 --force-rebuild 从源库重建副本",
          partial_report: null
        };
      }
      reused = true;
    } else {
      const built = buildSanitizedCopy(source.db, copyAbs);
      buildCheck = built.sourceSampleCheck;
      copyDb = new DatabaseSync(copyAbs);
      preBaseline = collectInspectStats(copyDb);
      writeMeta(metaPath, {
        tool: "aelios-migration-rehearsal",
        tool_version: REHEARSAL_TOOL_VERSION,
        source_kind: kind,
        source_path: sourceAbs,
        source_sha256: shaBefore,
        source_bytes: bytes,
        built_at: nowIso(),
        drill: { applied: false, runs: 0, last_run_at: null },
        pre_baseline: preBaseline,
        post_baseline: null
      });
    }

    // —— 冲突先算（apply 前的计划口径），作为 holdback 输入与报告基准 ——

    const conflictsPre = computeDailyLogConflicts(preBaseline.daily_log_groups);
    const baselinesPre = computeBaselineConflicts(preBaseline.scope_pairs.long_term_baselines ?? []);
    const dailyHoldback: Array<[string, string, string]> = conflictsPre.flatMap((c) =>
      c.groups.map((g) => [g.namespace, g.role_scope, g.date ?? ""] as [string, string, string])
    );
    const baselineHoldback: Array<[string, string]> = baselinesPre.flatMap((c) =>
      c.groups.map((g) => [g.namespace, g.role_scope] as [string, string])
    );
    const dailyAwaitingRows = conflictsPre.reduce((acc, c) => acc + c.total_rows, 0);
    const baselineAwaitingRows = baselinesPre.reduce((acc, c) => acc + c.total_rows, 0);

    let postBaseline: InspectStats;
    try {
      copyDb.exec("BEGIN");
      // 迁移顺序：memories 先行（侧车/事件跟随），随后各 scope 表（P0 §3）。
      // daily_log / long_term_baselines 的撞行参与者原样保留等裁定（见 apply 函数头注释）。
      for (const table of SCOPE_MAPPED_TABLES) {
        if (table === "daily_log") {
          applyScopeMappingWithRulingHoldback(copyDb, table, dailyHoldback, ["namespace = ?", "role_scope = ?", "date = ?"]);
        } else if (table === "long_term_baselines") {
          applyScopeMappingWithRulingHoldback(copyDb, table, baselineHoldback, ["namespace = ?", "role_scope = ?"]);
        } else {
          applyScopeMapping(copyDb, table);
        }
      }
      for (const { table, fkColumn } of FOLLOW_MEMORY_TABLES) applyFollowMemoryMapping(copyDb, table, fkColumn);
      copyDb.exec("COMMIT");
      postBaseline = collectInspectStats(copyDb);
    } catch (error) {
      try {
        copyDb.exec("ROLLBACK");
      } catch {
        // 事务不在进行中则忽略
      }
      throw error;
    }

    // —— 审计（映射审计 + 跟随审计 + identity 白名单） ——

    const auditScope = SCOPE_MAPPED_TABLES.map((table) => ({
      table,
      mismatches: countScopeAuditMismatches(copyDb, table),
      awaiting_ruling:
        table === "daily_log" ? dailyAwaitingRows : table === "long_term_baselines" ? baselineAwaitingRows : 0
    }));
    const auditFollow = FOLLOW_MEMORY_TABLES.map(({ table, fkColumn }) => ({
      table,
      mismatches: countFollowAuditMismatches(copyDb, table, fkColumn)
    }));
    const followCounts = FOLLOW_MEMORY_TABLES.map(({ table }) => {
      const kept =
        table === "memory_lifecycle"
          ? (preBaseline.version_chain.lifecycle_orphan_rows ?? 0)
          : (preBaseline.memory_events.orphan_rows ?? 0);
      const total = preBaseline.tables[table]?.rows ?? 0;
      return { table, followed: total - kept, kept_original: kept };
    });

    const allowlistResult = buildAllowlistResult(copyDb, opts.allowNamespaces);

    // —— 冲突与保真 ——

    const conflictsPost = computeDailyLogConflicts(postBaseline.daily_log_groups);
    const baselinesPost = computeBaselineConflicts(postBaseline.scope_pairs.long_term_baselines ?? []);
    const fidelity = buildFidelity(preBaseline, postBaseline);

    const postMatchesPrevious =
      previousPost === null ? null : stateSignature(postBaseline) === stateSignature(previousPost);

    copyDb.close();

    // —— 成功后落盘溯源；中断的下次运行按 drift 拒绝 ——

    const meta = readMeta(metaPath);
    meta.drill = { applied: true, runs: meta.drill.runs + 1, last_run_at: nowIso() };
    meta.post_baseline = postBaseline;
    writeMeta(metaPath, meta);

    const shaAfter = await sha256File(sourceAbs);
    const sourceCountsAfter = countsOf(source.db);

    const report: RehearseReport = {
      tool: "aelios-migration-rehearsal",
      tool_version: REHEARSAL_TOOL_VERSION,
      mode: "rehearse",
      generated_at: nowIso(),
      sensitivity_note: SENSITIVITY_NOTE,
      source: {
        path: sourceAbs,
        kind,
        sha256_before: shaBefore,
        sha256_after: shaAfter,
        unchanged: shaBefore === shaAfter,
        bytes,
        counts_before: sourceCountsBefore,
        counts_after: sourceCountsAfter
      },
      copy: {
        path: copyAbs,
        meta_path: metaPath,
        built: !reused,
        reused,
        masked: true,
        build_sample_check: buildCheck,
        state_match: stateMatch,
        post_matches_previous: postMatchesPrevious,
        repeat_run: reused
      },
      inspection,
      copy_pre: preBaseline,
      copy_post: postBaseline,
      mapping: {
        order: [...SCOPE_MAPPED_TABLES, ...FOLLOW_MEMORY_TABLES.map((f) => `${f.table}（跟随 memories）`)],
        map_stats: Object.fromEntries(
          ROLE_SCOPED_TABLES.map((table) => [table, computeMapStats(preBaseline.scope_pairs[table] ?? [])])
        ),
        unknown_scope_pairs: Object.fromEntries(
          ROLE_SCOPED_TABLES.map((table) => [table, unknownScopePairs(preBaseline.scope_pairs[table] ?? [])])
        ),
        follow_memory: followCounts
      },
      conflicts: {
        daily_log: conflictsPre,
        long_term_baselines: baselinesPre,
        post_conflicts_daily_log: conflictsPost,
        post_conflicts_baselines: baselinesPost,
        awaiting_ruling_rows: { daily_log: dailyAwaitingRows, long_term_baselines: baselineAwaitingRows },
        keys_consistent:
          conflictsPre.map((c) => `${c.new_key}:${c.total_rows}`).join("|") ===
            conflictsPost.map((c) => `${c.new_key}:${c.total_rows}`).join("|") &&
          baselinesPre.map((c) => `${c.new_key}:${c.total_rows}`).join("|") ===
            baselinesPost.map((c) => `${c.new_key}:${c.total_rows}`).join("|"),
        note: "冲突行本轮原样保留（不映射、不合并、不覆盖），清单等用户裁定后随 P8 处理；迁移后口径一致 = 演练前后同一组冲突键（manifest §1）"
      },
      audit: {
        scope_tables: auditScope,
        follow_tables: auditFollow,
        allowlist: allowlistResult
      },
      fidelity
    };
    return { status: "ok", report };
  } finally {
    source.db.close();
  }
}

function shapeRefusalReason(inspection: InspectStats): string {
  const d = inspection.migration_shape.deviations;
  const parts: string[] = [];
  if (d.missing_tables.length) parts.push(`缺表: ${d.missing_tables.join(", ")}`);
  if (d.unexpected_tables.length) parts.push(`多表: ${d.unexpected_tables.join(", ")}`);
  if (d.missing_columns.length) parts.push(`缺列: ${d.missing_columns.map((c) => `${c.table}.${c.column}`).join(", ")}`);
  if (d.unexpected_columns.length)
    parts.push(`多列: ${d.unexpected_columns.map((c) => `${c.table}.${c.column}`).join(", ")}`);
  const ledger = inspection.migration_shape.migration_ledger_deviations;
  if (ledger.length) parts.push(`账本: ${ledger.join("; ")}`);
  return `源库形状与旧分支 0001–0010 期望不符，迁移方案须重审（P0 §1），拒绝演练。${parts.join("；")}`;
}

function buildAllowlistResult(db: DatabaseSync, allow: string[] | null): RehearseReport["audit"]["allowlist"] {
  if (allow === null) return null;
  const allowed = [...new Set([...allow, "shared"])];
  const allowedSql = allowed.map(() => "?").join(", ");
  const violations: { table: string; count: number }[] = [];
  for (const table of SCOPE_MAPPED_TABLES) {
    // 只核对已落位的行（namespace == mapped(scope)）；撞行参与者等裁定、未知 scope
    // 原样保留，两者都不算白名单违规。
    const mapped = mappedNamespaceSql('"role_scope"');
    const row = db
      .prepare(
        `SELECT COUNT(*) AS c FROM ${table} WHERE ${mapped} IS NOT NULL AND namespace = ${mapped} AND namespace NOT IN (${allowedSql})`
      )
      .get(...allowed) as { c: number };
    if (Number(row.c) > 0) violations.push({ table, count: Number(row.c) });
  }
  return { provided: true, allowed, violations };
}

function eqNum(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(1e-9, 1e-9 * Math.max(Math.abs(a), Math.abs(b)));
}

function buildFidelity(pre: InspectStats, post: InspectStats): RehearseReport["fidelity"] {
  const rowsEqual: Record<string, boolean> = {};
  const nonNullEqual: Record<string, boolean> = {};
  const sumsEqual: Record<string, boolean> = {};
  const hashesEqual: Record<string, boolean> = {};
  const findings: string[] = [];

  for (const [table, preStats] of Object.entries(pre.tables)) {
    const postStats = post.tables[table];
    if (!postStats) {
      rowsEqual[table] = false;
      findings.push(`表 ${table} 在迁移后消失`);
      continue;
    }
    rowsEqual[table] = preStats.rows === postStats.rows;
    if (!rowsEqual[table]) findings.push(`表 ${table} 行数变化 ${preStats.rows} -> ${postStats.rows}`);

    nonNullEqual[table] = JSON.stringify(preStats.non_null) === JSON.stringify(postStats.non_null);
    if (!nonNullEqual[table]) findings.push(`表 ${table} 字段非空数变化（映射不应改变任何非空计数）`);

    const sumKeys = new Set([...Object.keys(preStats.numeric_sums), ...Object.keys(postStats.numeric_sums)]);
    sumsEqual[table] = [...sumKeys].every((k) => eqNum(preStats.numeric_sums[k] ?? 0, postStats.numeric_sums[k] ?? 0));
    if (!sumsEqual[table]) findings.push(`表 ${table} 数值列合计变化（四维/weight 必须原样参与）`);

    hashesEqual[table] = JSON.stringify(preStats.sample_hashes) === JSON.stringify(postStats.sample_hashes);
    if (!hashesEqual[table]) findings.push(`表 ${table} 抽样行哈希变化（映射只允许改 namespace 列）`);
  }

  const fourDimsEqual =
    pre.four_dims === null && post.four_dims === null
      ? true
      : pre.four_dims !== null &&
        post.four_dims !== null &&
        JSON.stringify(pre.four_dims.dimensions) === JSON.stringify(post.four_dims.dimensions);
  if (!fourDimsEqual) findings.push("四维统计变化");
  const weightEqual =
    pre.weight === null && post.weight === null ? true : JSON.stringify(pre.weight) === JSON.stringify(post.weight);
  if (!weightEqual) findings.push("weight 统计变化（含超界值：只报告，不修不重算）");
  const chordEqual =
    pre.affect_chord === null && post.affect_chord === null
      ? true
      : JSON.stringify(pre.affect_chord) === JSON.stringify(post.affect_chord);
  if (!chordEqual) findings.push("daily_log.affect_chord 统计变化");

  const statusDistsEqual: Record<string, boolean> = {};
  for (const table of Object.keys(pre.tables)) {
    statusDistsEqual[table] =
      JSON.stringify(pre.tables[table]?.extra_dists ?? {}) ===
        JSON.stringify(post.tables[table]?.extra_dists ?? {}) &&
      JSON.stringify(pre.tables[table]?.role_scope_dist ?? null) ===
        JSON.stringify(post.tables[table]?.role_scope_dist ?? null);
    if (!statusDistsEqual[table]) findings.push(`表 ${table} 状态/scope 分布变化`);
  }

  const namespaceDistPre: Record<string, Record<string, number>> = {};
  const namespaceDistPost: Record<string, Record<string, number>> = {};
  for (const table of Object.keys(pre.tables)) {
    namespaceDistPre[table] = pre.tables[table]?.namespace_dist ?? {};
    namespaceDistPost[table] = post.tables[table]?.namespace_dist ?? {};
  }

  return {
    rows_equal: rowsEqual,
    non_null_equal: nonNullEqual,
    numeric_sums_equal: sumsEqual,
    sample_hashes_equal: hashesEqual,
    four_dims_equal: fourDimsEqual,
    weight_equal: weightEqual,
    chord_equal: chordEqual,
    status_dists_equal: statusDistsEqual,
    namespace_dist_pre: namespaceDistPre,
    namespace_dist_post: namespaceDistPost,
    findings
  };
}
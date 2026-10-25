// =====================================================================
// P7 迁移预演 · 只读统计采集（P0 迁移验收清单 §1 / §4 的机器可读实现）。
//
// 约束：
//   - 只跑 SELECT/PRAGMA，任何一条语句都不得写库（源库连接本身就是 readOnly）；
//   - 统计只含 schema、计数、非空数、分布、极值与哈希，绝不产出正文
//     （正文列只进 COUNT/SUM/掩码哈希，值本身不进任何输出）；
//   - 形状偏离不抛错：inspect 的职责就是把它报出来；rehearse 侧由调用方
//     拿 shape_ok 决定拒绝。
// =====================================================================

import type { DatabaseSync } from "node:sqlite";
import { computeWeight } from "../../src/extensions/memoryWeight";
import { tableColumns, tableCount, quoteIdent, rowHash, sampleRowids } from "./dbio";
import type { ColumnInfo, SourceHandle } from "./dbio";
import {
  DISTRIBUTION_COLUMNS,
  D1_MIGRATIONS_TABLE,
  E_AXIS_COLUMNS,
  EXPECTED_OLD_MIGRATIONS,
  HASH_EXCLUDED_COLUMNS,
  OLD_TABLE_COLUMNS,
  ROLE_LESS_TABLES,
  ROLE_SCOPED_TABLES,
  plannedNamespace,
  mapScopeToNamespace,
  WEIGHT_MISMATCH_EPSILON
} from "./schema";
import type { ScopeKind } from "./schema";

// —— 输出形状 ——

export interface ShapeDeviations {
  missing_tables: string[];
  unexpected_tables: string[];
  missing_columns: { table: string; column: string }[];
  unexpected_columns: { table: string; column: string }[];
}

export interface MigrationShapeCheck {
  tables_present: string[];
  d1_migrations_present: boolean;
  applied_migrations: string[] | null; // null = 无账本可读
  expected_migrations: string[];
  migration_ledger_deviations: string[];
  signature_checks: { name: string; applied: boolean; missing: string[] }[];
  deviations: ShapeDeviations;
  e_axis: { column: string; present: boolean; p8_target: string }[];
  shape_ok: boolean;
}

export interface TableStats {
  rows: number;
  columns: ColumnInfo[];
  non_null: Record<string, number>;
  numeric_sums: Record<string, number>;
  sample_hashes: Record<string, string>; // rowid -> 正文外行哈希（不含 namespace）
  namespace_dist: Record<string, number> | null;
  role_scope_dist: Record<string, number> | null;
  extra_dists: Record<string, Record<string, number>>;
}

export interface ScopePair {
  namespace: string;
  role_scope: string;
  rows: number;
}

export interface DailyLogGroup extends ScopePair {
  date: string;
}

export interface DimensionStats {
  column: string;
  dflt: number;
  non_null: number;
  non_default: number;
  min: number;
  max: number;
  out_of_range: number;
}

export interface InspectStats {
  migration_shape: MigrationShapeCheck;
  tables: Record<string, TableStats>;
  four_dims: { dimensions: DimensionStats[]; note: string } | null;
  weight: {
    non_null: number;
    min: number;
    max: number;
    gt_1: number;
    formula_mismatch: number; // 与 computeWeight 逐行比对的差数（只报告，不重算不修）
    sum: number;
  } | null;
  affect_chord: { rows: number; chord_non_null: number } | null;
  version_chain: {
    memories_superseded_rows: number | null;
    lifecycle_rows: number | null;
    fact_key_non_null: number | null;
    supersedes_non_null: number | null;
    superseded_by_non_null: number | null;
    lifecycle_orphan_rows: number | null;
    supersedes_dangling: number | null;
    superseded_by_dangling: number | null;
    asymmetric_pairs: number | null;
    lifecycle_memory_namespace_mismatch: number | null;
  };
  memory_events: { rows: number | null; orphan_rows: number | null };
  messages: {
    rows: number | null;
    client_message_hash_non_null: number | null;
    role_id_non_null: number | null;
    role_dist: Record<string, number> | null; // P8 seq 回填的来源分布
  };
  conversations: { rows: number | null; role_id_non_null: number | null };
  scope_pairs: Record<string, ScopePair[]>;
  daily_log_groups: DailyLogGroup[];
  role_less_namespaces: Record<string, Record<string, number>>;
}

// —— 形状核对 ——

export function checkMigrationShape(db: DatabaseSync): MigrationShapeCheck {
  const present = new Set(
    (db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as {
      name: string;
    }[]).map((r) => r.name)
  );
  const expectedTables = Object.keys(OLD_TABLE_COLUMNS);

  const deviations: ShapeDeviations = {
    missing_tables: expectedTables.filter((t) => !present.has(t)),
    unexpected_tables: [...present].filter((t) => !(t in OLD_TABLE_COLUMNS) && t !== D1_MIGRATIONS_TABLE),
    missing_columns: [],
    unexpected_columns: []
  };

  for (const [table, columns] of Object.entries(OLD_TABLE_COLUMNS)) {
    if (!present.has(table)) continue;
    const actual = new Set(tableColumns(db, table).map((c) => c.name));
    for (const col of columns) {
      if (!actual.has(col)) deviations.missing_columns.push({ table, column: col });
    }
    for (const col of actual) {
      if (!columns.includes(col)) deviations.unexpected_columns.push({ table, column: col });
    }
  }

  // 迁移账本（Cloudflare d1_migrations）：能读就对照，读不到只记录。
  let appliedMigrations: string[] | null = null;
  const ledgerDeviations: string[] = [];
  if (present.has(D1_MIGRATIONS_TABLE)) {
    const cols = tableColumns(db, D1_MIGRATIONS_TABLE).map((c) => c.name);
    if (cols.includes("name")) {
      appliedMigrations = (
        db.prepare(`SELECT name FROM ${quoteIdent(D1_MIGRATIONS_TABLE)} ORDER BY name`).all() as {
          name: string;
        }[]
      ).map((r) => r.name);
      const expected = EXPECTED_OLD_MIGRATIONS.map((m) => m.name);
      for (const name of appliedMigrations) {
        if (!expected.includes(name)) ledgerDeviations.push(`账本多出 ${name}（期望之外）`);
      }
      for (const name of expected) {
        if (!appliedMigrations.includes(name)) ledgerDeviations.push(`账本缺少 ${name}（迁移可能未应用）`);
      }
    } else {
      ledgerDeviations.push("d1_migrations 表存在但无 name 列，无法读取账本");
    }
  }

  // schema 签名：每个期望迁移的必需对象是否齐（账本缺失/对不上时的兜底证据）。
  const signatureChecks = EXPECTED_OLD_MIGRATIONS.map((migration) => {
    const missing: string[] = [];
    for (const req of migration.requires) {
      if (!present.has(req.table)) {
        missing.push(req.table);
        continue;
      }
      if (req.column && !tableColumns(db, req.table).some((c) => c.name === req.column)) {
        missing.push(`${req.table}.${req.column}`);
      }
    }
    return { name: migration.name, applied: missing.length === 0, missing };
  });

  // E 轴：旧库应缺失；出现即偏离（P8 目标是置 NULL，不伪造）。
  const eAxis = E_AXIS_COLUMNS.map((column) => ({
    column,
    present: present.has("memories") && tableColumns(db, "memories").some((c) => c.name === column),
    p8_target: "absent -> NULL（manifest §3.1：旧无来源，不伪造）"
  }));

  const shapeOk =
    deviations.missing_tables.length === 0 &&
    deviations.unexpected_tables.length === 0 &&
    deviations.missing_columns.length === 0 &&
    deviations.unexpected_columns.length === 0 &&
    ledgerDeviations.length === 0;

  return {
    tables_present: [...present].sort(),
    d1_migrations_present: present.has(D1_MIGRATIONS_TABLE),
    applied_migrations: appliedMigrations,
    expected_migrations: EXPECTED_OLD_MIGRATIONS.map((m) => m.name),
    migration_ledger_deviations: ledgerDeviations,
    signature_checks: signatureChecks,
    deviations,
    e_axis: eAxis,
    shape_ok: shapeOk
  };
}

// —— 逐表通用统计 ——

const NUMERIC_TYPE_RE = /INT|REAL|FLOA|DOUB|NUM/i;

function dist(db: DatabaseSync, table: string, column: string): Record<string, number> {
  const rows = db
    .prepare(`SELECT ${quoteIdent(column)} AS k, COUNT(*) AS c FROM ${quoteIdent(table)} GROUP BY 1 ORDER BY c DESC, k ASC`)
    .all() as { k: unknown; c: number }[];
  const out: Record<string, number> = {};
  for (const r of rows) out[r.k === null ? "<NULL>" : String(r.k)] = Number(r.c);
  return out;
}

function collectTableStats(db: DatabaseSync, table: string): TableStats {
  const columns = tableColumns(db, table);
  const names = columns.map((c) => c.name);
  const numericCols = columns.filter((c) => NUMERIC_TYPE_RE.test(c.type)).map((c) => c.name);
  const rows = tableCount(db, table);

  const nonNull: Record<string, number> = {};
  if (names.length > 0) {
    const selects = names.map((c, i) => `COUNT(${quoteIdent(c)}) AS s${i}`).join(", ");
    const got = db.prepare(`SELECT ${selects} FROM ${quoteIdent(table)}`).get() as Record<string, unknown>;
    names.forEach((c, i) => {
      nonNull[c] = Number(got[`s${i}`]);
    });
  }

  const numericSums: Record<string, number> = {};
  if (numericCols.length > 0) {
    const selects = numericCols.map((c, i) => `SUM(${quoteIdent(c)}) AS s${i}`).join(", ");
    const got = db.prepare(`SELECT ${selects} FROM ${quoteIdent(table)}`).get() as Record<string, unknown>;
    numericCols.forEach((c, i) => {
      const value = got[`s${i}`];
      numericSums[c] = value === null || value === undefined ? 0 : Number(value);
    });
  }

  const sampleHashes: Record<string, string> = {};
  const rowidList = sampleRowids(db, table);
  if (rowidList.length > 0) {
    const stmt = db.prepare(`SELECT * FROM ${quoteIdent(table)} WHERE rowid = ?`);
    stmt.setReadBigInts(true);
    for (const rid of rowidList) {
      const row = stmt.get(Number(rid)) as Record<string, unknown> | undefined;
      if (row) sampleHashes[rid] = rowHash(names, row, HASH_EXCLUDED_COLUMNS);
    }
  }

  const hasColumn = (c: string) => names.includes(c);
  const extraDists: Record<string, Record<string, number>> = {};
  for (const c of DISTRIBUTION_COLUMNS[table] ?? []) {
    if (hasColumn(c)) extraDists[c] = dist(db, table, c);
  }

  return {
    rows,
    columns,
    non_null: nonNull,
    numeric_sums: numericSums,
    sample_hashes: sampleHashes,
    namespace_dist: hasColumn("namespace") ? dist(db, table, "namespace") : null,
    role_scope_dist: hasColumn("role_scope") ? dist(db, table, "role_scope") : null,
    extra_dists: extraDists
  };
}

function queryScopePairs(db: DatabaseSync, table: string): ScopePair[] {
  const rows = db
    .prepare(
      `SELECT namespace AS ns, role_scope AS scope, COUNT(*) AS c FROM ${quoteIdent(table)} GROUP BY 1, 2 ORDER BY c DESC, ns, scope`
    )
    .all() as { ns: string; scope: string; c: number }[];
  return rows.map((r) => ({ namespace: r.ns, role_scope: r.scope, rows: Number(r.c) }));
}

function tableExists(db: DatabaseSync, table: string): boolean {
  return (
    (
      db
        .prepare("SELECT COUNT(*) AS c FROM sqlite_schema WHERE type='table' AND name = ?")
        .get(table) as { c: number }
    ).c > 0
  );
}

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  return tableExists(db, table) && tableColumns(db, table).some((c) => c.name === column);
}

// —— memories 四维/weight 专项 ——

function dimensionStats(db: DatabaseSync, column: string, dflt: number): DimensionStats | null {
  if (!hasColumn(db, "memories", column)) return null;
  const agg = db
    .prepare(
      `SELECT COUNT(${quoteIdent(column)}) AS nn, MIN(${quoteIdent(column)}) AS mn, MAX(${quoteIdent(column)}) AS mx,
              SUM(CASE WHEN ${quoteIdent(column)} < 0 OR ${quoteIdent(column)} > 1 THEN 1 ELSE 0 END) AS oor,
              SUM(CASE WHEN ${quoteIdent(column)} <> ? THEN 1 ELSE 0 END) AS nd
       FROM memories`
    )
    .get(dflt) as { nn: number; mn: number | null; mx: number | null; oor: number | null; nd: number | null };
  return {
    column,
    dflt,
    non_null: Number(agg.nn),
    non_default: Number(agg.nd ?? 0),
    min: agg.mn === null ? 0 : Number(agg.mn),
    max: agg.mx === null ? 0 : Number(agg.mx),
    out_of_range: Number(agg.oor ?? 0)
  };
}

function weightStats(db: DatabaseSync): InspectStats["weight"] {
  if (!hasColumn(db, "memories", "weight")) return null;
  const agg = db
    .prepare("SELECT COUNT(weight) AS nn, MIN(weight) AS mn, MAX(weight) AS mx, SUM(weight) AS s FROM memories")
    .get() as { nn: number; mn: number | null; mx: number | null; s: number | null };
  const hasAllDims = ["importance", "emotional", "recurrence", "unresolved"].every((c) =>
    hasColumn(db, "memories", c)
  );
  let mismatch = 0;
  if (hasAllDims) {
    const stmt = db.prepare("SELECT importance, emotional, recurrence, unresolved, weight FROM memories");
    for (const row of stmt.all() as { importance: unknown }[]) {
      const dims = {
        importance: Number((row as Record<string, unknown>).importance),
        emotional: Number((row as Record<string, unknown>).emotional),
        recurrence: Number((row as Record<string, unknown>).recurrence),
        unresolved: Number((row as Record<string, unknown>).unresolved)
      };
      const stored = Number((row as Record<string, unknown>).weight);
      if (Math.abs(stored - computeWeight(dims)) > WEIGHT_MISMATCH_EPSILON) mismatch++;
    }
  }
  return {
    non_null: Number(agg.nn),
    min: agg.mn === null ? 0 : Number(agg.mn),
    max: agg.mx === null ? 0 : Number(agg.mx),
    gt_1: Number(
      (db.prepare("SELECT COUNT(*) AS c FROM memories WHERE weight > 1").get() as { c: number }).c
    ),
    formula_mismatch: mismatch,
    sum: agg.s === null ? 0 : Number(agg.s)
  };
}

// —— 版本链/侧车 ——

function versionChainStats(db: DatabaseSync): InspectStats["version_chain"] {
  const out: InspectStats["version_chain"] = {
    memories_superseded_rows: null,
    lifecycle_rows: null,
    fact_key_non_null: null,
    supersedes_non_null: null,
    superseded_by_non_null: null,
    lifecycle_orphan_rows: null,
    supersedes_dangling: null,
    superseded_by_dangling: null,
    asymmetric_pairs: null,
    lifecycle_memory_namespace_mismatch: null
  };
  if (!tableExists(db, "memories")) return out;
  out.memories_superseded_rows = Number(
    (db.prepare("SELECT COUNT(*) AS c FROM memories WHERE status = 'superseded'").get() as { c: number }).c
  );
  if (!tableExists(db, "memory_lifecycle")) return out;
  out.lifecycle_rows = tableCount(db, "memory_lifecycle");
  out.fact_key_non_null = Number(
    (db.prepare("SELECT COUNT(fact_key) AS c FROM memory_lifecycle").get() as { c: number }).c
  );
  out.supersedes_non_null = Number(
    (db.prepare("SELECT COUNT(supersedes_id) AS c FROM memory_lifecycle").get() as { c: number }).c
  );
  out.superseded_by_non_null = Number(
    (db.prepare("SELECT COUNT(superseded_by_id) AS c FROM memory_lifecycle").get() as { c: number }).c
  );
  out.lifecycle_orphan_rows = Number(
    (
      db
        .prepare(
          "SELECT COUNT(*) AS c FROM memory_lifecycle l WHERE NOT EXISTS (SELECT 1 FROM memories m WHERE m.id = l.memory_id)"
        )
        .get() as { c: number }
    ).c
  );
  out.supersedes_dangling = Number(
    (
      db
        .prepare(
          "SELECT COUNT(*) AS c FROM memory_lifecycle l WHERE l.supersedes_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM memories m WHERE m.id = l.supersedes_id)"
        )
        .get() as { c: number }
    ).c
  );
  out.superseded_by_dangling = Number(
    (
      db
        .prepare(
          "SELECT COUNT(*) AS c FROM memory_lifecycle l WHERE l.superseded_by_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM memories m WHERE m.id = l.superseded_by_id)"
        )
        .get() as { c: number }
    ).c
  );
  out.asymmetric_pairs = Number(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM memory_lifecycle a
           WHERE a.supersedes_id IS NOT NULL
             AND EXISTS (SELECT 1 FROM memory_lifecycle b WHERE b.memory_id = a.supersedes_id)
             AND (SELECT b.superseded_by_id FROM memory_lifecycle b WHERE b.memory_id = a.supersedes_id) IS NOT a.memory_id`
        )
        .get() as { c: number }
    ).c
  );
  out.lifecycle_memory_namespace_mismatch = Number(
    (
      db
        .prepare(
          "SELECT COUNT(*) AS c FROM memory_lifecycle l JOIN memories m ON m.id = l.memory_id WHERE l.namespace <> m.namespace"
        )
        .get() as { c: number }
    ).c
  );
  return out;
}

// —— 顶层采集 ——

export function collectInspectStats(db: DatabaseSync): InspectStats {
  const shape = checkMigrationShape(db);
  const tables: Record<string, TableStats> = {};
  for (const table of shape.tables_present) {
    tables[table] = collectTableStats(db, table);
  }

  const dims: DimensionStats[] = [];
  for (const [column, dflt] of [
    ["importance", 0.5],
    ["emotional", 0.0],
    ["recurrence", 0.0],
    ["unresolved", 0.0]
  ] as const) {
    const stats = dimensionStats(db, column, dflt);
    if (stats) dims.push(stats);
  }

  const scopePairs: Record<string, ScopePair[]> = {};
  for (const table of ROLE_SCOPED_TABLES) {
    if (hasColumn(db, table, "role_scope")) scopePairs[table] = queryScopePairs(db, table);
  }

  const dailyLogGroups: DailyLogGroup[] = [];
  if (hasColumn(db, "daily_log", "role_scope") && hasColumn(db, "daily_log", "date")) {
    const rows = db
      .prepare("SELECT namespace AS ns, role_scope AS scope, date AS d, COUNT(*) AS c FROM daily_log GROUP BY 1, 2, 3 ORDER BY ns, scope, d")
      .all() as { ns: string; scope: string; d: string; c: number }[];
    for (const r of rows) {
      dailyLogGroups.push({ namespace: r.ns, role_scope: r.scope, date: r.d, rows: Number(r.c) });
    }
  }

  const roleLess: Record<string, Record<string, number>> = {};
  for (const table of ROLE_LESS_TABLES) {
    if (hasColumn(db, table, "namespace")) roleLess[table] = dist(db, table, "namespace");
  }

  const chord =
    tableExists(db, "daily_log") && hasColumn(db, "daily_log", "affect_chord")
      ? {
          rows: tableCount(db, "daily_log"),
          chord_non_null: Number(
            (db.prepare("SELECT COUNT(affect_chord) AS c FROM daily_log").get() as { c: number }).c
          )
        }
      : null;

  const eventsStats: InspectStats["memory_events"] = {
    rows: tableExists(db, "memory_events") ? tableCount(db, "memory_events") : null,
    orphan_rows: tableExists(db, "memory_events")
      ? Number(
          (
            db
              .prepare(
                "SELECT COUNT(*) AS c FROM memory_events e WHERE e.memory_id IS NULL OR NOT EXISTS (SELECT 1 FROM memories m WHERE m.id = e.memory_id)"
              )
              .get() as { c: number }
          ).c
        )
      : null
  };

  const messages: InspectStats["messages"] = {
    rows: tableExists(db, "messages") ? tableCount(db, "messages") : null,
    client_message_hash_non_null: hasColumn(db, "messages", "client_message_hash")
      ? Number((db.prepare("SELECT COUNT(client_message_hash) AS c FROM messages").get() as { c: number }).c)
      : null,
    role_id_non_null: hasColumn(db, "messages", "role_id")
      ? Number((db.prepare("SELECT COUNT(role_id) AS c FROM messages").get() as { c: number }).c)
      : null,
    role_dist: tableExists(db, "messages") && hasColumn(db, "messages", "role") ? dist(db, "messages", "role") : null
  };

  const conversations: InspectStats["conversations"] = {
    rows: tableExists(db, "conversations") ? tableCount(db, "conversations") : null,
    role_id_non_null: hasColumn(db, "conversations", "role_id")
      ? Number((db.prepare("SELECT COUNT(role_id) AS c FROM conversations").get() as { c: number }).c)
      : null
  };

  return {
    migration_shape: shape,
    tables,
    four_dims: dims.length === 4 ? { dimensions: dims, note: "四维默认值按 DDL（importance 0.5，其余 0）；超界只报告不修（P0 全局规则 2）" } : dims.length > 0 ? { dimensions: dims, note: "四维列不全，只统计存在的列" } : null,
    weight: weightStats(db),
    affect_chord: chord,
    version_chain: versionChainStats(db),
    memory_events: eventsStats,
    messages,
    conversations,
    scope_pairs: scopePairs,
    daily_log_groups: dailyLogGroups,
    role_less_namespaces: roleLess
  };
}

// —— 映射统计与冲突清单（纯函数；inspect 与 rehearse 共用，不碰库） ——

export interface MapStatEntry {
  from_namespace: string;
  role_scope: string;
  scope_kind: ScopeKind;
  to_namespace: string; // 计划 namespace（未知 scope 回退原 namespace，原样保留）
  rows: number;
}

export function computeMapStats(pairs: ScopePair[]): MapStatEntry[] {
  return pairs.map((p) => {
    const mapped = mapScopeToNamespace(p.role_scope);
    return {
      from_namespace: p.namespace,
      role_scope: p.role_scope,
      scope_kind: mapped.kind,
      to_namespace: plannedNamespace(p.role_scope, p.namespace),
      rows: p.rows
    };
  });
}

export interface ConflictGroup {
  namespace: string;
  role_scope: string;
  scope_kind: ScopeKind;
  rows: number;
  date?: string; // daily_log 冲突时携带（预演侧 holdback 需要，报告也更可读）
}

export interface ConflictEntry {
  table: string;
  new_key: string;
  total_rows: number;
  groups: ConflictGroup[];
}

// PK 型表撞行（manifest §1）：多个旧 (namespace, role_scope[, date]) 映到同一新键。
// 只报告：合并/取舍等用户裁定，SQL 不带静默 dedupe。
export function computeDailyLogConflicts(groups: DailyLogGroup[]): ConflictEntry[] {
  const byNewKey = new Map<string, DailyLogGroup[]>();
  for (const g of groups) {
    const key = `${plannedNamespace(g.role_scope, g.namespace)}\u0000${g.date}`;
    const bucket = byNewKey.get(key);
    if (bucket) bucket.push(g);
    else byNewKey.set(key, [g]);
  }
  const conflicts: ConflictEntry[] = [];
  for (const [key, bucket] of byNewKey) {
    if (bucket.length < 2) continue;
    const [ns, date] = key.split("\u0000");
    conflicts.push({
      table: "daily_log",
      new_key: `(namespace='${ns}', date='${date}')`,
      total_rows: bucket.reduce((acc, g) => acc + g.rows, 0),
      groups: bucket.map((g) => ({
        namespace: g.namespace,
        role_scope: g.role_scope,
        scope_kind: mapScopeToNamespace(g.role_scope).kind,
        rows: g.rows,
        date: g.date
      }))
    });
  }
  return conflicts.sort((a, b) => a.new_key.localeCompare(b.new_key));
}

export function computeBaselineConflicts(pairs: ScopePair[]): ConflictEntry[] {
  const byNewKey = new Map<string, ScopePair[]>();
  for (const p of pairs) {
    const key = plannedNamespace(p.role_scope, p.namespace);
    const bucket = byNewKey.get(key);
    if (bucket) bucket.push(p);
    else byNewKey.set(key, [p]);
  }
  const conflicts: ConflictEntry[] = [];
  for (const [key, bucket] of byNewKey) {
    if (bucket.length < 2) continue;
    conflicts.push({
      table: "long_term_baselines",
      new_key: `(namespace='${key}')`,
      total_rows: bucket.reduce((acc, p) => acc + p.rows, 0),
      groups: bucket.map((p) => ({
        namespace: p.namespace,
        role_scope: p.role_scope,
        scope_kind: mapScopeToNamespace(p.role_scope).kind,
        rows: p.rows
      }))
    });
  }
  return conflicts.sort((a, b) => a.new_key.localeCompare(b.new_key));
}

// 未知 scope 清单（不猜去向的行，报告等裁定）。
export function unknownScopePairs(pairs: ScopePair[]): ScopePair[] {
  return pairs.filter((p) => mapScopeToNamespace(p.role_scope).kind === "unknown");
}
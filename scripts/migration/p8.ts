// =====================================================================
// P8 · 旧数据正式迁移 orchestrator（plan 工作包 P8；离线 tooling，不入 src/）。
//
// 职责：在"从生产导出新建的一次性真实副本"上，按**线上同库升级的真实顺序**
// 完整执行升级并做 P0 §4 验收，产出本地 JSON 报告。绝不写源库。
//
// 为什么必须有 orchestrator（单纯 0021+ D1 SQL 承载不了完整流程的代码证据）：
//   1. 线上账本已含旧 0001–0010（feat/memory-dimensions 的迁移名）。部署新分支
//      时 `wrangler d1 migrations apply` 会按名字跳过同名 0001–0005、应用新名
//      0006–0017（0017 的 CREATE TABLE IF NOT EXISTS 在已存在的旧形状表上是
//      **静默 no-op**），随后 0018–0020 的新号文件因四维/affect_chord/status
//      列已由旧 0010/0009/0008 同构加过而 duplicate column 失败——部署中断。
//   2. 因此线上路径需要"账本引导"：先把 0018–0020 的名字按已应用语义登记进
//      d1_migrations（目标列同构已存在），migrations apply 才会跳过它们。
//   3. P8 的 0021+ 引用的 role_scope/role_id 列在全新部署（migrations/0001–0020
//      播完的库）不存在，tests 又按 readdirSync("migrations") 全量播放——
//      所以 0021+ **不能进 migrations/**，只能放 migrations-p8/ 由本工具（线上
//      则由 wrangler d1 execute）按序播放。
//
// 安全约束（沿用 P7）：
//   - 源库只读（.sql 导出内存还原 / .sqlite readOnly），前后 sha256 + 计数比对；
//   - 副本是**未脱敏**的真实数据一次性副本（本地敏感文件，落 .migration-work/，
//     已 gitignore；不可提交、不可外发）；已存在则拒绝，--force 才重建；
//   - 冲突（daily_log/baselines 撞新键）、未知 role_scope、digest 多 namespace、
//     baseline_changelog 值域外 → 预检拒绝，不猜、不合并、不覆盖；
//   - 每个 SQL 文件单事务播放：失败即整文件回滚并中止（副本不产生半迁移状态，
//     报告标记 failed；线上手册要求先 wrangler d1 export 备份）。
// =====================================================================

import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import {
  detectSourceKind,
  openSource,
  quoteIdent,
  rowHash,
  sha256File,
  tableColumns
} from "./dbio";
import type { ColumnInfo, SourceHandle } from "./dbio";
import {
  collectInspectStats,
  computeBaselineConflicts,
  computeDailyLogConflicts,
  unknownScopePairs
} from "./inspect";
import type { InspectStats, ScopePair } from "./inspect";
import { mappedNamespaceSql, SENSITIVITY_NOTE } from "./schema";

export const P8_TOOL_VERSION = "p8-1";

// 线上账本引导：这三个新号迁移的目标列已由旧 0010/0009/0008 同构加好，
// 线上部署前把名字登记进 d1_migrations 让 migrations apply 跳过（防 duplicate column）。
export const LEDGER_BOOTSTRAP = [
  "0018_memory_weight_dimensions.sql",
  "0019_daily_log_affect_chord.sql",
  "0020_precious_status.sql"
] as const;

// P8 迁移序列（migrations-p8/，线上由 wrangler d1 execute 按序播放；不进 migrations/）。
export const P8_SQL_FILES = [
  "0021_p8_memories_and_sidecars.sql",
  "0022_p8_daily_log_rebuild.sql",
  "0023_p8_baselines_rebuild.sql",
  "0024_p8_roleless_messages_shared.sql",
  "0025_p8_role_columns_cleanup.sql"
] as const;

const SCOPE_MAPPED_NS_TABLES = [
  "memories",
  "daily_log",
  "long_term_baselines",
  "long_term_baseline_snapshots",
  "baseline_changelog"
] as const;

const ROLE_LESS_SHARED_TABLES = [
  "digest",
  "precious",
  "glossary",
  "longtail",
  "memory_candidates",
  "summaries"
] as const;

const UNTouched_TABLES: Record<string, { key: string; cols: string[] }> = {
  usage_logs: {
    key: "id",
    cols: [
      "id", "message_id", "namespace", "provider", "model", "input_tokens", "output_tokens",
      "cache_read_tokens", "cache_creation_tokens", "cache_mode", "cache_ttl", "raw_usage_json",
      "created_at", "client_system_hash", "cache_anchor_block"
    ]
  },
  users: { key: "id", cols: ["id", "display_name", "created_at", "updated_at"] },
  cache_entries: {
    key: "id",
    cols: ["id", "namespace", "key", "value_json", "value_text", "content_type", "tags", "size_bytes", "expires_at", "created_at", "updated_at"]
  },
  idempotency_keys: { key: "key", cols: ["key", "task_type", "status", "created_at", "updated_at"] }
};

export interface P8UpgradeOptions {
  sourcePath: string;
  copyPath: string;
  force?: boolean;
  migrationsDir?: string; // 缺省 "migrations"（部署序列目录）
  p8Dir?: string; // 缺省 "migrations-p8"
}

export interface P8Preflight {
  shape_ok: boolean;
  old_ledger_present: boolean;
  daily_log_conflicts: number;
  baseline_conflicts: number;
  unknown_scope_rows: Record<string, number>;
  digest_namespaces: number;
  baseline_changelog_domain_ok: boolean;
}

export interface P8UpgradeReport {
  tool: string;
  tool_version: string;
  mode: "upgrade";
  generated_at: string;
  sensitivity_note: string;
  status: "upgraded" | "failed";
  failure: { step: string; error: string } | null;
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
  copy: { path: string; built: boolean; one_time: true; note: string };
  preflight: P8Preflight;
  upgrade: {
    ledger_initial: string[];
    ledger_bootstrap: string[];
    migrations_applied: string[];
    migrations_skipped_same_name: string[];
    migrations_skipped_bootstrap: string[];
    p8_files_applied: string[];
    notes: string[];
  };
  counts: { pre: Record<string, number>; post: Record<string, number>; expected: Record<string, number> };
  namespace_dist: { pre: Record<string, Record<string, number>>; post: Record<string, Record<string, number>> };
  fidelity: {
    carried_maps_equal: Record<string, boolean>;
    untouched_equal: Record<string, boolean>;
    namespace_maps_equal: Record<string, boolean>;
    four_dims_equal: boolean;
    weight_equal: boolean;
    chord_equal: boolean;
    lifecycle: { orphan_rows_pre: number; orphan_memory_ids: string[]; orphan_rows_post: number };
    memories_backfill: {
      fact_key: { expected_non_null: number; post_non_null: number; map_equal: boolean };
      superseded_by: { expected_non_null: number; post_non_null: number; map_equal: boolean };
      version_status_dist: Record<string, number>;
      version_status_expected: Record<string, number>;
      e_axis_non_null: number;
    };
    messages: {
      client_message_hash_non_null: number;
      seq_dist: Record<string, number>;
      seq_dist_expected: Record<string, number>;
    };
    daily_log: { source_message_ids_non_null: number };
    findings: string[];
  };
  shape: {
    fresh_tables: string[];
    post_tables: string[];
    tables_equal: boolean;
    columns_parity: Record<string, boolean>;
    indexes_equal: boolean;
    post_only_indexes: string[];
    fresh_only_indexes: string[];
    role_columns_remaining: { table: string; column: string }[];
    memory_changelog_present: boolean;
    note: string;
  };
  ledger_final: string[];
  ledger_expected: string[];
  runbook: string[];
}

export type P8UpgradeResult =
  | { status: "ok"; report: P8UpgradeReport }
  | { status: "refused"; reason: string }
  | { status: "failed"; report: P8UpgradeReport };

// —— 小工具 ——

function toIso(): string {
  return new Date().toISOString();
}

function listNonSystemTables(db: DatabaseSync): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as { name: string }[]
  ).map((r) => r.name);
}

function countsOf(db: DatabaseSync): Record<string, number> {
  const out: Record<string, number> = {};
  for (const table of listNonSystemTables(db)) {
    const row = db.prepare(`SELECT COUNT(*) AS c FROM ${quoteIdent(table)}`).get() as { c: number };
    out[table] = Number(row.c);
  }
  return out;
}

function indexNames(db: DatabaseSync): string[] {
  return (
    db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'index' AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY name"
      )
      .all() as { name: string }[]
  ).map((r) => r.name);
}

interface ColumnShape {
  name: string;
  type: string;
  notnull: number;
  dflt: string | null;
  pk: number;
}

function columnShapes(db: DatabaseSync, table: string): ColumnShape[] {
  return tableColumns(db, table).map((c: ColumnInfo) => ({
    name: c.name,
    type: c.type,
    notnull: c.notnull ? 1 : 0,
    dflt: c.dflt_value,
    pk: c.pk ? 1 : 0
  }));
}

function rowsOf(db: DatabaseSync, table: string, columns: string[]): Record<string, unknown>[] {
  const stmt = db.prepare(`SELECT ${columns.map(quoteIdent).join(", ")} FROM ${quoteIdent(table)}`);
  stmt.setReadBigInts(true);
  return stmt.all() as Record<string, unknown>[];
}

// 两列结果 → map（第一列 key，第二列 value；value 为 NULL 的行跳过）。
function scalarMap(db: DatabaseSync, sql: string, ...params: SQLInputValue[]): Map<string, string> {
  const stmt = db.prepare(sql);
  stmt.setReadBigInts(true);
  const rows = stmt.all(...params) as Record<string, unknown>[];
  const out = new Map<string, string>();
  for (const row of rows) {
    const keys = Object.keys(row);
    if (row[keys[1]] === null || row[keys[1]] === undefined) continue;
    out.set(String(row[keys[0]]), String(row[keys[1]]));
  }
  return out;
}

function mapsEqual(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    if (b.get(k) !== v) return false;
  }
  return true;
}

// 计数对象比较前归一：去零值 + 键排序（GROUP BY 不产 0 条目，JSON 键序敏感）。
function sortedNumeric(dist: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(dist)
      .filter(([, n]) => n > 0)
      .sort(([a], [b]) => a.localeCompare(b))
  );
}

// 行级内容哈希 map：key = 指定列拼接，value = 携带列哈希（namespace 不参与）。
function contentMap(
  db: DatabaseSync,
  table: string,
  keyColumns: string[],
  hashColumns: string[],
  where?: string
): Map<string, string> {
  const cols = [...new Set([...keyColumns, ...hashColumns])];
  const stmt = db.prepare(
    `SELECT ${cols.map(quoteIdent).join(", ")} FROM ${quoteIdent(table)}${where ?? ""}`
  );
  stmt.setReadBigInts(true);
  const out = new Map<string, string>();
  for (const row of stmt.all() as Record<string, unknown>[]) {
    const key = keyColumns.map((c) => String(row[c])).join("\u0000");
    out.set(key, rowHash(hashColumns, row, new Set()));
  }
  return out;
}

function execFileInTransaction(db: DatabaseSync, sql: string): void {
  db.exec("BEGIN");
  try {
    db.exec(sql);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // 事务不在进行中则忽略
    }
    throw error;
  }
}

// —— 全量（不脱敏）副本构建：schema 逐字克隆 + 逐行原样搬运，rowid 保留 ——

function buildFullCopy(source: DatabaseSync, copyPath: string): string[] {
  const copy = new DatabaseSync(copyPath);
  const created: string[] = [];
  try {
    const schemaObjects = source
      .prepare(
        "SELECT type, name, sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND type IN ('table', 'index') ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name"
      )
      .all() as { type: string; name: string; sql: string }[];
    copy.exec("BEGIN");
    for (const obj of schemaObjects) {
      copy.exec(obj.sql);
      if (obj.type === "table") created.push(obj.name);
    }
    copy.exec("COMMIT");
    for (const table of created) {
      const columns = tableColumns(source, table).map((c) => c.name);
      if (columns.length === 0) continue;
      const selectStmt = source.prepare(`SELECT rowid AS __rid, * FROM ${quoteIdent(table)}`);
      selectStmt.setReadBigInts(true);
      const insertStmt = copy.prepare(
        `INSERT INTO ${quoteIdent(table)} (rowid, ${columns.map(quoteIdent).join(", ")}) VALUES (${["rowid", ...columns].map(() => "?").join(", ")})`
      );
      copy.exec("BEGIN");
      for (const row of selectStmt.iterate() as IterableIterator<Record<string, unknown>>) {
        insertStmt.run(...([row.__rid, ...columns.map((c) => row[c])] as SQLInputValue[]));
      }
      copy.exec("COMMIT");
    }
    return created;
  } catch (error) {
    try {
      copy.exec("ROLLBACK");
    } catch {
      // 事务不在进行中则忽略
    }
    throw error;
  } finally {
    copy.close();
  }
}

// —— 携带列规格（namespace 与新增/删除列都不参与哈希；归属单独审计） ——

interface CarriedSpec {
  table: string;
  keyColumns: string[]; // post 侧键
  hashColumns: string[];
  plannedKey?: boolean; // PK 型重建表：pre 侧键 = planned namespace（+ date）
  sharedKey?: boolean; // digest：PK 即 namespace，pre 侧键固定 'shared'
  preFilter?: string;
}

function carriedSpecs(): CarriedSpec[] {
  return [
    {
      table: "memories",
      keyColumns: ["id"],
      hashColumns: [
        "id", "type", "content", "summary", "importance", "confidence", "status", "pinned",
        "tags", "source", "source_message_ids", "vector_id", "last_recalled_at", "recall_count",
        "created_at", "updated_at", "expires_at", "emotional", "recurrence", "unresolved", "weight"
      ]
    },
    {
      table: "memory_lifecycle",
      keyColumns: ["memory_id"],
      hashColumns: [
        "fact_key", "supersedes_id", "superseded_by_id", "review_reason", "valid_as_of",
        "last_seen_at", "seen_count", "last_injected_at"
      ],
      preFilter: "EXISTS (SELECT 1 FROM memories m WHERE m.id = memory_lifecycle.memory_id)"
    },
    {
      table: "memory_events",
      keyColumns: ["id"],
      hashColumns: ["event_type", "memory_id", "payload_json", "created_at"]
    },
    {
      table: "messages",
      keyColumns: ["id"],
      hashColumns: [
        "conversation_id", "role", "content", "source", "upstream_model", "upstream_provider",
        "request_model", "stream", "finish_reason", "token_input", "token_output", "cache_mode",
        "cache_ttl", "cache_hit", "cache_read_tokens", "cache_creation_tokens", "raw_usage_json",
        "created_at"
      ]
    },
    { table: "conversations", keyColumns: ["id"], hashColumns: ["title", "created_at", "updated_at"] },
    {
      table: "precious",
      keyColumns: ["id"],
      hashColumns: ["content", "context_message_ids", "source", "pinned", "created_at", "last_injected_at", "status"]
    },
    {
      table: "glossary",
      keyColumns: ["id"],
      hashColumns: ["term", "aliases", "definition", "examples", "status", "updated_at", "last_seen_at", "seen_count"]
    },
    { table: "longtail", keyColumns: ["id"], hashColumns: ["content", "ts", "source_message_ids"] },
    {
      table: "memory_candidates",
      keyColumns: ["id"],
      hashColumns: [
        "type", "content", "fact_key", "confidence", "importance", "tags", "source_message_ids",
        "source", "status", "target_memory_id", "decision_note", "created_at", "updated_at"
      ]
    },
    {
      table: "summaries",
      keyColumns: ["id"],
      hashColumns: [
        "conversation_id", "content", "from_message_id", "to_message_id", "message_count",
        "vector_id", "created_at", "updated_at"
      ]
    },
    {
      table: "daily_log",
      keyColumns: ["namespace", "date"],
      hashColumns: ["date", "title", "summary", "updated_at", "affect_chord"],
      plannedKey: true
    },
    { table: "long_term_baselines", keyColumns: ["namespace"], hashColumns: ["content", "version", "generated_at"], plannedKey: true },
    { table: "long_term_baseline_snapshots", keyColumns: ["id"], hashColumns: ["version", "content", "created_at"] },
    {
      table: "baseline_changelog",
      keyColumns: ["id"],
      hashColumns: ["op", "before_content", "after_content", "reason", "created_at", "status", "error_message", "applied_at"]
    },
    { table: "digest", keyColumns: ["namespace"], hashColumns: ["content", "updated_at"], sharedKey: true }
  ];
}

// pre 侧内容 map（lifecycle 只取非孤儿行；重建表用 planned namespace 当键；digest 用固定 shared 键）。
function collectPreContentMaps(source: DatabaseSync): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  for (const spec of carriedSpecs()) {
    if (spec.sharedKey) {
      const stmt = source.prepare(
        `SELECT ${spec.hashColumns.map(quoteIdent).join(", ")} FROM ${quoteIdent(spec.table)}`
      );
      stmt.setReadBigInts(true);
      const m = new Map<string, string>();
      for (const row of stmt.all() as Record<string, unknown>[]) {
        m.set("shared", rowHash(spec.hashColumns, row, new Set()));
      }
      out.set(spec.table, m);
    } else if (spec.plannedKey) {
      const mapped = mappedNamespaceSql('"role_scope"');
      const extra = spec.table === "daily_log" ? ", date" : "";
      const stmt = source.prepare(
        `SELECT CAST(${mapped} AS TEXT) AS ns${extra}, ${spec.hashColumns.map(quoteIdent).join(", ")} FROM ${quoteIdent(spec.table)}`
      );
      stmt.setReadBigInts(true);
      const m = new Map<string, string>();
      for (const row of stmt.all() as Record<string, unknown>[]) {
        const key =
          spec.table === "daily_log" ? `${String(row.ns)}\u0000${String(row.date)}` : String(row.ns);
        m.set(key, rowHash(spec.hashColumns, row, new Set()));
      }
      out.set(spec.table, m);
    } else {
      const where = spec.preFilter ? ` WHERE ${spec.preFilter}` : "";
      out.set(spec.table, contentMap(source, spec.table, spec.keyColumns, spec.hashColumns, where));
    }
  }
  return out;
}

// pre 侧"行 → 期望 namespace"map（P0 §4 namespace 审计的期望侧）。
function collectPreNamespaceMaps(source: DatabaseSync): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  const mapped = mappedNamespaceSql('"role_scope"');

  const plannedByScopeTable = (table: string, keyCol: string | null): Map<string, string> => {
    const mapped2 = mappedNamespaceSql('"role_scope"');
    if (keyCol === null) {
      // PK 型表（long_term_baselines）：期望键 = planned namespace 自身
      return scalarMap(
        source,
        `SELECT CAST(${mapped2} AS TEXT) AS k, CAST(${mapped2} AS TEXT) AS ns FROM ${quoteIdent(table)} WHERE ${mapped2} IS NOT NULL`
      );
    }
    return scalarMap(
      source,
      `SELECT ${quoteIdent(keyCol)} AS k, CAST(${mapped2} AS TEXT) AS ns FROM ${quoteIdent(table)} WHERE ${mapped2} IS NOT NULL`
    );
  };

  out.set("memories", plannedByScopeTable("memories", "id"));
  out.set(
    "daily_log",
    scalarMap(
      source,
      `SELECT CAST(${mapped} AS TEXT) || char(0) || date AS k, CAST(${mapped} AS TEXT) AS ns FROM daily_log`
    )
  );
  out.set("long_term_baselines", plannedByScopeTable("long_term_baselines", null));
  out.set("long_term_baseline_snapshots", plannedByScopeTable("long_term_baseline_snapshots", "id"));
  out.set("baseline_changelog", plannedByScopeTable("baseline_changelog", "id"));

  // 跟随表：lifecycle 非孤儿行跟随 memories；事件孤儿保留原 namespace
  out.set(
    "memory_lifecycle",
    scalarMap(
      source,
      `SELECT l.memory_id AS k, CAST(${mappedNamespaceSql('m."role_scope"')} AS TEXT) AS ns
       FROM memory_lifecycle l JOIN memories m ON m.id = l.memory_id`
    )
  );
  {
    const memPlanned = out.get("memories") ?? new Map<string, string>();
    const events = new Map<string, string>();
    for (const row of rowsOf(source, "memory_events", ["id", "memory_id", "namespace"])) {
      const planned = row.memory_id === null ? undefined : memPlanned.get(String(row.memory_id));
      events.set(String(row.id), planned ?? String(row.namespace));
    }
    out.set("memory_events", events);
  }

  // role-less 五表 + summaries → shared（digest 无 id 列，用单行特例）
  for (const table of ROLE_LESS_SHARED_TABLES) {
    const m = new Map<string, string>();
    if (table === "digest") {
      const rows = rowsOf(source, "digest", ["namespace"]);
      for (const row of rows) m.set("shared", "shared");
    } else {
      for (const row of rowsOf(source, table, ["id"])) m.set(String(row.id), "shared");
    }
    out.set(table, m);
  }

  // messages / conversations：有 role_id 用 role_id，无则保留旧 namespace
  for (const table of ["messages", "conversations"]) {
    const m = new Map<string, string>();
    for (const row of rowsOf(source, table, ["id", "namespace", "role_id"])) {
      m.set(
        String(row.id),
        row.role_id === null || row.role_id === undefined ? String(row.namespace) : String(row.role_id)
      );
    }
    out.set(table, m);
  }
  return out;
}

function namespaceDists(db: DatabaseSync): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const table of listNonSystemTables(db)) {
    const hasNs = tableColumns(db, table).some((c) => c.name === "namespace");
    if (!hasNs) continue;
    const rows = db
      .prepare(`SELECT namespace AS k, COUNT(*) AS c FROM ${quoteIdent(table)} GROUP BY 1 ORDER BY 1`)
      .all() as { k: unknown; c: number }[];
    const dist: Record<string, number> = {};
    for (const r of rows) dist[r.k === null ? "<NULL>" : String(r.k)] = Number(r.c);
    out[table] = dist;
  }
  return out;
}

function expectedCounts(pre: InspectStats, orphanRows: number): Record<string, number> {
  const expected: Record<string, number> = {};
  for (const [table, ts] of Object.entries(pre.tables)) {
    if (table === "d1_migrations" || table === "memory_changelog") continue;
    expected[table] = table === "memory_lifecycle" ? ts.rows - orphanRows : ts.rows;
  }
  expected.processing_cursors = 0; // 裁定：旧运行游标不迁（数量记录在报告）
  expected.memory_changelog = -1; // -1 = 表应已删除
  return expected;
}

// —— 验收：计数 ——

function verifyCounts(report: P8UpgradeReport, pre: InspectStats, post: InspectStats): void {
  for (const [table, want] of Object.entries(report.counts.expected)) {
    if (want === -1) {
      if (post.tables[table]) {
        report.fidelity.findings.push(`表 ${table} 应已删除但迁移后仍存在`);
      }
      continue;
    }
    const got = post.tables[table]?.rows;
    if (got !== want) {
      report.fidelity.findings.push(`表 ${table} 迁移后行数 ${got ?? "缺表"} ≠ 期望 ${want}`);
    }
  }
  for (const [table, ts] of Object.entries(post.tables)) {
    if (table === "d1_migrations" || pre.tables[table]) continue;
    if (["message_fts", "memory_fts"].some((p) => table.startsWith(p))) continue; // fts5 影子表零行即可
    if (ts.rows !== 0) {
      report.fidelity.findings.push(`新分支独有表 ${table} 迁移后应为空，实际 ${ts.rows} 行`);
    }
  }
}

// —— 验收：内容保真 + namespace 归属 ——

function verifyContent(
  sourceDb: DatabaseSync,
  copyDb: DatabaseSync,
  report: P8UpgradeReport,
  preCarried: Map<string, Map<string, string>>,
  preNamespaceMaps: Map<string, Map<string, string>>
): void {
  // 1. 携带列内容哈希（pre 侧 map 在主流程从源库一次性采好）
  for (const spec of carriedSpecs()) {
    const preMap = preCarried.get(spec.table);
    const postMap = contentMap(copyDb, spec.table, spec.keyColumns, spec.hashColumns);
    const equal = preMap !== undefined && mapsEqual(preMap, postMap);
    report.fidelity.carried_maps_equal[spec.table] = equal;
    if (!equal) {
      report.fidelity.findings.push(
        `表 ${spec.table} 携带列内容哈希不一致（pre ${preMap?.size ?? "缺失"} 行 / post ${postMap.size} 行）`
      );
    }
  }

  // 2. 未触碰表：全列原样
  for (const [table, spec] of Object.entries(UNTouched_TABLES)) {
    const preMap = contentMap(sourceDb, table, [spec.key], spec.cols);
    const postMap = contentMap(copyDb, table, [spec.key], spec.cols);
    const equal = mapsEqual(preMap, postMap);
    report.fidelity.untouched_equal[table] = equal;
    if (!equal) report.fidelity.findings.push(`表 ${table} 应全程未触碰但内容不一致`);
  }

  // 3. namespace 行级归属（无一例静默落错）
  for (const [table, preMap] of preNamespaceMaps) {
    let postMap: Map<string, string>;
    if (table === "daily_log") {
      postMap = scalarMap(copyDb, "SELECT namespace || char(0) || date AS k, namespace AS ns FROM daily_log");
    } else if (table === "digest") {
      postMap = scalarMap(copyDb, "SELECT namespace AS k, namespace AS ns FROM digest");
    } else if (table === "long_term_baselines") {
      postMap = scalarMap(copyDb, "SELECT namespace AS k, namespace AS ns FROM long_term_baselines");
    } else {
      const keyCol = table === "memory_lifecycle" ? "memory_id" : "id";
      postMap = scalarMap(copyDb, `SELECT ${quoteIdent(keyCol)} AS k, namespace AS ns FROM ${quoteIdent(table)}`);
    }
    const equal = mapsEqual(preMap, postMap);
    report.fidelity.namespace_maps_equal[table] = equal;
    if (!equal) {
      let mismatches = 0;
      for (const [k, v] of preMap) if (postMap.get(k) !== v) mismatches++;
      for (const k of postMap.keys()) if (!preMap.has(k)) mismatches++;
      report.fidelity.findings.push(`表 ${table} namespace 归属与期望不一致 ${mismatches} 行`);
    }
  }
}

// —— 验收：回填列与专项裁定 ——

function verifyBackfills(
  copyDb: DatabaseSync,
  report: P8UpgradeReport,
  factKeyExpected: Map<string, string>,
  supersededByExpected: Map<string, string>,
  seqExpected: Record<string, number>
): void {
  const fb = report.fidelity.memories_backfill;

  const factKeyPost = scalarMap(
    copyDb,
    "SELECT id AS k, fact_key AS v FROM memories WHERE fact_key IS NOT NULL AND fact_key != ''"
  );
  fb.fact_key = {
    expected_non_null: factKeyExpected.size,
    post_non_null: factKeyPost.size,
    map_equal: mapsEqual(factKeyExpected, factKeyPost)
  };
  if (!fb.fact_key.map_equal) {
    report.fidelity.findings.push(
      `memories.fact_key 回填与 lifecycle 源不一致（期望 ${factKeyExpected.size} / 实际 ${factKeyPost.size}）`
    );
  }

  const supersededByPost = scalarMap(
    copyDb,
    "SELECT id AS k, superseded_by AS v FROM memories WHERE superseded_by IS NOT NULL"
  );
  fb.superseded_by = {
    expected_non_null: supersededByExpected.size,
    post_non_null: supersededByPost.size,
    map_equal: mapsEqual(supersededByExpected, supersededByPost)
  };
  if (!fb.superseded_by.map_equal) {
    report.fidelity.findings.push(
      `memories.superseded_by 回填与 lifecycle 源不一致（期望 ${supersededByExpected.size} / 实际 ${supersededByPost.size}）`
    );
  }

  const vsRows = copyDb
    .prepare("SELECT version_status AS k, COUNT(*) AS c FROM memories GROUP BY 1 ORDER BY 1")
    .all() as { k: unknown; c: number }[];
  fb.version_status_dist = {};
  for (const r of vsRows) fb.version_status_dist[r.k === null ? "<NULL>" : String(r.k)] = Number(r.c);
  // GROUP BY 不产 0 计数条目：期望侧去掉零值、键排序后再比（GROUP BY 输出按键序）
  const expectedVs = sortedNumeric(fb.version_status_expected);
  if (JSON.stringify(fb.version_status_dist) !== JSON.stringify(expectedVs)) {
    report.fidelity.findings.push("memories.version_status 分布与 0007 回填期望不一致");
  }

  fb.e_axis_non_null = Number(
    (
      copyDb
        .prepare("SELECT COUNT(*) AS c FROM memories WHERE authored_by IS NOT NULL OR response_tendency IS NOT NULL")
        .get() as { c: number }
    ).c
  );
  if (fb.e_axis_non_null !== 0) {
    report.fidelity.findings.push(`memories E 轴出现非空值 ${fb.e_axis_non_null} 行（旧无来源，必须 NULL）`);
  }

  const msgs = report.fidelity.messages;
  msgs.client_message_hash_non_null = Number(
    (copyDb.prepare("SELECT COUNT(client_message_hash) AS c FROM messages").get() as { c: number }).c
  );
  if (msgs.client_message_hash_non_null !== 0) {
    report.fidelity.findings.push(
      `messages.client_message_hash 应全置 NULL，实际非空 ${msgs.client_message_hash_non_null}`
    );
  }
  const seqRows = copyDb
    .prepare("SELECT seq AS k, COUNT(*) AS c FROM messages GROUP BY 1 ORDER BY 1")
    .all() as { k: unknown; c: number }[];
  msgs.seq_dist = {};
  for (const r of seqRows) msgs.seq_dist[String(r.k)] = Number(r.c);
  msgs.seq_dist_expected = seqExpected;
  if (JSON.stringify(msgs.seq_dist) !== JSON.stringify(sortedNumeric(seqExpected))) {
    report.fidelity.findings.push("messages.seq 分布与 role 回填期望不一致");
  }

  report.fidelity.daily_log.source_message_ids_non_null = Number(
    (copyDb.prepare("SELECT COUNT(source_message_ids) AS c FROM daily_log").get() as { c: number }).c
  );
  if (report.fidelity.daily_log.source_message_ids_non_null !== 0) {
    report.fidelity.findings.push("daily_log.source_message_ids 应全 NULL（旧日记无来源标注）");
  }

  report.fidelity.lifecycle.orphan_rows_post = Number(
    (
      copyDb
        .prepare(
          "SELECT COUNT(*) AS c FROM memory_lifecycle l WHERE NOT EXISTS (SELECT 1 FROM memories m WHERE m.id = l.memory_id)"
        )
        .get() as { c: number }
    ).c
  );
  if (report.fidelity.lifecycle.orphan_rows_post !== 0) {
    report.fidelity.findings.push(
      `memory_lifecycle 迁移后仍有孤儿 ${report.fidelity.lifecycle.orphan_rows_post} 行`
    );
  }
}

// —— 验收：目标结构（对照全新部署 migrations/0001–0020 的形状） ——

function verifyShape(copyDb: DatabaseSync, report: P8UpgradeReport, migrationsDir: string): void {
  const fresh = new DatabaseSync(":memory:");
  for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
    fresh.exec(readFileSync(join(migrationsDir, file), "utf8"));
  }
  const freshTables = listNonSystemTables(fresh).filter((t) => t !== "d1_migrations");
  const postTables = listNonSystemTables(copyDb).filter((t) => t !== "d1_migrations");
  report.shape.fresh_tables = freshTables;
  report.shape.post_tables = postTables;
  const postSet = new Set(postTables);
  const missing = freshTables.filter((t) => !postSet.has(t));
  const extra = postTables.filter((t) => !freshTables.includes(t));
  report.shape.tables_equal = missing.length === 0 && extra.length === 0;
  if (missing.length) report.fidelity.findings.push(`迁移后缺表: ${missing.join(", ")}`);
  if (extra.length) report.fidelity.findings.push(`迁移后多表: ${extra.join(", ")}`);

  for (const table of freshTables) {
    if (!postSet.has(table)) continue;
    const freshCols = columnShapes(fresh, table).sort((a, b) => a.name.localeCompare(b.name));
    const postCols = columnShapes(copyDb, table).sort((a, b) => a.name.localeCompare(b.name));
    const equal = JSON.stringify(freshCols) === JSON.stringify(postCols);
    report.shape.columns_parity[table] = equal;
    if (!equal) {
      const diffCols = freshCols
        .filter((c) => !postCols.some((p) => p.name === c.name))
        .map((c) => `缺 ${c.name}`)
        .concat(postCols.filter((p) => !freshCols.some((f) => f.name === p.name)).map((p) => `多 ${p.name}`));
      const attrDiff = freshCols
        .filter((c) => {
          const p = postCols.find((x) => x.name === c.name);
          return p !== undefined && JSON.stringify(p) !== JSON.stringify(c);
        })
        .map((c) => `${c.name} 约束差异`);
      report.fidelity.findings.push(
        `表 ${table} 与全新部署形状不一致: ${[...diffCols, ...attrDiff].join(", ")}`
      );
    }
  }

  const freshIdx = indexNames(fresh);
  const postIdx = indexNames(copyDb);
  report.shape.post_only_indexes = postIdx.filter((i) => !freshIdx.includes(i));
  report.shape.fresh_only_indexes = freshIdx.filter((i) => !postIdx.includes(i));
  report.shape.indexes_equal =
    report.shape.post_only_indexes.length === 0 && report.shape.fresh_only_indexes.length === 0;
  if (!report.shape.indexes_equal) {
    report.fidelity.findings.push(
      `索引集合与全新部署不一致（多: ${report.shape.post_only_indexes.join(", ") || "-"} / 缺: ${report.shape.fresh_only_indexes.join(", ") || "-"}）`
    );
  }

  const roleRemaining: { table: string; column: string }[] = [];
  for (const table of postTables) {
    for (const col of tableColumns(copyDb, table)) {
      if (col.name === "role_scope" || col.name === "role_id" || col.name === "role_name") {
        roleRemaining.push({ table, column: col.name });
      }
    }
  }
  report.shape.role_columns_remaining = roleRemaining;
  if (roleRemaining.length) {
    report.fidelity.findings.push(
      `role 列残留: ${roleRemaining.map((r) => `${r.table}.${r.column}`).join(", ")}`
    );
  }
  report.shape.memory_changelog_present = postSet.has("memory_changelog");
  if (report.shape.memory_changelog_present) {
    report.fidelity.findings.push("memory_changelog 应已弃置删除");
  }
  fresh.close();
}

// —— 验收：迁移账本 ——

function verifyLedger(copyDb: DatabaseSync, report: P8UpgradeReport, migrationsDir: string): void {
  const finalNames = (
    copyDb.prepare("SELECT name FROM d1_migrations ORDER BY name").all() as { name: string }[]
  ).map((r) => r.name);
  const expected = [
    ...report.upgrade.ledger_initial,
    ...LEDGER_BOOTSTRAP,
    ...readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .filter(
        (f) =>
          !report.upgrade.ledger_initial.includes(f) &&
          !(LEDGER_BOOTSTRAP as readonly string[]).includes(f)
      ),
    ...P8_SQL_FILES
  ].sort();
  report.ledger_expected = expected;
  if (JSON.stringify(finalNames) !== JSON.stringify(expected)) {
    report.fidelity.findings.push("迁移账本与期望序列不一致");
  }
}

// —— 副本溯源 meta ——

function writeMeta(copyPath: string, report: P8UpgradeReport): void {
  writeFileSync(
    `${copyPath}.meta.json`,
    `${JSON.stringify(
      {
        tool: report.tool,
        tool_version: report.tool_version,
        source_path: report.source.path,
        source_sha256: report.source.sha256_before,
        built_at: report.generated_at,
        status: report.status,
        failure: report.failure,
        sensitivity_note: SENSITIVITY_NOTE
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

// —— 主流程 ——

export async function runP8Upgrade(opts: P8UpgradeOptions): Promise<P8UpgradeResult> {
  const sourceAbs = resolve(opts.sourcePath);
  const copyAbs = resolve(opts.copyPath);
  if (sourceAbs === copyAbs) {
    return { status: "refused", reason: "--source 与 --copy 指向同一文件：源库只读，副本必须分开" };
  }
  if (existsSync(copyAbs) && !opts.force) {
    return {
      status: "refused",
      reason: `一次性副本 ${copyAbs} 已存在。副本承载真实数据且不可重复使用：换一个 --copy 路径，或 --force 从源库重建`
    };
  }
  if (opts.force) {
    rmSync(copyAbs, { force: true });
    rmSync(`${copyAbs}.meta.json`, { force: true });
  }
  const migrationsDir = resolve(opts.migrationsDir ?? "migrations");
  const p8Dir = resolve(opts.p8Dir ?? "migrations-p8");

  const kind = detectSourceKind(sourceAbs);
  const shaBefore = await sha256File(sourceAbs);
  const bytes = statSync(sourceAbs).size;
  const source: SourceHandle = openSource(sourceAbs, kind);

  const report: P8UpgradeReport = {
    tool: "aelios-migration-p8",
    tool_version: P8_TOOL_VERSION,
    mode: "upgrade",
    generated_at: toIso(),
    sensitivity_note: SENSITIVITY_NOTE,
    status: "failed",
    failure: null,
    source: {
      path: sourceAbs,
      kind,
      sha256_before: shaBefore,
      sha256_after: "",
      unchanged: false,
      bytes,
      counts_before: {},
      counts_after: {}
    },
    copy: {
      path: copyAbs,
      built: false,
      one_time: true,
      note: "一次性真实数据副本（未脱敏）：本地敏感文件，不可提交、不可外发；处置完可删除"
    },
    preflight: {
      shape_ok: false,
      old_ledger_present: false,
      daily_log_conflicts: 0,
      baseline_conflicts: 0,
      unknown_scope_rows: {},
      digest_namespaces: 0,
      baseline_changelog_domain_ok: true
    },
    upgrade: {
      ledger_initial: [],
      ledger_bootstrap: [...LEDGER_BOOTSTRAP],
      migrations_applied: [],
      migrations_skipped_same_name: [],
      migrations_skipped_bootstrap: [...LEDGER_BOOTSTRAP],
      p8_files_applied: [],
      notes: []
    },
    counts: { pre: {}, post: {}, expected: {} },
    namespace_dist: { pre: {}, post: {} },
    fidelity: {
      carried_maps_equal: {},
      untouched_equal: {},
      namespace_maps_equal: {},
      four_dims_equal: false,
      weight_equal: false,
      chord_equal: false,
      lifecycle: { orphan_rows_pre: 0, orphan_memory_ids: [], orphan_rows_post: 0 },
      memories_backfill: {
        fact_key: { expected_non_null: 0, post_non_null: 0, map_equal: false },
        superseded_by: { expected_non_null: 0, post_non_null: 0, map_equal: false },
        version_status_dist: {},
        version_status_expected: {},
        e_axis_non_null: 0
      },
      messages: { client_message_hash_non_null: 0, seq_dist: {}, seq_dist_expected: {} },
      daily_log: { source_message_ids_non_null: 0 },
      findings: []
    },
    shape: {
      fresh_tables: [],
      post_tables: [],
      tables_equal: false,
      columns_parity: {},
      indexes_equal: false,
      post_only_indexes: [],
      fresh_only_indexes: [],
      role_columns_remaining: [],
      memory_changelog_present: true,
      note: "列集合/约束/PK 与全新部署一致即通过；同库升级的列顺序（DROP/ADD 追加位）与全新部署不同属预期，代码按列名访问"
    },
    ledger_final: [],
    ledger_expected: [],
    runbook: [
      "线上执行方式（2026-10-24 起自动接入部署链，无需逐条手跑远端命令）：",
      "0) 上线前置：用户自行 wrangler d1 export 备份并确认恢复点",
      "1) stage 1 冻结推送：[vars] MAINTENANCE_MODE = \"true\" → push；构建识别旧库 + 维护态 → 跳过全部 D1 变更，只部署维护态 Worker（写全拒、cron/queue 不消费）",
      "2) 确认 stage 1 构建成功后，stage 2 解冻推送：MAINTENANCE_MODE 显式改回 \"false\"（勿删行——deploy 用 --keep-vars，删行不清除远端旧值，服务会永久 503）→ push；setup 阶段自动执行：账本引导 0018–0020 → d1 migrations apply（新名 0006–0017）→ migrations-p8/0021–0025（整文件事务+自带记账）→ P8 post-verify → 部署正常 Worker",
      "3) 任一步失败：构建中止、不部署 Worker；修复后重推，链路按账本跳过已成功步骤恢复",
      "本离线 orchestrator 用于发布前在导出副本上全量验收（npm run migration:p8），与线上自动链共用同一份 0021–0025 SQL"
    ]
  };

  try {
    // ========== 1. 源库预检（只读） ==========
    report.source.counts_before = countsOf(source.db);
    report.counts.pre = report.source.counts_before;
    const pre = collectInspectStats(source.db);
    if (!pre.migration_shape.shape_ok) {
      return {
        status: "refused",
        reason: "源库形状与旧分支 0001–0010 期望不符（P0 §1），升级方案须重审；拒绝执行"
      };
    }
    const ledgerInitial = (
      source.db.prepare("SELECT name FROM d1_migrations ORDER BY name").all() as { name: string }[]
    ).map((r) => r.name);
    report.upgrade.ledger_initial = ledgerInitial;
    if (ledgerInitial.length !== 10) {
      return {
        status: "refused",
        reason: `迁移账本非旧分支 0001–0010 形状（读到 ${ledgerInitial.length} 条）：非线上同源导出，拒绝执行`
      };
    }

    const dailyConflicts = computeDailyLogConflicts(pre.daily_log_groups);
    const baselineConflicts = computeBaselineConflicts(pre.scope_pairs.long_term_baselines ?? []);
    report.preflight.daily_log_conflicts = dailyConflicts.length;
    report.preflight.baseline_conflicts = baselineConflicts.length;
    if (dailyConflicts.length > 0 || baselineConflicts.length > 0) {
      return {
        status: "refused",
        reason: `映射后主键冲突非空（daily_log ${dailyConflicts.length} 处 / baselines ${baselineConflicts.length} 处）：清单等用户裁定，不静默合并；拒绝执行`
      };
    }

    const unknownRows: Record<string, number> = {};
    let unknownTotal = 0;
    for (const table of [...SCOPE_MAPPED_NS_TABLES, "memory_lifecycle"]) {
      const pairs: ScopePair[] = pre.scope_pairs[table] ?? [];
      const rows = unknownScopePairs(pairs).reduce((acc, p) => acc + p.rows, 0);
      if (rows > 0) unknownRows[table] = rows;
      unknownTotal += rows;
    }
    report.preflight.unknown_scope_rows = unknownRows;
    if (unknownTotal > 0) {
      return {
        status: "refused",
        reason: `未知 role_scope 共 ${unknownTotal} 行（表×行数见本地报告）：不猜去向，且后续会删除 role 列，必须先裁定；拒绝执行`
      };
    }

    const digestNamespaces = Number(
      (source.db.prepare("SELECT COUNT(DISTINCT namespace) AS c FROM digest").get() as { c: number }).c
    );
    report.preflight.digest_namespaces = digestNamespaces;
    if (digestNamespaces > 1) {
      return {
        status: "refused",
        reason: `digest 有 ${digestNamespaces} 个 distinct namespace：归一 shared 会撞主键（PK=namespace），需先裁定取舍；拒绝执行`
      };
    }

    const badChangelogDomain = Number(
      (
        source.db
          .prepare(
            "SELECT COUNT(*) AS c FROM baseline_changelog WHERE op NOT IN ('add','update','delete') OR status NOT IN ('pending','applied','conflict')"
          )
          .get() as { c: number }
      ).c
    );
    report.preflight.baseline_changelog_domain_ok = badChangelogDomain === 0;
    if (badChangelogDomain > 0) {
      return {
        status: "refused",
        reason: `baseline_changelog 有 ${badChangelogDomain} 行 op/status 在新 CHECK 值域外：需先裁定；拒绝执行`
      };
    }
    report.preflight.shape_ok = true;
    report.preflight.old_ledger_present = true;

    // ========== 2. pre 侧证据（孤儿清单 / 回填期望 / 内容与归属期望） ==========
    const orphanIds = (
      source.db
        .prepare(
          "SELECT memory_id FROM memory_lifecycle l WHERE NOT EXISTS (SELECT 1 FROM memories m WHERE m.id = l.memory_id) ORDER BY memory_id"
        )
        .all() as { memory_id: string }[]
    ).map((r) => r.memory_id);
    report.fidelity.lifecycle.orphan_rows_pre = orphanIds.length;
    report.fidelity.lifecycle.orphan_memory_ids = orphanIds;

    const factKeyExpected = scalarMap(
      source.db,
      "SELECT l.memory_id AS k, l.fact_key AS v FROM memory_lifecycle l JOIN memories m ON m.id = l.memory_id WHERE l.fact_key IS NOT NULL AND l.fact_key != ''"
    );
    const supersededByExpected = scalarMap(
      source.db,
      "SELECT l.memory_id AS k, l.superseded_by_id AS v FROM memory_lifecycle l JOIN memories m ON m.id = l.memory_id WHERE l.superseded_by_id IS NOT NULL"
    );
    const preSuperseded = Number(
      (source.db.prepare("SELECT COUNT(*) AS c FROM memories WHERE status = 'superseded'").get() as { c: number }).c
    );
    report.fidelity.memories_backfill.version_status_expected = {
      superseded: preSuperseded,
      current: (pre.tables.memories?.rows ?? 0) - preSuperseded
    };
    const seqExpected: Record<string, number> = {};
    for (const [role, count] of Object.entries(pre.messages.role_dist ?? {})) {
      const bucket = role === "user" ? "0" : role === "assistant" ? "1" : "2";
      seqExpected[bucket] = (seqExpected[bucket] ?? 0) + Number(count);
    }
    report.fidelity.messages.seq_dist_expected = seqExpected;
    report.namespace_dist.pre = namespaceDists(source.db);
    const preCarried = collectPreContentMaps(source.db);
    const preNamespaceMaps = collectPreNamespaceMaps(source.db);
    report.counts.expected = expectedCounts(pre, orphanIds.length);

    // ========== 3. 一次性副本构建（真实数据，不脱敏） ==========
    buildFullCopy(source.db, copyAbs);
    report.copy.built = true;
    const copyDb = new DatabaseSync(copyAbs);

    try {
      // ========== 4. 账本引导（0018–0020 同构列已存在，标记跳过防 duplicate column） ==========
      const insertLedger = copyDb.prepare("INSERT INTO d1_migrations (name) VALUES (?)");
      for (const name of LEDGER_BOOTSTRAP) insertLedger.run(name);

      // ========== 5. 部署序列（模拟 wrangler d1 migrations apply 的名字语义） ==========
      const migrationFiles = readdirSync(migrationsDir)
        .filter((f) => f.endsWith(".sql"))
        .sort();
      const ledgerNow = new Set(
        (copyDb.prepare("SELECT name FROM d1_migrations").all() as { name: string }[]).map((r) => r.name)
      );
      for (const file of migrationFiles) {
        if (ledgerNow.has(file)) {
          if (!(LEDGER_BOOTSTRAP as readonly string[]).includes(file)) {
            report.upgrade.migrations_skipped_same_name.push(file);
          }
          continue;
        }
        const sql = readFileSync(join(migrationsDir, file), "utf8");
        try {
          execFileInTransaction(copyDb, sql);
        } catch (error) {
          report.failure = {
            step: `migrations/${file}`,
            error: error instanceof Error ? error.message : String(error)
          };
          throw error;
        }
        insertLedger.run(file);
        report.upgrade.migrations_applied.push(file);
        if (file === "0017_baselines.sql") {
          report.upgrade.notes.push(
            "0017 在同库升级路径上是结构 no-op（三张 baseline 表已以旧形状存在），实际形状修复由 migrations-p8/0023 完成"
          );
        }
      }
      report.upgrade.migrations_skipped_same_name.sort();

      // ========== 6. P8 数据迁移（migrations-p8/，按序单事务） ==========
      const p8Files = readdirSync(p8Dir).filter((f) => f.endsWith(".sql")).sort();
      const expectedP8 = [...P8_SQL_FILES];
      if (JSON.stringify(p8Files) !== JSON.stringify(expectedP8)) {
        throw new Error(
          `migrations-p8/ 目录内容与期望序列不一致：读到 [${p8Files.join(", ")}]，期望 [${expectedP8.join(", ")}]`
        );
      }
      for (const file of expectedP8) {
        const sql = readFileSync(join(p8Dir, file), "utf8");
        try {
          execFileInTransaction(copyDb, sql);
          // 文件末尾自带同事务记账（部署链与本地同一份 SQL）；此处只核账不重插
          const recorded = copyDb.prepare("SELECT COUNT(*) AS c FROM d1_migrations WHERE name = ?").get(file) as { c: number };
          if (Number(recorded.c) !== 1) {
            throw new Error(`P8 文件 ${file} 执行完成但账本未记录（应自带记账 INSERT）`);
          }
        } catch (error) {
          report.failure = {
            step: `migrations-p8/${file}`,
            error: error instanceof Error ? error.message : String(error)
          };
          throw error;
        }
        report.upgrade.p8_files_applied.push(file);
      }

      // ========== 7. 迁移后验收（P0 §4） ==========
      const post = collectInspectStats(copyDb);
      report.counts.post = countsOf(copyDb);
      report.namespace_dist.post = namespaceDists(copyDb);
      verifyCounts(report, pre, post);
      verifyContent(source.db, copyDb, report, preCarried, preNamespaceMaps);
      verifyBackfills(copyDb, report, factKeyExpected, supersededByExpected, seqExpected);
      verifyShape(copyDb, report, migrationsDir);
      verifyLedger(copyDb, report, migrationsDir);

      // 四维 / weight / affect_chord 统计前后一致（超界值与公式不一致原样保留的验证）
      report.fidelity.four_dims_equal =
        pre.four_dims !== null &&
        post.four_dims !== null &&
        JSON.stringify(pre.four_dims.dimensions) === JSON.stringify(post.four_dims.dimensions);
      if (!report.fidelity.four_dims_equal) report.fidelity.findings.push("四维统计前后不一致（超界值必须原样）");
      report.fidelity.weight_equal =
        pre.weight !== null &&
        post.weight !== null &&
        JSON.stringify(pre.weight) === JSON.stringify(post.weight);
      if (!report.fidelity.weight_equal) report.fidelity.findings.push("weight 统计前后不一致（不重算）");
      report.fidelity.chord_equal =
        pre.affect_chord !== null &&
        post.affect_chord !== null &&
        JSON.stringify(pre.affect_chord) === JSON.stringify(post.affect_chord);
      if (!report.fidelity.chord_equal) report.fidelity.findings.push("daily_log.affect_chord 统计前后不一致");

      const shaAfter = await sha256File(sourceAbs);
      report.source.sha256_after = shaAfter;
      report.source.unchanged = shaBefore === shaAfter;
      report.source.counts_after = countsOf(source.db);
      if (!report.source.unchanged) {
        report.fidelity.findings.push("源库文件 sha256 前后不一致（源必须只读）");
      }

      report.ledger_final = (
        copyDb.prepare("SELECT name FROM d1_migrations ORDER BY name").all() as { name: string }[]
      ).map((r) => r.name);
      if (report.fidelity.findings.length > 0) {
        report.failure = { step: "verification", error: report.fidelity.findings.join("；") };
      } else {
        report.status = "upgraded";
      }
    } finally {
      try {
        copyDb.close();
      } catch {
        // 已关闭则忽略
      }
    }
  } catch (error) {
    if (!report.failure) {
      report.failure = {
        step: "upgrade",
        error: error instanceof Error ? error.message : String(error)
      };
    }
    writeMeta(copyAbs, report);
    return { status: "failed", report };
  } finally {
    source.db.close();
  }

  writeMeta(copyAbs, report);
  return { status: "ok", report };
}
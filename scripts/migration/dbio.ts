// =====================================================================
// P7 迁移预演 · SQLite/D1 IO 层（node:sqlite，零新依赖）。
//
// 安全约束：
//   - 源库一律只读打开（sqlite 文件走 readOnly 连接；SQL 导出先在内存里还原，
//     磁盘源文件全程只读），运行前后对源文件做 sha256 比对，证不变；
//   - 脱敏副本构建：正文列用确定性 sha256 掩码替换，真实正文不过盘、不进报告；
//   - 路径全部显式传入，本工具不读任何配置文件、不找凭证；
//   - 工具只写两类文件：--copy 指定的副本与 --report 指定的报告（含副本的
//     .meta.json 溯源文件），绝不写源库。
// =====================================================================

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { existsSync, readFileSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import {
  CONTENT_COLUMNS,
  MASK_PREFIX,
  MASK_SUFFIX,
  SAMPLE_SIZE_PER_TABLE
} from "./schema";

export type SourceKind = "sqlite-file" | "sql-dump";

export interface SourceHandle {
  kind: SourceKind;
  path: string;
  db: DatabaseSync; // sqlite-file: readOnly 连接；sql-dump: 内存库（源文件只读）
}

const SQLITE_FILE_EXTS = new Set([".sqlite", ".db", ".sqlite3", ".d1"]);
const DUMP_FILE_EXTS = new Set([".sql"]);

export function detectSourceKind(path: string): SourceKind {
  const lower = path.toLowerCase();
  if (lower.endsWith(".sql")) return "sql-dump";
  for (const ext of SQLITE_FILE_EXTS) {
    if (lower.endsWith(ext)) return "sqlite-file";
  }
  throw new Error(
    `无法识别源文件类型：${path}（支持 .sql 导出 或 ${[...SQLITE_FILE_EXTS].join("/")} 数据库文件；数据库路径由 --source 显式传入）`
  );
}

export async function sha256File(path: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

// 打开源（只读）。sql-dump 在内存里还原；真实数据只存在于内存，掩码后才落副本。
export function openSource(path: string, kind: SourceKind): SourceHandle {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`源文件不存在：${path}`);
  }
  if (kind === "sqlite-file") {
    const db = new DatabaseSync(path, { readOnly: true });
    return { kind, path, db };
  }
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(path, "utf8"));
  return { kind, path, db };
}

export function closeSource(handle: SourceHandle): void {
  try {
    handle.db.close();
  } catch {
    // 已关闭则忽略
  }
}

// —— 只读查询辅助（统计走默认数字模式；原始行读取走 bigint 模式防超大整数抛错） ——

export function listTables(db: DatabaseSync): string[] {
  return (
    db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      )
      .all() as { name: string }[]
  ).map((r) => r.name);
}

export interface ColumnInfo {
  name: string;
  type: string;
  notnull: boolean;
  dflt_value: string | null;
  pk: boolean;
}

export function tableColumns(db: DatabaseSync, table: string): ColumnInfo[] {
  const rows = db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all() as Record<string, unknown>[];
  return rows.map((r) => ({
    name: String(r.name),
    type: String(r.type ?? ""),
    notnull: Number(r.notnull) === 1,
    dflt_value: r.dflt_value === null ? null : String(r.dflt_value),
    pk: Number(r.pk) > 0
  }));
}

export function quoteIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`非法标识符：${name}`);
  }
  return `"${name}"`;
}

export function tableCount(db: DatabaseSync, table: string): number {
  return Number((db.prepare(`SELECT COUNT(*) AS c FROM ${quoteIdent(table)}`).get() as { c: number }).c);
}

// 确定性抽样：固定种子 mulberry32 打乱 rowid 后取前 N 张（P0 §4 随机抽样 + §2 可复现）。
// WITHOUT ROWID 表（fts5 影子表如 *_idx）没有 rowid 列：跳过抽样而不是崩——
// 抽样哈希对这类表本来就不适用（P8 升级后的库含 fts 影子表，inspect 须能复跑）。
export function sampleRowids(db: DatabaseSync, table: string, size = SAMPLE_SIZE_PER_TABLE): string[] {
  let rows: { rid: number }[];
  try {
    rows = db.prepare(`SELECT rowid AS rid FROM ${quoteIdent(table)}`).all() as { rid: number }[];
  } catch (error) {
    if (String(error).includes("no such column")) return [];
    throw error;
  }
  const rids = rows.map((r) => String(r.rid));
  shuffleSeeded(rids);
  return rids.slice(0, size);
}

function shuffleSeeded(items: string[]): void {
  // Fisher-Yates + mulberry32(0x0a71o5)，种子写死保证两轮抽样一致。
  let state = 0x0a71e5;
  const rand = () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
}

// 值的确定性序列化（行哈希输入；区分 NULL/数字/文本，防 "1" 与 1 同哈希）。
export function valueToken(value: unknown): string {
  if (value === null || value === undefined) return "\u0001N";
  if (typeof value === "number") return Number.isFinite(value) ? `\u0001D${value}` : `\u0001X${value}`;
  if (typeof value === "bigint") return `\u0001I${value}`;
  if (typeof value === "string") return `\u0001S${value}`;
  if (typeof value === "boolean") return `\u0001B${value}`;
  return `\u0001?${String(value)}`;
}

// 行哈希：列名 + 值 token 依次拼接后 sha256；exclude 列（namespace）跳过。
export function rowHash(columnNames: string[], row: Record<string, unknown>, exclude: Set<string>): string {
  const parts: string[] = [];
  for (const col of columnNames) {
    if (exclude.has(col)) continue;
    parts.push(`${col}\u0000${valueToken(row[col])}\u0000`);
  }
  return sha256Hex(parts.join(""));
}

// 正文掩码：确定性 sha256 前缀，保非空、保 NULL；数值列不动。
export function maskValue(value: unknown, table: string, column: string): unknown {
  const masked = CONTENT_COLUMNS[table] ?? [];
  if (!masked.includes(column)) return value;
  if (typeof value !== "string" || value.length === 0) return value;
  return `${MASK_PREFIX}${sha256Hex(value).slice(0, 16)}${MASK_SUFFIX}`;
}

// —— 脱敏副本构建 ——

export interface CopyBuildResult {
  createdTables: string[];
  sourceSampleCheck: {
    table: string;
    rowid: string;
    structuralHashMatch: boolean;
    maskedContentMatch: boolean;
  }[];
}

// 把源库（只读连接或内存还原）克隆为脱敏副本文件：schema 逐字克隆（sqlite_schema 的
// sql 原样执行），数据逐行搬运并掩码正文列，rowid 保留（两轮抽样/哈希可对齐）。
export function buildSanitizedCopy(source: DatabaseSync, copyPath: string): CopyBuildResult {
  const copy = new DatabaseSync(copyPath);
  const createdTables: string[] = [];
  try {
    const schemaObjects = source
      .prepare(
        "SELECT type, name, sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND type IN ('table', 'index') ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name"
      )
      .all() as { type: string; name: string; sql: string }[];
    copy.exec("BEGIN");
    for (const obj of schemaObjects) {
      copy.exec(obj.sql);
      if (obj.type === "table") createdTables.push(obj.name);
    }
    copy.exec("COMMIT");

    const sampleCheck: CopyBuildResult["sourceSampleCheck"] = [];
    for (const table of createdTables) {
      copyTable(source, copy, table, sampleCheck);
    }
    return { createdTables, sourceSampleCheck: sampleCheck };
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

function copyTable(
  source: DatabaseSync,
  copy: DatabaseSync,
  table: string,
  sampleCheck: CopyBuildResult["sourceSampleCheck"]
): void {
  const columns = tableColumns(source, table);
  const columnNames = columns.map((c) => c.name);
  const contentCols = new Set(CONTENT_COLUMNS[table] ?? []);
  const selectStmt = source.prepare(`SELECT rowid AS __rid, * FROM ${quoteIdent(table)}`);
  selectStmt.setReadBigInts(true);
  const insertStmt = copy.prepare(
    `INSERT INTO ${quoteIdent(table)} (rowid, ${columnNames.map(quoteIdent).join(", ")}) VALUES (${["rowid", ...columnNames].map(() => "?").join(", ")})`
  );

  const sampled = new Set(sampleRowids(source, table));
  copy.exec("BEGIN");
  for (const row of selectStmt.iterate() as IterableIterator<Record<string, unknown>>) {
    const values: unknown[] = [];
    for (const col of columnNames) {
      values.push(maskValue(row[col], table, col));
    }
    insertStmt.run(...([row.__rid, ...values] as SQLInputValue[]));
    const rid = String(row.__rid);
    if (sampled.has(rid)) {
      // 构建保真：结构列（非掩码列）逐值相同；掩码列 = mask(源值)。
      const sourceRow = { ...row };
      const copyRow = readCopyRowByRowid(copy, table, columnNames, row.__rid);
      const structuralCols = columnNames.filter((c) => !contentCols.has(c));
      sampleCheck.push({
        table,
        rowid: rid,
        structuralHashMatch:
          rowHash(structuralCols, sourceRow, new Set()) === rowHash(structuralCols, copyRow, new Set()),
        maskedContentMatch: columnNames
          .filter((c) => contentCols.has(c))
          .every((c) => {
            const masked = maskValue(sourceRow[c], table, c);
            const stored = copyRow[c];
            return valueToken(masked) === valueToken(stored);
          })
      });
    }
  }
  copy.exec("COMMIT");
}

function readCopyRowByRowid(
  db: DatabaseSync,
  table: string,
  columnNames: string[],
  rowid: unknown
): Record<string, unknown> {
  const stmt = db.prepare(`SELECT * FROM ${quoteIdent(table)} WHERE rowid = ?`);
  stmt.setReadBigInts(true);
  return stmt.get(rowid as SQLInputValue) as Record<string, unknown>;
}
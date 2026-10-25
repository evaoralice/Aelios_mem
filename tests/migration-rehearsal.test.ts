import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { computeWeight } from "../src/extensions/memoryWeight";
import { runRehearse } from "../scripts/migration/rehearse";
import type { RehearseReport } from "../scripts/migration/rehearse";
import { parseArgs, runInspect } from "../scripts/migration-rehearsal";

// P7 迁移预演验收（P0 迁移验收清单 §1/§2/§4）：
//   1. 源库只读：inspect + rehearse 前后文件哈希与逐表计数不变；
//   2. 空库 / 典型旧库 / 重复演练；
//   3. role id/name/shared 映射统计；
//   4. 无 role 记录、未知 role、目标冲突只进报告，不猜测不合并；
//   5. 四维、weight、affect_chord、E 轴、版本链、软删除字段保真；
//   6. 报告与溯源 meta 不含正文（SECRET_ 探针全量扫描）；
//   7. 形状偏离拒绝演练；sql-dump 源可用；CLI 参数校验。
// 全程用合成数据：fixture DDL 逐字取自旧分支 fix/logic-review 0001–0010。

const SCHEMA_SECTIONS: { name: string; sql: string }[] = (() => {
  const raw = readFileSync(new URL("./fixtures/old-branch-schema.sql", import.meta.url), "utf8");
  const parts = raw.split(/^-- ==== /m).filter((p) => p.trim().length > 0);
  return parts.map((p) => {
    const nl = p.indexOf("\n");
    return { name: p.slice(0, nl).replace(/ ====$/, "").trim(), sql: p.slice(nl + 1) };
  });
})();

const SECTION_ORDER = [
  "0001_init",
  "0002_v4_assembler_cache",
  "0003_v2_memory_lifecycle",
  "0004_v2_daily_log",
  "0005_memory_candidates",
  "0006_role_memory_baseline",
  "0007_baseline_changelog",
  "0008_precious_soft_delete",
  "0009_daily_log_affect_chord",
  "0010_memory_weight_dimensions"
];

function applyOldSchema(db: DatabaseSync, upto: string): void {
  const end = SECTION_ORDER.indexOf(upto);
  for (let i = 0; i <= end; i++) {
    const section = SCHEMA_SECTIONS.find((s) => s.name === SECTION_ORDER[i]);
    assert.ok(section, `fixture 缺少 ${SECTION_ORDER[i]}`);
    db.exec(section.sql);
  }
  const applied = SECTION_ORDER.slice(0, end + 1).map((n) => `${n}.sql`);
  db.exec(
    "CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL)"
  );
  const insert = db.prepare("INSERT INTO d1_migrations (name, created_at) VALUES (?, ?)");
  for (const name of applied) insert.run(name, "2026-01-01T00:00:00.000Z");
}

const TS = "2026-01-01T00:00:00.000Z";

// 典型旧库种子：覆盖 id/name/shared 三类 scope、未知 scope、空 id、超界四维、
// weight 与公式不一致、chord、版本链（m7 取代 m1）、软删除行、孤儿侧车/事件、
// PK 冲突（daily_log 与 baselines 各一处）、role-less 表、无 role 的消息/对话、弃用表。
function seedTypical(db: DatabaseSync): void {
  const mem = db.prepare(
    `INSERT INTO memories (id, namespace, type, content, summary, importance, confidence, status, tags,
       created_at, updated_at, role_id, role_name, role_scope, emotional, recurrence, unresolved, weight)
     VALUES (?, ?, 'fact', ?, NULL, ?, 0.8, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const w = (i: number, e: number, r: number, u: number) => computeWeight({ importance: i, emotional: e, recurrence: r, unresolved: u });
  mem.run("m1", "ns-sol", "SECRET_MEMO_SOL_A", 0.5, "active", TS, TS, "sol", "Sol", "id:sol", 0.2, 0.1, 0, w(0.5, 0.2, 0.1, 0));
  mem.run("m2", "ns-name", "SECRET_MEMO_NAME_B", 0.6, "active", TS, TS, null, "Ａlice", "name:Alice", 0, 0, 0, w(0.6, 0, 0, 0));
  mem.run("m3", "ns-shared", "SECRET_MEMO_SHARED_C", 0.5, "active", TS, TS, null, null, "shared", 0, 0, 0, w(0.5, 0, 0, 0));
  mem.run("m4", "ns-ke", "SECRET_MEMO_OOR_D", 1.5, "active", TS, TS, "ke", "Ke", "id:ke", 1.2, 0.9, 0.7, 1.75); // 超界 + weight 与公式不一致（只报告不修）
  mem.run("m5", "ns-weird", "SECRET_MEMO_UNKNOWN_E", 0.5, "active", TS, TS, null, null, "legacy-direct", 0, 0, 0, w(0.5, 0, 0, 0)); // 未知 scope
  mem.run("m6", "ns-emp", "SECRET_MEMO_EMPTY_ID_F", 0.5, "active", TS, TS, null, null, "id:", 0, 0, 0, w(0.5, 0, 0, 0)); // 空 id → 未知
  mem.run("m7", "ns-sol", "SECRET_MEMO_SUP_G", 0.5, "superseded", TS, TS, "sol", "Sol", "id:sol", 0, 0, 0, w(0.5, 0, 0, 0));

  const lc = db.prepare(
    `INSERT INTO memory_lifecycle (memory_id, namespace, fact_key, supersedes_id, superseded_by_id, seen_count, role_scope)
     VALUES (?, ?, ?, ?, ?, 0, ?)`
  );
  lc.run("m1", "ns-sol", "SECRET_FK_M1", null, "m7", "id:sol");
  lc.run("m7", "ns-sol", "SECRET_FK_M7", "m1", null, "id:sol");
  lc.run("orphan-x", "ns-orphan", "SECRET_FK_ORPHAN", null, null, "id:sol"); // 孤儿侧车

  const dl = db.prepare(
    `INSERT INTO daily_log (namespace, role_scope, date, title, summary, updated_at, affect_chord)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  dl.run("ns-a", "id:sol", "2026-01-01", "SECRET_TITLE_1", "SECRET_SUMMARY_1", TS, "Fmaj9 -> C -> Am");
  dl.run("ns-b", "id:sol", "2026-01-01", "SECRET_TITLE_2", "SECRET_SUMMARY_2", TS, null); // 与上一行映射后撞 (sol, 2026-01-01)
  dl.run("ns-a", "id:sol", "2026-01-02", "SECRET_TITLE_3", "SECRET_SUMMARY_3", TS, null);

  db.exec(
    `INSERT INTO long_term_baselines (namespace, role_scope, content, version, generated_at) VALUES
       ('ns-a', 'id:sol', 'SECRET_BASELINE_A', 1, '${TS}'),
       ('ns-b', 'id:sol', 'SECRET_BASELINE_B', 2, '${TS}'),
       ('ns-n', 'name:Alice', 'SECRET_BASELINE_N', 1, '${TS}')`
  );
  db.exec(
    `INSERT INTO long_term_baseline_snapshots (id, namespace, role_scope, version, content, created_at) VALUES
       ('s1', 'ns-a', 'id:sol', 1, 'SECRET_SNAP_1', '${TS}'),
       ('s2', 'ns-n', 'name:Alice', 1, 'SECRET_SNAP_2', '${TS}')`
  );
  db.exec(
    `INSERT INTO baseline_changelog (id, namespace, role_scope, op, after_content, reason, created_at, status) VALUES
       ('c1', 'ns-a', 'id:sol', 'add', 'SECRET_AFTER_1', 'SECRET_REASON_1', '${TS}', 'pending')`
  );

  db.exec(
    `INSERT INTO memory_events (id, namespace, event_type, memory_id, payload_json, created_at) VALUES
       ('e1', 'ns-sol', 'recall', 'm1', 'SECRET_PAYLOAD_1', '${TS}'),
       ('e2', 'ns-orphan', 'recall', 'orphan-x', 'SECRET_PAYLOAD_2', '${TS}')`
  );

  db.exec(
    `INSERT INTO digest (namespace, content, updated_at) VALUES
       ('ns-sol', 'SECRET_DIGEST_1', '${TS}'), ('ns-ke', 'SECRET_DIGEST_2', '${TS}')`
  );
  db.exec(
    `INSERT INTO precious (id, namespace, content, source, pinned, created_at, status) VALUES
       ('p1', 'ns-sol', 'SECRET_PRECIOUS_1', 'human', 1, '${TS}', 'active'),
       ('p2', 'ns-sol', 'SECRET_PRECIOUS_2', 'human', 1, '${TS}', 'deleted')`
  );
  db.exec(
    `INSERT INTO glossary (id, namespace, term, aliases, definition, examples, status, updated_at, seen_count) VALUES
       ('g1', 'ns-sol', 'SECRET_TERM', '[]', 'SECRET_DEF', '[]', 'active', '${TS}', 0)`
  );
  db.exec(
    `INSERT INTO longtail (id, namespace, content, ts) VALUES
       ('lt1', 'ns-sol', 'SECRET_LONGTAIL_1', '${TS}')`
  );
  db.exec(
    `INSERT INTO memory_candidates (id, namespace, type, content, fact_key, source, status, created_at, updated_at) VALUES
       ('mc1', 'ns-sol', 'note', 'SECRET_CAND_1', 'SECRET_FK_CAND', 'extract', 'pending', '${TS}', '${TS}')`
  );

  db.exec(
    `INSERT INTO messages (id, conversation_id, namespace, role, content, created_at, role_id, role_name) VALUES
       ('msg1', 'conv1', 'ns-sol', 'user', 'SECRET_CHAT_1', '${TS}', 'sol', 'Sol'),
       ('msg2', 'conv1', 'ns-plain', 'user', 'SECRET_CHAT_2', '${TS}', NULL, NULL)`
  );
  db.exec(
    `INSERT INTO conversations (id, namespace, title, created_at, updated_at, role_id, role_name) VALUES
       ('conv1', 'ns-sol', 'SECRET_CONV_TITLE', '${TS}', '${TS}', 'sol', 'Sol'),
       ('conv2', 'ns-plain', NULL, '${TS}', '${TS}', NULL, NULL)`
  );
  db.exec(
    `INSERT INTO usage_logs (id, message_id, namespace, provider, model, input_tokens, output_tokens, raw_usage_json, created_at) VALUES
       ('u1', 'msg1', 'ns-sol', 'anthropic', 'model-x', 10, 20, 'SECRET_USAGE_JSON', '${TS}')`
  );
  db.exec(`INSERT INTO users (id, display_name, created_at, updated_at) VALUES ('u1', 'SECRET_USER_NAME', '${TS}', '${TS}')`);
  db.exec(
    `INSERT INTO summaries (id, namespace, content, created_at, updated_at) VALUES
       ('sm1', 'ns-sol', 'SECRET_SUMMARY_OLD', '${TS}', '${TS}')`
  );
  db.exec(
    `INSERT INTO cache_entries (id, namespace, key, value_json, created_at, updated_at) VALUES
       ('ce1', 'ns-sol', 'k1', 'SECRET_CACHE_JSON', '${TS}', '${TS}')`
  );
  db.exec(
    `INSERT INTO processing_cursors (name, value, updated_at) VALUES ('digest-cursor', 'SECRET_CURSOR_VALUE', '${TS}')`
  );
  db.exec(
    `INSERT INTO idempotency_keys (key, task_type, status, created_at, updated_at) VALUES
       ('SECRET_IDEM_KEY', 'digest', 'done', '${TS}', '${TS}')`
  );
  db.exec(
    `INSERT INTO memory_changelog (id, namespace, role_scope, op, target_id, after_content, payload_json, reason, created_at, status) VALUES
       ('ch1', 'ns-sol', 'id:sol', 'add', 'm1', 'SECRET_MC_AFTER', '{}', 'SECRET_MC_REASON', '${TS}', 'pending')`
  );
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function tableCounts(path: string): Record<string, number> {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const out: Record<string, number> = {};
    for (const { name } of db
      .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as { name: string }[]) {
      out[name] = (db.prepare(`SELECT COUNT(*) AS c FROM "${name}"`).get() as { c: number }).c;
    }
    return out;
  } finally {
    db.close();
  }
}

function buildSourceFile(dir: string, name: string, upto: string, seed: boolean): string {
  const path = join(dir, name);
  const db = new DatabaseSync(path);
  applyOldSchema(db, upto);
  if (seed && upto === "0010_memory_weight_dimensions") seedTypical(db);
  db.close();
  return path;
}

function rehearseOpts(source: string, copy: string, extra: Partial<Parameters<typeof runRehearse>[0]> = {}) {
  return {
    sourcePath: source,
    copyPath: copy,
    forceRebuild: false,
    allowNamespaces: null,
    ...extra
  };
}

function assertNoSecrets(text: string, label: string): void {
  const hits = text.match(/SECRET_[A-Z0-9_]+/g);
  assert.strictEqual(hits, null, `${label} 不得包含正文（探针命中: ${hits?.slice(0, 5).join(", ")}）`);
}

// 确定性掩码的期望值（与 dbio.maskValue 同式：sha256 前 16 位）。
function expectedMask(value: string): string {
  return `«masked:${createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16)}»`;
}

// 脱敏副本本身的 SECRET_ 探针扫描：副本所有表的所有行都不得含探针明文
// （掩码列替换为哈希，结构键不含探针）。
function scanCopyForSecrets(copyPath: string): void {
  const db = new DatabaseSync(copyPath, { readOnly: true });
  try {
    for (const { name } of db
      .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[]) {
      const stmt = db.prepare(`SELECT * FROM "${name}"`);
      stmt.setReadBigInts(true);
      assertNoSecrets(
        JSON.stringify(stmt.all(), (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
        `副本表 ${name}`
      );
    }
  } finally {
    db.close();
  }
}

function readMeta(copyPath: string): { drill: { runs: number; applied: boolean }; source_sha256: string } {
  return JSON.parse(readFileSync(`${copyPath}.meta.json`, "utf8"));
}

function sampleHashesOf(stats: { tables: Record<string, { sample_hashes: Record<string, string> }> }): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const [table, ts] of Object.entries(stats.tables)) out[table] = ts.sample_hashes;
  return out;
}

test("inspect：典型旧库 §1 统计齐全、报告与源库均不含正文", async () => {
  const dir = mkdtempSync(join(tmpdir(), "p7-inspect-"));
  try {
    const source = buildSourceFile(dir, "old.sqlite", "0010_memory_weight_dimensions", true);
    const shaBefore = sha256File(source);
    const reportPath = join(dir, "inspect.json");
    const code = await runInspect(source, reportPath);
    assert.strictEqual(code, 0, "形状一致时 inspect 退出码 0");

    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    assert.strictEqual(report.source.unchanged, true, "源库文件哈希前后一致");
    assert.strictEqual(report.source.sha256_before, report.source.sha256_after);
    assert.deepStrictEqual(report.source.counts_before, report.source.counts_after);
    assert.strictEqual(sha256File(source), shaBefore, "inspect 全程源文件字节不变");
    assertNoSecrets(readFileSync(reportPath, "utf8"), "inspect 报告");

    const shape = report.inspection.migration_shape;
    assert.strictEqual(shape.shape_ok, true);
    assert.deepStrictEqual(shape.applied_migrations, SECTION_ORDER.map((n) => `${n}.sql`));
    assert.ok(shape.e_axis.every((e: { present: boolean }) => e.present === false), "E 轴旧库应缺失");

    // 逐表计数
    assert.strictEqual(report.inspection.tables.memories.rows, 7);
    assert.strictEqual(report.inspection.tables.daily_log.rows, 3);
    assert.strictEqual(report.inspection.tables.usage_logs.rows, 1);

    // role_scope 分布与映射统计（§1：映射的输入）
    const memStats = report.map_stats.memories as Array<Record<string, unknown>>;
    assert.strictEqual(memStats.length, 6, "memories (ns, scope) 组合数");
    const byScope = new Map(memStats.map((m) => [m.role_scope, m]));
    assert.strictEqual((byScope.get("id:sol") as { to_namespace: string; rows: number }).to_namespace, "sol");
    assert.strictEqual((byScope.get("id:sol") as { rows: number }).rows, 2);
    assert.strictEqual((byScope.get("name:Alice") as { to_namespace: string }).to_namespace, "Alice");
    assert.strictEqual((byScope.get("shared") as { to_namespace: string }).to_namespace, "shared");
    assert.strictEqual((byScope.get("id:ke") as { to_namespace: string }).to_namespace, "ke");

    // 未知 scope 只进报告
    const unknown = report.unknown_scope_pairs.memories as Array<{ role_scope: string; rows: number }>;
    assert.deepStrictEqual(
      unknown.map((u) => u.role_scope).sort(),
      ["id:", "legacy-direct"]
    );

    // 四维/weight 只报告不修
    assert.strictEqual(report.inspection.four_dims.dimensions.find((d: { column: string }) => d.column === "importance").out_of_range, 1);
    assert.strictEqual(report.inspection.four_dims.dimensions.find((d: { column: string }) => d.column === "importance").max, 1.5);
    assert.strictEqual(report.inspection.weight.gt_1, 1);
    assert.strictEqual(report.inspection.weight.formula_mismatch, 1, "m4 的 weight 与公式不一致要报出来");

    // affect_chord / 版本链 / 孤儿
    assert.strictEqual(report.inspection.affect_chord.chord_non_null, 1);
    assert.strictEqual(report.inspection.version_chain.memories_superseded_rows, 1);
    assert.strictEqual(report.inspection.version_chain.lifecycle_orphan_rows, 1);
    assert.strictEqual(report.inspection.version_chain.fact_key_non_null, 3);
    assert.strictEqual(report.inspection.version_chain.superseded_by_non_null, 1);
    assert.strictEqual(report.inspection.memory_events.orphan_rows, 1);

    // role-less 表 distinct namespace（开放项 #1 裁定依据）
    assert.deepStrictEqual(Object.keys(report.inspection.role_less_namespaces.digest).sort(), ["ns-ke", "ns-sol"]);

    // 消息/对话归属（开放项 #2 裁定依据）
    assert.strictEqual(report.inspection.messages.role_id_non_null, 1);
    assert.strictEqual(report.inspection.conversations.role_id_non_null, 1);

    // PK 冲突（计划口径）
    assert.strictEqual(report.conflicts.daily_log.length, 1);
    assert.strictEqual(report.conflicts.daily_log[0].new_key, "(namespace='sol', date='2026-01-01')");
    assert.strictEqual(report.conflicts.daily_log[0].groups.length, 2);
    assert.strictEqual(report.conflicts.long_term_baselines.length, 1);
    assert.strictEqual(report.conflicts.long_term_baselines[0].new_key, "(namespace='sol')");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rehearse：典型旧库映射演练、审计与冲突清单", async () => {
  const dir = mkdtempSync(join(tmpdir(), "p7-rehearse-"));
  try {
    const source = buildSourceFile(dir, "old.sqlite", "0010_memory_weight_dimensions", true);
    const copy = join(dir, "copy.sqlite");
    const result = await runRehearse(rehearseOpts(source, copy));
    assert.strictEqual(result.status, "ok");
    const report = result.report;

    // 副本：映射后 namespace
    const db = new DatabaseSync(copy, { readOnly: true });
    try {
      const ns = (id: string) => (db.prepare("SELECT namespace FROM memories WHERE id = ?").get(id) as { namespace: string }).namespace;
      assert.strictEqual(ns("m1"), "sol", "id:sol -> sol");
      assert.strictEqual(ns("m2"), "Alice", "name:Alice -> Alice（去前缀，不再归一）");
      assert.strictEqual(ns("m3"), "shared");
      assert.strictEqual(ns("m4"), "ke");
      assert.strictEqual(ns("m5"), "ns-weird", "未知 scope 原样保留");
      assert.strictEqual(ns("m6"), "ns-emp", "空 id 原样保留");
      assert.strictEqual(ns("m7"), "sol");

      const lns = (mid: string) =>
        (db.prepare("SELECT namespace FROM memory_lifecycle WHERE memory_id = ?").get(mid) as { namespace: string }).namespace;
      assert.strictEqual(lns("m1"), "sol", "lifecycle 跟随 memories");
      assert.strictEqual(lns("orphan-x"), "ns-orphan", "孤儿侧车保留原 namespace");

      const ens = (id: string) =>
        (db.prepare("SELECT namespace FROM memory_events WHERE id = ?").get(id) as { namespace: string }).namespace;
      assert.strictEqual(ens("e1"), "sol", "事件跟随 memories");
      assert.strictEqual(ens("e2"), "ns-orphan", "孤儿事件保留原 namespace（manifest §3.7）");

      const dlns = db.prepare("SELECT namespace, date, affect_chord FROM daily_log ORDER BY date, namespace").all() as Array<{ namespace: string; date: string; affect_chord: string | null }>;
      const byDate = new Map(dlns.map((r) => [r.date, r.namespace]));
      assert.strictEqual(byDate.get("2026-01-02"), "sol", "无冲突行映射到 sol");
      assert.ok(
        ["ns-a", "ns-b"].every((ns) => dlns.some((r) => r.namespace === ns && r.date === "2026-01-01")),
        "撞行参与者原样保留旧 namespace（等裁定）"
      );
      const chord = dlns.find((r) => r.affect_chord !== null);
      assert.notStrictEqual(chord?.affect_chord, "Fmaj9 -> C -> Am", "副本不得保留真实和弦文本");
      assert.strictEqual(chord?.affect_chord, expectedMask("Fmaj9 -> C -> Am"), "affect_chord = 确定性掩码（同值同掩码）");

      const bl = db.prepare("SELECT namespace, role_scope FROM long_term_baselines ORDER BY namespace").all() as Array<{ namespace: string; role_scope: string }>;
      assert.deepStrictEqual(bl.map((r) => `${r.namespace}:${r.role_scope}`).sort(), ["Alice:name:Alice", "ns-a:id:sol", "ns-b:id:sol"], "baseline 撞行保留、name 行映射");

      // 开放项 #1/#2：role-less 与消息/对话一律不动
      assert.deepStrictEqual(Object.keys(db.prepare("SELECT DISTINCT namespace FROM digest ORDER BY 1").all() as Array<{ namespace: string }>).length, 2);
      const digestNs = (db.prepare("SELECT namespace FROM digest ORDER BY namespace").all() as Array<{ namespace: string }>).map((r) => r.namespace);
      assert.deepStrictEqual(digestNs, ["ns-ke", "ns-sol"], "role-less 表 namespace 不动（待裁定）");
      const msgNs = (db.prepare("SELECT namespace FROM messages ORDER BY id").all() as Array<{ namespace: string }>).map((r) => r.namespace);
      assert.deepStrictEqual(msgNs, ["ns-sol", "ns-plain"], "messages namespace 不动（开放项 #2）");

      // 保真：超界四维与 weight 原样（只报告不修）
      const m4 = db.prepare("SELECT importance, emotional, recurrence, unresolved, weight FROM memories WHERE id = 'm4'").get() as Record<string, number>;
      assert.deepStrictEqual({ ...m4 }, { importance: 1.5, emotional: 1.2, recurrence: 0.9, unresolved: 0.7, weight: 1.75 });

      // 软删除值域原样（node:sqlite 行是 null-prototype，过一道 JSON 归一）
      const precious = JSON.parse(
        JSON.stringify(db.prepare("SELECT status, COUNT(*) AS c FROM precious GROUP BY status ORDER BY status").all())
      );
      assert.deepStrictEqual(precious, [
        { status: "active", c: 1 },
        { status: "deleted", c: 1 }
      ]);
    } finally {
      db.close();
    }

    // 审计与保真结论：撞行参与者的 mismatch 数应精确等于等裁定行数
    assert.ok(
      report.audit.scope_tables.every((a) => a.mismatches === a.awaiting_ruling),
      "scope 映射审计：除等裁定行外零偏差"
    );
    assert.strictEqual(report.conflicts.awaiting_ruling_rows.daily_log, 2);
    assert.strictEqual(report.conflicts.awaiting_ruling_rows.long_term_baselines, 2);
    assert.ok(report.audit.follow_tables.every((a) => a.mismatches === 0), "跟随审计全过");
    assert.strictEqual(report.fidelity.findings.length, 0, "保真检查零发现");
    assert.ok(Object.values(report.fidelity.rows_equal).every(Boolean), "逐表行数前后一致");
    assert.ok(Object.values(report.fidelity.sample_hashes_equal).every(Boolean), "抽样哈希前后一致");
    assert.strictEqual(report.fidelity.four_dims_equal, true);
    assert.strictEqual(report.fidelity.weight_equal, true);
    assert.strictEqual(report.fidelity.chord_equal, true);

    // 冲突清单只报告 + 迁移后口径一致
    assert.strictEqual(report.conflicts.daily_log.length, 1);
    assert.strictEqual(report.conflicts.long_term_baselines.length, 1);
    assert.strictEqual(report.conflicts.keys_consistent, true);

    // 源库只读
    assert.strictEqual(report.source.unchanged, true);
    assert.deepStrictEqual(report.source.counts_before, report.source.counts_after);

    // 副本行数 == 源库行数（无重复复制/无丢失）
    assert.deepStrictEqual(tableCounts(copy), tableCounts(source));

    // 报告携带敏感文件标注
    assert.match(report.sensitivity_note, /本地敏感文件/);

    // 构建抽样全过 + 报告/meta/**副本本体**均无正文（SECRET_ 探针）
    assert.ok(report.copy.build_sample_check.every((c) => c.structuralHashMatch && c.maskedContentMatch));
    scanCopyForSecrets(copy);
    assertNoSecrets(JSON.stringify(report), "rehearse 报告");
    assertNoSecrets(readFileSync(`${copy}.meta.json`, "utf8"), "溯源 meta");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rehearse：identity 白名单审计（--allow）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "p7-allow-"));
  try {
    const source = buildSourceFile(dir, "old.sqlite", "0010_memory_weight_dimensions", true);
    const copy = join(dir, "copy.sqlite");
    const narrow = await runRehearse(rehearseOpts(source, copy, { allowNamespaces: ["sol", "ke"] }));
    assert.strictEqual(narrow.status, "ok");
    const violations = narrow.report.audit.allowlist?.violations ?? [];
    assert.deepStrictEqual(
      violations.map((v) => `${v.table}:${v.count}`).sort(),
      ["long_term_baseline_snapshots:1", "long_term_baselines:1", "memories:1"],
      "Alice 映射行落在白名单外要逐表报告"
    );

    const wide = await runRehearse(
      rehearseOpts(source, join(dir, "copy2.sqlite"), { allowNamespaces: ["sol", "ke", "Alice"] })
    );
    assert.strictEqual(wide.status, "ok");
    assert.deepStrictEqual(wide.report.audit.allowlist?.violations, [], "白名单齐备时零违规");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rehearse：同一副本重复演练——不重复复制、计数不变、结果一致", async () => {
  const dir = mkdtempSync(join(tmpdir(), "p7-repeat-"));
  try {
    const source = buildSourceFile(dir, "old.sqlite", "0010_memory_weight_dimensions", true);
    const copy = join(dir, "copy.sqlite");
    const first = await runRehearse(rehearseOpts(source, copy));
    assert.strictEqual(first.status, "ok");
    assert.strictEqual(first.report.copy.built, true, "首轮新建副本");
    assert.strictEqual(first.report.copy.reused, false);

    const shaAfterFirst = sha256File(copy);
    const second = await runRehearse(rehearseOpts(source, copy));
    assert.strictEqual(second.status, "ok");
    assert.strictEqual(second.report.copy.reused, true, "第二轮不重复复制");
    assert.strictEqual(second.report.copy.built, false);
    assert.strictEqual(second.report.copy.state_match, "post", "识别为已演练状态");
    assert.strictEqual(second.report.copy.post_matches_previous, true, "与上一轮结果一致");
    assert.strictEqual(sha256File(copy), shaAfterFirst, "第二轮副本字节不变");
    assert.deepStrictEqual(second.report.fidelity.findings, []);
    assert.strictEqual(
      JSON.stringify(sampleHashesOf(second.report.copy_post)),
      JSON.stringify(sampleHashesOf(first.report.copy_post)),
      "两轮抽样哈希一致"
    );
    assert.strictEqual(readMeta(copy).drill.runs, 2);
    const cdb = new DatabaseSync(copy, { readOnly: true });
    try {
      const chord2 = (
        cdb.prepare("SELECT affect_chord FROM daily_log WHERE affect_chord IS NOT NULL").get() as {
          affect_chord: string;
        }
      ).affect_chord;
      assert.strictEqual(chord2, expectedMask("Fmaj9 -> C -> Am"), "确定性掩码值在重复演练中保持一致");
    } finally {
      cdb.close();
    }

    // 第三轮强制重建：结果与首轮一致（可复现）
    const third = await runRehearse(rehearseOpts(source, copy, { forceRebuild: true }));
    assert.strictEqual(third.status, "ok");
    assert.strictEqual(third.report.copy.built, true, "force-rebuild 重建副本");
    assert.strictEqual(third.report.copy.state_match, "fresh");
    assert.deepStrictEqual(third.report.mapping.map_stats, first.report.mapping.map_stats);
    assert.deepStrictEqual(third.report.conflicts.daily_log, first.report.conflicts.daily_log);
    assert.strictEqual(readMeta(copy).drill.runs, 1, "重建后演练计数重新从 1 开始");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rehearse：空库（schema 齐全、零行）可演练", async () => {
  const dir = mkdtempSync(join(tmpdir(), "p7-empty-"));
  try {
    const source = buildSourceFile(dir, "old.sqlite", "0010_memory_weight_dimensions", false);
    const copy = join(dir, "copy.sqlite");
    const result = await runRehearse(rehearseOpts(source, copy));
    assert.strictEqual(result.status, "ok");
    const report = result.report;
    assert.strictEqual(report.conflicts.daily_log.length, 0);
    assert.strictEqual(report.conflicts.long_term_baselines.length, 0);
    assert.strictEqual(report.fidelity.findings.length, 0);
    assert.deepStrictEqual(tableCounts(copy), tableCounts(source));
    for (const [table, count] of Object.entries(tableCounts(source))) {
      if (table === "d1_migrations") {
        assert.strictEqual(count, 10, "迁移账本本身有 10 条记录");
        continue;
      }
      assert.strictEqual(count, 0, `${table} 应为空`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rehearse：形状偏离拒绝演练（pre-0006 / pre-0010）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "p7-deviation-"));
  try {
    // 少迁移（pre-0006：缺 role 列与 baseline 表）
    const oldShape = buildSourceFile(dir, "pre6.sqlite", "0005_memory_candidates", false);
    const copyA = join(dir, "copy-a.sqlite");
    const refused = await runRehearse(rehearseOpts(oldShape, copyA));
    assert.strictEqual(refused.status, "refused");
    assert.match(refused.reason, /缺表|形状与旧分支/);
    assert.strictEqual(existsSync(copyA), false, "拒绝时不建副本");

    const inspectPath = join(dir, "pre6-inspect.json");
    const code = await runInspect(oldShape, inspectPath);
    assert.strictEqual(code, 1, "inspect 遇形状偏离退出码 1，但报告照常产出");
    const report = JSON.parse(readFileSync(inspectPath, "utf8"));
    assert.strictEqual(report.inspection.migration_shape.shape_ok, false);
    assert.ok(report.inspection.migration_shape.deviations.missing_tables.includes("long_term_baselines"));

    // 缺列（pre-0010：无四维列）
    const pre10 = buildSourceFile(dir, "pre10.sqlite", "0009_daily_log_affect_chord", false);
    const refused2 = await runRehearse(rehearseOpts(pre10, join(dir, "copy-b.sqlite")));
    assert.strictEqual(refused2.status, "refused");
    assert.match(refused2.reason, /缺列/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rehearse：SQL 导出源（内存还原，磁盘源文件只读）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "p7-dump-"));
  try {
    const source = buildSourceFile(dir, "old.sqlite", "0010_memory_weight_dimensions", true);
    // 生成一个"像 wrangler d1 export"的转储：schema + 全量数据行。
    const db = new DatabaseSync(source, { readOnly: true });
    const lines: string[] = ["PRAGMA defer_foreign_keys=TRUE;"];
    for (const { name, sql } of db
      .prepare(
        "SELECT name, sql FROM sqlite_schema WHERE type='table' AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY name"
      )
      .all() as Array<{ name: string; sql: string }>) {
      lines.push(`${sql};`);
      const cols = (db.prepare(`PRAGMA table_info("${name}")`).all() as Array<{ name: string }>).map((c) => c.name);
      if (cols.length === 0) continue;
      const insert = db.prepare(`SELECT ${cols.map((c) => `"${c}"`).join(", ")} FROM "${name}"`);
      insert.setReadBigInts(true);
      const lit = (v: unknown): string =>
        v === null ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`;
      for (const row of insert.all() as Array<Record<string, unknown>>) {
        lines.push(`INSERT INTO "${name}" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map((c) => lit(row[c])).join(", ")});`);
      }
    }
    db.close();
    const dump = join(dir, "old-export.sql");
    writeFileSync(dump, `${lines.join("\n")}\n`, "utf8");

    const copy = join(dir, "copy.sqlite");
    const shaBefore = sha256File(dump);
    const result = await runRehearse(rehearseOpts(dump, copy));
    assert.strictEqual(result.status, "ok");
    assert.strictEqual(result.report.source.kind, "sql-dump");
    assert.strictEqual(result.report.source.unchanged, true, "SQL 导出文件全程只读");
    assert.strictEqual(sha256File(dump), shaBefore);
    assert.strictEqual(result.report.conflicts.daily_log.length, 1, "dump 源同样产出冲突清单");
    const cdb = new DatabaseSync(copy, { readOnly: true });
    try {
      const ns = (cdb.prepare("SELECT namespace FROM memories WHERE id = 'm1'").get() as { namespace: string }).namespace;
      assert.strictEqual(ns, "sol");
    } finally {
      cdb.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rehearse：源/副本路径保护——同文件、无溯源、源已变化", async () => {
  const dir = mkdtempSync(join(tmpdir(), "p7-guard-"));
  try {
    const source = buildSourceFile(dir, "old.sqlite", "0010_memory_weight_dimensions", true);

    const same = await runRehearse(rehearseOpts(source, source));
    assert.strictEqual(same.status, "refused", "source 与 copy 同文件拒绝");

    const orphanCopy = join(dir, "stray.sqlite");
    const db = new DatabaseSync(orphanCopy);
    db.exec("CREATE TABLE t (a)");
    db.close();
    const noMeta = await runRehearse(rehearseOpts(source, orphanCopy));
    assert.strictEqual(noMeta.status, "refused");
    assert.match(noMeta.reason, /溯源/);

    const copy = join(dir, "copy.sqlite");
    const ok = await runRehearse(rehearseOpts(source, copy));
    assert.strictEqual(ok.status, "ok");

    // 源文件在演练后被外部改动 → sha256 不匹配 → 拒绝（不猜、不覆盖）
    const mutate = new DatabaseSync(source);
    mutate.exec("INSERT INTO memories (id, namespace, type, content, importance, status, role_scope, emotional, recurrence, unresolved, weight, created_at, updated_at) VALUES ('m8', 'x', 'fact', 'later', 0.5, 'active', 'shared', 0, 0, 0, 0.175, '2026-01-02', '2026-01-02')");
    mutate.close();
    const changed = await runRehearse(rehearseOpts(source, copy));
    assert.strictEqual(changed.status, "refused");
    assert.match(changed.reason, /sha256/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rehearse：映射统计覆盖 id/name/shared 三类与跟随表计数", async () => {
  const dir = mkdtempSync(join(tmpdir(), "p7-mapstats-"));
  try {
    const source = buildSourceFile(dir, "old.sqlite", "0010_memory_weight_dimensions", true);
    const copy = join(dir, "copy.sqlite");
    const result = await runRehearse(rehearseOpts(source, copy));
    assert.strictEqual(result.status, "ok");
    const { map_stats, follow_memory, unknown_scope_pairs } = result.report.mapping;
    const memKinds = new Map(
      (map_stats.memories as Array<{ scope_kind: string; to_namespace: string; rows: number }>).map((m) => [m.to_namespace, m])
    );
    assert.strictEqual(memKinds.get("sol")?.scope_kind, "id");
    assert.strictEqual(memKinds.get("Alice")?.scope_kind, "name");
    assert.strictEqual(memKinds.get("shared")?.scope_kind, "shared");
    const lifecycle = follow_memory.find((f) => f.table === "memory_lifecycle");
    assert.strictEqual(lifecycle?.followed, 2, "lifecycle 跟随 memories 的行数");
    assert.strictEqual(lifecycle?.kept_original, 1, "孤儿侧车保留原 namespace 的行数");
    const events = follow_memory.find((f) => f.table === "memory_events");
    assert.strictEqual(events?.followed, 1);
    assert.strictEqual(events?.kept_original, 1);
    assert.strictEqual((unknown_scope_pairs.memories as unknown[]).length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI：参数解析与默认 dry-run", () => {
  assert.throws(() => parseArgs([]), /--source/, "缺 source 报用法");
  const inspect = parseArgs(["--source", "x"]);
  assert.strictEqual(inspect.subcommand, "inspect", "只有 flag 时默认子命令 = inspect（dry-run）");
  assert.strictEqual(inspect.source, "x");
  const noCopy = parseArgs(["rehearse", "--source", "x"]);
  assert.strictEqual(noCopy.subcommand, "rehearse");
  assert.strictEqual(noCopy.copy, null, "--copy 缺省为 null（CLI 层默认 .migration-work/）");
  assert.throws(() => parseArgs(["--source", "x", "--bogus"]), /未知参数/);
  const rehearse = parseArgs([
    "rehearse",
    "--source",
    "a.sqlite",
    "--copy",
    "b.sqlite",
    "--allow",
    " sol , ke ,",
    "--force-rebuild"
  ]);
  assert.strictEqual(rehearse.subcommand, "rehearse");
  assert.deepStrictEqual(rehearse.allow, ["sol", "ke"], "allow 清单 trim 且去空");
  assert.strictEqual(rehearse.forceRebuild, true);
});
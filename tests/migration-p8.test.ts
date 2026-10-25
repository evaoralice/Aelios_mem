import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { runP8Upgrade } from "../scripts/migration/p8";
import type { P8UpgradeReport } from "../scripts/migration/p8";
import { LEDGER_BOOTSTRAP, P8_SQL_FILES } from "../scripts/migration/p8";
import { parseArgs } from "../scripts/migration-p8";

// P8 正式迁移验收（P0 迁移验收清单 §3/§4 + 2026-10-24 实库裁定）：
//   1. 成功路径：合成旧库按线上真实顺序升级（账本引导 + 0006–0017 + 0021–0025），
//      逐表计数 / 保真哈希 / namespace 行级归属 / 回填列 / 目标结构 / 账本全过；
//   2. 裁定落法：role-less→shared、summaries→shared、孤儿侧车不迁入、
//      超界 importance 与公式不一致 weight 原样、E 轴 NULL、游标清空、
//      memory_changelog 删除、role 列收尾清除；
//   3. 拒绝路径：PK 冲突 / 未知 scope / digest 多 namespace → 预检拒绝零写入；
//   4. 失败路径：P8 文件中途失败 → 单文件回滚、整体 failed、无半迁移成功态；
//   5. 重复演练：--force 重建后验收结果一致；同路径无 --force 拒绝；
//   6. SQL 导出源（wrangler d1 export 形状）与 CLI 参数。
// fixture DDL 逐字取自旧分支 fix/logic-review 0001–0010（与线上
// feat/memory-dimensions 逐字一致）；数据全合成。

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

const TS = "2026-01-01T00:00:00.000Z";

// 旧库迁移账本（真实 d1_migrations 形状：id/name/applied_at）
function applyOldSchema(db: DatabaseSync): void {
  for (const name of SECTION_ORDER) {
    const section = SCHEMA_SECTIONS.find((s) => s.name === name);
    assert.ok(section, `fixture 缺少 ${name}`);
    db.exec(section.sql);
  }
  db.exec(
    "CREATE TABLE IF NOT EXISTS d1_migrations(\n\t\tid INTEGER PRIMARY KEY AUTOINCREMENT,\n\t\tname TEXT UNIQUE,\n\t\tapplied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL\n)"
  );
  const insert = db.prepare("INSERT INTO d1_migrations (name) VALUES (?)");
  for (const name of SECTION_ORDER) insert.run(`${name}.sql`);
}

// 成功路径种子（无冲突、无未知 scope、digest 单 namespace、changelog 值域内）。
function seedSuccess(db: DatabaseSync): void {
  const mem = db.prepare(
    `INSERT INTO memories (id, namespace, type, content, summary, importance, confidence, status, tags,
       created_at, updated_at, role_id, role_name, role_scope, emotional, recurrence, unresolved, weight)
     VALUES (?, ?, 'fact', ?, NULL, ?, 0.8, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  mem.run("m1", "ns-sol", "SECRET_MEMO_SOL_A", 0.5, "active", TS, TS, "sol", "Sol", "id:sol", 0.2, 0.1, 0, 0.2);
  mem.run("m2", "ns-name", "SECRET_MEMO_NAME_B", 0.6, "active", TS, TS, null, "Alice", "name:Alice", 0, 0, 0, 0.21);
  mem.run("m3", "ns-shared", "SECRET_MEMO_SHARED_C", 0.5, "active", TS, TS, null, null, "shared", 0, 0, 0, 0.175);
  mem.run("m4", "ns-ke", "SECRET_MEMO_OOR_D", 1.5, "active", TS, TS, "ke", "Ke", "id:ke", 1.2, 0.9, 0.7, 1.75); // 超界 + 公式不一致：原样保留
  mem.run("m5", "ns-sol", "SECRET_MEMO_SUP_E", 0.5, "superseded", TS, TS, "sol", "Sol", "id:sol", 0, 0, 0, 0.175);

  const lc = db.prepare(
    `INSERT INTO memory_lifecycle (memory_id, namespace, fact_key, supersedes_id, superseded_by_id, seen_count, role_scope)
     VALUES (?, ?, ?, ?, ?, 0, ?)`
  );
  lc.run("m1", "ns-sol", "SECRET_FK_M1", null, "m5", "id:sol");
  lc.run("m5", "ns-sol", "SECRET_FK_M5", "m1", null, "id:sol");
  lc.run("orphan-x", "ns-orphan", "SECRET_FK_ORPHAN", null, null, "id:sol"); // 孤儿侧车：只入报告

  const dl = db.prepare(
    `INSERT INTO daily_log (namespace, role_scope, date, title, summary, updated_at, affect_chord)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  dl.run("ns-a", "id:sol", "2026-01-01", "SECRET_TITLE_1", "SECRET_SUMMARY_1", TS, "Fmaj9 -> C -> Am");
  dl.run("ns-a", "id:sol", "2026-01-02", "SECRET_TITLE_2", "SECRET_SUMMARY_2", TS, null);
  dl.run("ns-s", "shared", "2026-01-01", "SECRET_TITLE_3", "SECRET_SUMMARY_3", TS, null);

  db.exec(
    `INSERT INTO long_term_baselines (namespace, role_scope, content, version, generated_at) VALUES
       ('ns-a', 'id:sol', 'SECRET_BASELINE_A', 1, '${TS}'),
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

  db.exec(`INSERT INTO digest (namespace, content, updated_at) VALUES ('ns-sol', 'SECRET_DIGEST_1', '${TS}')`);
  db.exec(
    `INSERT INTO precious (id, namespace, content, source, pinned, created_at, status) VALUES
       ('p1', 'ns-sol', 'SECRET_PRECIOUS_1', 'human', 1, '${TS}', 'active'),
       ('p2', 'ns-sol', 'SECRET_PRECIOUS_2', 'human', 1, '${TS}', 'deleted')`
  );
  db.exec(
    `INSERT INTO glossary (id, namespace, term, aliases, definition, examples, status, updated_at, seen_count) VALUES
       ('g1', 'ns-sol', 'SECRET_TERM', '[]', 'SECRET_DEF', '[]', 'active', '${TS}', 0)`
  );
  db.exec(`INSERT INTO longtail (id, namespace, content, ts) VALUES ('lt1', 'ns-sol', 'SECRET_LONGTAIL_1', '${TS}')`);
  db.exec(
    `INSERT INTO memory_candidates (id, namespace, type, content, fact_key, source, status, created_at, updated_at) VALUES
       ('mc1', 'ns-sol', 'note', 'SECRET_CAND_1', 'SECRET_FK_CAND', 'extract', 'pending', '${TS}', '${TS}')`
  );

  db.exec(
    `INSERT INTO messages (id, conversation_id, namespace, role, content, client_message_hash, created_at, role_id, role_name) VALUES
       ('msg1', 'conv1', 'ns-sol', 'user', 'SECRET_CHAT_1', 'hash-old-1', '${TS}', 'sol', 'Sol'),
       ('msg2', 'conv1', 'ns-sol', 'assistant', 'SECRET_CHAT_2', 'hash-old-2', '${TS}', 'sol', 'Sol'),
       ('msg3', 'conv2', 'ns-plain', 'assistant', 'SECRET_CHAT_3', NULL, '${TS}', NULL, NULL)`
  );
  db.exec(
    `INSERT INTO conversations (id, namespace, title, created_at, updated_at, role_id, role_name) VALUES
       ('conv1', 'ns-sol', 'SECRET_CONV_TITLE', '${TS}', '${TS}', 'sol', 'Sol'),
       ('conv2', 'ns-plain', NULL, '${TS}', '${TS}', NULL, NULL)`
  );
  db.exec(
    `INSERT INTO usage_logs (id, message_id, namespace, provider, model, input_tokens, output_tokens, raw_usage_json, created_at, client_system_hash) VALUES
       ('u1', 'msg1', 'ns-sol', 'anthropic', 'model-x', 10, 20, 'SECRET_USAGE_JSON', '${TS}', 'sys-hash-1'),
       ('u2', 'msg2', 'ns-sol', 'anthropic', 'model-x', 30, 40, 'SECRET_USAGE_JSON_2', '${TS}', NULL)`
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
    `INSERT INTO processing_cursors (name, value, updated_at) VALUES
       ('cursor-1', 'SECRET_CURSOR_VALUE_1', '${TS}'),
       ('cursor-2', 'SECRET_CURSOR_VALUE_2', '${TS}')`
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

function buildSourceFile(dir: string, name: string, seed: boolean, seedFn: (db: DatabaseSync) => void = seedSuccess): string {
  const path = join(dir, name);
  const db = new DatabaseSync(path);
  applyOldSchema(db);
  if (seed) seedFn(db);
  db.close();
  return path;
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function opts(source: string, copy: string, extra: Partial<Parameters<typeof runP8Upgrade>[0]> = {}) {
  return { sourcePath: source, copyPath: copy, ...extra };
}

function assertNoSecrets(text: string, label: string): void {
  const hits = text.match(/SECRET_[A-Z0-9_]+/g);
  assert.strictEqual(hits, null, `${label} 不得包含正文（探针命中: ${hits?.slice(0, 5).join(", ")}）`);
}

function colNames(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}

test("P8 成功路径：真实升级顺序 + 逐表验收 + 裁定落法", async () => {
  const dir = mkdtempSync(join(tmpdir(), "p8-ok-"));
  try {
    const source = buildSourceFile(dir, "old.sqlite", true);
    const copy = join(dir, "upgrade.sqlite");
    const shaBefore = sha256File(source);
    const result = await runP8Upgrade(opts(source, copy));
    assert.strictEqual(result.status, "ok");
    const report = result.report;
    assert.strictEqual(report.status, "upgraded", `验收须全过，findings: ${report.fidelity.findings.join("；")}`);
    assert.strictEqual(report.fidelity.findings.length, 0);
    assert.strictEqual(report.source.unchanged, true, "源库全程只读（sha256）");
    assert.deepStrictEqual(report.source.counts_before, report.source.counts_after);
    assert.strictEqual(sha256File(source), shaBefore);

    // —— 升级顺序（线上真实路径）——
    assert.deepStrictEqual(report.upgrade.ledger_bootstrap, [...LEDGER_BOOTSTRAP]);
    assert.strictEqual(report.upgrade.migrations_applied.length, 12, "新名 0006–0017 全部应用");
    assert.ok(report.upgrade.migrations_applied.includes("0017_baselines.sql"));
    assert.ok(report.upgrade.migrations_applied.every((f) => !f.startsWith("0018") && !f.startsWith("0019") && !f.startsWith("0020")), "0018–0020 必须被账本引导跳过");
    assert.strictEqual(report.upgrade.migrations_skipped_same_name.length, 5, "0001–0005 与旧账本同名跳过");
    assert.deepStrictEqual(report.upgrade.p8_files_applied, [...P8_SQL_FILES]);

    // —— 账本终态：旧 10 + 引导 3 + 新 12 + P8 5 = 30 ——
    assert.strictEqual(report.ledger_final.length, 30);
    assert.deepStrictEqual(report.ledger_final, report.ledger_expected);

    const db = new DatabaseSync(copy, { readOnly: true });
    try {
      // memories：映射 / 回填 / E 轴 / 超界原样
      const ns = (id: string) => (db.prepare("SELECT namespace FROM memories WHERE id = ?").get(id) as { namespace: string }).namespace;
      assert.strictEqual(ns("m1"), "sol");
      assert.strictEqual(ns("m2"), "Alice");
      assert.strictEqual(ns("m3"), "shared");
      assert.strictEqual(ns("m4"), "ke");
      assert.strictEqual(ns("m5"), "sol");
      const m4 = db.prepare("SELECT importance, emotional, recurrence, unresolved, weight FROM memories WHERE id = 'm4'").get() as Record<string, number>;
      assert.deepStrictEqual({ ...m4 }, { importance: 1.5, emotional: 1.2, recurrence: 0.9, unresolved: 0.7, weight: 1.75 }, "超界值与公式不一致 weight 原样保留");
      const m1 = db.prepare("SELECT fact_key, superseded_by, version_status, authored_by, response_tendency FROM memories WHERE id = 'm1'").get() as Record<string, unknown>;
      assert.strictEqual(m1.fact_key, "SECRET_FK_M1", "fact_key 由 0007 回填");
      assert.strictEqual(m1.superseded_by, "m5", "superseded_by 由 0021 回填（0007 不做）");
      assert.strictEqual(m1.version_status, "current");
      assert.strictEqual(m1.authored_by, null, "E 轴不伪造");
      assert.strictEqual(m1.response_tendency, null);
      const m5 = db.prepare("SELECT version_status FROM memories WHERE id = 'm5'").get() as { version_status: string };
      assert.strictEqual(m5.version_status, "superseded", "superseded 行版本态对齐 0007");

      // lifecycle：跟随 + 孤儿删除
      const lcRows = db.prepare("SELECT memory_id, namespace FROM memory_lifecycle ORDER BY memory_id").all() as Array<{ memory_id: string; namespace: string }>;
      assert.deepStrictEqual(lcRows.map((r) => `${r.memory_id}:${r.namespace}`), ["m1:sol", "m5:sol"], "孤儿侧车不迁入目标");
      assert.deepStrictEqual(report.fidelity.lifecycle.orphan_memory_ids, ["orphan-x"]);
      assert.strictEqual(report.fidelity.lifecycle.orphan_rows_pre, 1);
      assert.strictEqual(report.fidelity.lifecycle.orphan_rows_post, 0);

      // memory_events：跟随 / 孤儿事件保留原 namespace
      const e2 = db.prepare("SELECT namespace FROM memory_events WHERE id = 'e2'").get() as { namespace: string };
      assert.strictEqual(e2.namespace, "ns-orphan");
      const e1 = db.prepare("SELECT namespace FROM memory_events WHERE id = 'e1'").get() as { namespace: string };
      assert.strictEqual(e1.namespace, "sol");

      // daily_log：重建（PK/去 role_scope）+ chord 逐字 + source_message_ids NULL
      const dl = db.prepare("SELECT namespace, date, title, affect_chord, source_message_ids FROM daily_log ORDER BY date, namespace").all() as Array<{ namespace: string; date: string; title: string; affect_chord: string | null; source_message_ids: string | null }>;
      assert.strictEqual(dl.length, 3);
      assert.deepStrictEqual(dl.map((r) => `${r.namespace}:${r.date}`), ["shared:2026-01-01", "sol:2026-01-01", "sol:2026-01-02"]);
      assert.strictEqual(dl.find((r) => r.title === "SECRET_TITLE_1")?.affect_chord, "Fmaj9 -> C -> Am", "真实数据副本不掩码，chord 逐字保留");
      assert.ok(dl.every((r) => r.source_message_ids === null));

      // baselines：重建（namespace 主键 / 无 role_scope）
      const bl = db.prepare("SELECT namespace, version, content FROM long_term_baselines ORDER BY namespace").all() as Array<{ namespace: string; content: string }>;
      assert.deepStrictEqual(bl.map((r) => `${r.namespace}:${r.content}`), ["Alice:SECRET_BASELINE_N", "sol:SECRET_BASELINE_A"]);
      const snaps = db.prepare("SELECT namespace FROM long_term_baseline_snapshots ORDER BY id").all() as Array<{ namespace: string }>;
      assert.deepStrictEqual(snaps.map((s) => s.namespace), ["sol", "Alice"]);
      const ch = JSON.parse(JSON.stringify(db.prepare("SELECT namespace, op, status FROM baseline_changelog").get())) as { namespace: string; op: string; status: string };
      assert.deepStrictEqual(ch, { namespace: "sol", op: "add", status: "pending" });

      // role-less 五表 + summaries → shared
      for (const table of ["digest", "precious", "glossary", "longtail", "memory_candidates", "summaries"]) {
        const rows = db.prepare(`SELECT DISTINCT namespace AS ns FROM ${table}`).all() as Array<{ ns: string }>;
        assert.ok(rows.every((r) => r.ns === "shared"), `${table} 应归 shared`);
      }
      const preciousStatus = db.prepare("SELECT status, COUNT(*) AS c FROM precious GROUP BY status ORDER BY status").all() as Array<{ status: string; c: number }>;
      assert.strictEqual(preciousStatus.length, 2, "软删值域 active/deleted 原样携带");

      // messages/conversations：role_id 跟随 / 无 role_id 保留；hash 置 NULL；seq 回填
      const msgNs = db.prepare("SELECT id, namespace, client_message_hash, seq FROM messages ORDER BY id").all() as Array<{ id: string; namespace: string; client_message_hash: string | null; seq: number }>;
      assert.deepStrictEqual(msgNs.map((m) => `${m.id}:${m.namespace}`), ["msg1:sol", "msg2:sol", "msg3:ns-plain"]);
      assert.ok(msgNs.every((m) => m.client_message_hash === null));
      assert.deepStrictEqual(msgNs.map((m) => m.seq), [0, 1, 1], "seq 按 role 回填（0015 语义）");
      const convNs = db.prepare("SELECT id, namespace FROM conversations ORDER BY id").all() as Array<{ id: string; namespace: string }>;
      assert.deepStrictEqual(convNs.map((c) => `${c.id}:${c.namespace}`), ["conv1:sol", "conv2:ns-plain"]);

      // 裁定：processing_cursors 清空、memory_changelog 删除、role 列全清
      assert.strictEqual((db.prepare("SELECT COUNT(*) AS c FROM processing_cursors").get() as { c: number }).c, 0);
      assert.strictEqual(
        (db.prepare("SELECT COUNT(*) AS c FROM sqlite_schema WHERE type='table' AND name='memory_changelog'").get() as { c: number }).c,
        0,
        "memory_changelog 弃置删除"
      );
      for (const table of ["memories", "messages", "conversations", "memory_lifecycle", "daily_log"]) {
        const cols = colNames(db, table);
        assert.ok(!cols.some((c) => c === "role_scope" || c === "role_id" || c === "role_name"), `${table} role 列应清除`);
      }

      // 计数落法（§4 逐表 + 裁定）
      const expectedCounts = {
        memories: 5,
        memory_lifecycle: 2,
        memory_events: 2,
        daily_log: 3,
        long_term_baselines: 2,
        long_term_baseline_snapshots: 2,
        baseline_changelog: 1,
        digest: 1,
        precious: 2,
        glossary: 1,
        longtail: 1,
        memory_candidates: 1,
        summaries: 1,
        messages: 3,
        conversations: 2,
        usage_logs: 2,
        users: 1,
        cache_entries: 1,
        idempotency_keys: 1,
        processing_cursors: 0
      };
      for (const [table, want] of Object.entries(expectedCounts)) {
        assert.strictEqual(report.counts.post[table], want, `${table} 迁移后行数`);
      }
      // usage_logs / users / cache_entries / idempotency_keys 全列原样
      assert.ok(Object.values(report.fidelity.untouched_equal).every(Boolean));
      assert.ok(Object.values(report.fidelity.carried_maps_equal).every(Boolean), "携带列逐行哈希全过");
      assert.ok(Object.values(report.fidelity.namespace_maps_equal).every(Boolean), "namespace 行级归属全过");

      // 目标结构：与全新部署逐表 parity
      assert.strictEqual(report.shape.tables_equal, true);
      assert.ok(Object.values(report.shape.columns_parity).every(Boolean), "逐表列集合/约束/PK 与全新部署一致");
      assert.strictEqual(report.shape.indexes_equal, true, "索引集合与全新部署一致");
      assert.strictEqual(report.shape.role_columns_remaining.length, 0);
    } finally {
      db.close();
    }

    // 报告不含正文；携带敏感标注
    assertNoSecrets(JSON.stringify(report), "P8 报告");
    assert.match(report.sensitivity_note, /本地敏感文件/);
    assert.ok(report.runbook.length >= 4, "线上执行手册在报告内");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P8 重复演练：--force 重建副本、验收一致；同路径无 --force 拒绝", async () => {
  const dir = mkdtempSync(join(tmpdir(), "p8-repeat-"));
  try {
    const source = buildSourceFile(dir, "old.sqlite", true);
    const copy = join(dir, "upgrade.sqlite");
    const first = await runP8Upgrade(opts(source, copy));
    assert.strictEqual(first.status, "ok");
    assert.strictEqual(first.report.status, "upgraded");

    const again = await runP8Upgrade(opts(source, copy));
    assert.strictEqual(again.status, "refused", "一次性副本不可复用");
    assert.match(again.reason, /一次性副本/);

    const second = await runP8Upgrade(opts(source, copy, { force: true }));
    assert.strictEqual(second.status, "ok");
    assert.strictEqual(second.report.status, "upgraded");
    assert.deepStrictEqual(second.report.fidelity, first.report.fidelity, "两轮验收结果一致");
    assert.deepStrictEqual(second.report.counts.post, first.report.counts.post);
    assert.deepStrictEqual(second.report.ledger_final, first.report.ledger_final);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P8 拒绝：PK 冲突 / 未知 role_scope / digest 多 namespace（预检零写入）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "p8-refuse-"));
  try {
    // daily_log 两行映射后撞 (sol, 2026-01-01)
    const conflict = buildSourceFile(dir, "conflict.sqlite", true, (db) => {
      seedSuccess(db);
      db.prepare(
        "INSERT INTO daily_log (namespace, role_scope, date, title, summary, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).run("ns-b", "id:sol", "2026-01-01", "SECRET_TITLE_X", "SECRET_SUMMARY_X", TS);
    });
    const r1 = await runP8Upgrade(opts(conflict, join(dir, "c1.sqlite")));
    assert.strictEqual(r1.status, "refused");
    assert.match(r1.reason, /主键冲突/);
    assert.strictEqual(existsSync(join(dir, "c1.sqlite")), false, "拒绝时不建副本");

    // 未知 role_scope
    const unknown = buildSourceFile(dir, "unknown.sqlite", true, (db) => {
      seedSuccess(db);
      db.prepare(
        "INSERT INTO memories (id, namespace, type, content, importance, status, role_scope, emotional, recurrence, unresolved, weight, created_at, updated_at) VALUES (?, ?, 'fact', ?, 0.5, 'active', ?, 0, 0, 0, 0.175, ?, ?)"
      ).run("m9", "ns-weird", "SECRET_MEMO_UNKNOWN", "legacy-direct", TS, TS);
    });
    const r2 = await runP8Upgrade(opts(unknown, join(dir, "c2.sqlite")));
    assert.strictEqual(r2.status, "refused");
    assert.match(r2.reason, /未知 role_scope/);

    // digest 两个 namespace → 归一会撞 PK
    const digest2 = buildSourceFile(dir, "digest2.sqlite", true, (db) => {
      seedSuccess(db);
      db.exec(`INSERT INTO digest (namespace, content, updated_at) VALUES ('ns-ke', 'SECRET_DIGEST_2', '${TS}')`);
    });
    const r3 = await runP8Upgrade(opts(digest2, join(dir, "c3.sqlite")));
    assert.strictEqual(r3.status, "refused");
    assert.match(r3.reason, /digest/);

    // 源 = 副本 路径保护
    const source = buildSourceFile(dir, "plain.sqlite", true);
    const r4 = await runP8Upgrade(opts(source, source));
    assert.strictEqual(r4.status, "refused");
    assert.match(r4.reason, /同一文件/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P8 失败路径：文件中途失败 → 单文件回滚、整体 failed、无半迁移成功态", async () => {
  const dir = mkdtempSync(join(tmpdir(), "p8-fail-"));
  try {
    const source = buildSourceFile(dir, "old.sqlite", true);
    const copy = join(dir, "upgrade.sqlite");
    // 自定义 p8 目录：同名五个文件，0024 换成坏 SQL
    const p8Dir = join(dir, "migrations-p8");
    mkdirSync(p8Dir, { recursive: true });
    for (const file of P8_SQL_FILES) {
      const from = resolve("migrations-p8", file);
      let sql = readFileSync(from, "utf8");
      if (file === "0024_p8_roleless_messages_shared.sql") {
        sql = "UPDATE nonexistent_p8 SET x = 1;";
      }
      writeFileSync(join(p8Dir, file), sql, "utf8");
    }
    const result = await runP8Upgrade(opts(source, copy, { p8Dir }));
    assert.strictEqual(result.status, "failed");
    const report = result.report;
    assert.strictEqual(report.status, "failed");
    assert.strictEqual(report.failure?.step, "migrations-p8/0024_p8_roleless_messages_shared.sql");
    assert.deepStrictEqual(report.upgrade.p8_files_applied, [...P8_SQL_FILES].slice(0, 3), "0021–0023 已提交，0024 失败中止");

    const db = new DatabaseSync(copy, { readOnly: true });
    try {
      // 0024 已整体回滚：role-less 表 namespace 仍是旧值
      const digestNs = (db.prepare("SELECT namespace FROM digest").get() as { namespace: string }).namespace;
      assert.strictEqual(digestNs, "ns-sol", "失败文件的事务回滚，不产生半迁移结果");
      // 0025 未执行：role 列还在
      assert.ok(colNames(db, "memories").includes("role_scope"), "后续文件不执行");
      // 0022 已生效：daily_log 已重建
      assert.ok(!colNames(db, "daily_log").includes("role_scope"), "之前已提交的文件保持生效");
    } finally {
      db.close();
    }
    // 溯源 meta 标记 failed
    const meta = JSON.parse(readFileSync(`${copy}.meta.json`, "utf8")) as { status: string };
    assert.strictEqual(meta.status, "failed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P8 SQL 导出源（wrangler d1 export 形状）：只读升级全过", async () => {
  const dir = mkdtempSync(join(tmpdir(), "p8-dump-"));
  try {
    const source = buildSourceFile(dir, "old.sqlite", true);
    const db = new DatabaseSync(source, { readOnly: true });
    // wrangler d1 export 形状：schema（含索引）+ 全量数据行
    const lines: string[] = ["PRAGMA defer_foreign_keys=TRUE;"];
    const schemaObjects = db
      .prepare(
        "SELECT type, name, sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND type IN ('table', 'index') ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name"
      )
      .all() as Array<{ type: string; name: string; sql: string }>;
    for (const obj of schemaObjects) {
      lines.push(`${obj.sql};`);
      if (obj.type !== "table") continue;
      const cols = (db.prepare(`PRAGMA table_info("${obj.name}")`).all() as Array<{ name: string }>).map((c) => c.name);
      if (cols.length === 0) continue;
      const insert = db.prepare(`SELECT ${cols.map((c) => `"${c}"`).join(", ")} FROM "${obj.name}"`);
      insert.setReadBigInts(true);
      const lit = (v: unknown): string =>
        v === null ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`;
      for (const row of insert.all() as Array<Record<string, unknown>>) {
        lines.push(`INSERT INTO "${obj.name}" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map((c) => lit(row[c])).join(", ")});`);
      }
    }
    db.close();
    const dump = join(dir, "old-export.sql");
    writeFileSync(dump, `${lines.join("\n")}\n`, "utf8");
    const shaBefore = sha256File(dump);

    const copy = join(dir, "upgrade.sqlite");
    const result = await runP8Upgrade(opts(dump, copy));
    assert.strictEqual(result.status, "ok");
    assert.strictEqual(result.report.status, "upgraded");
    assert.strictEqual(result.report.source.kind, "sql-dump");
    assert.strictEqual(result.report.source.unchanged, true, "SQL 导出全程只读");
    assert.strictEqual(sha256File(dump), shaBefore);
    assert.strictEqual(result.report.fidelity.findings.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("P8 CLI：参数解析", () => {
  const plain = parseArgs(["--source", "x.sql"]);
  assert.strictEqual(plain.source, "x.sql");
  assert.strictEqual(plain.force, false);
  assert.strictEqual(plain.copy, null);
  const withSub = parseArgs(["upgrade", "--source", "x.sql", "--force"]);
  assert.strictEqual(withSub.source, "x.sql");
  assert.strictEqual(withSub.force, true);
  assert.throws(() => parseArgs(["--copy", "y"]), /--source/, "缺 source 报用法");
  assert.throws(() => parseArgs(["--source", "x", "--bogus"]), /未知参数/);
});

// 静态核对：migrations/ 不得混入 P8 文件（全新部署/测试会撞 no such column）
test("P8 目录边界：0021+ 不进 migrations/，migrations-p8/ 恰为五文件", () => {
  const deploy = readdirSync("migrations").filter((f) => f.endsWith(".sql")).sort();
  assert.ok(deploy.every((f) => !f.includes("_p8_")), "migrations/ 不得含 P8 文件");
  const p8 = readdirSync("migrations-p8").filter((f) => f.endsWith(".sql")).sort();
  assert.deepStrictEqual(p8, [...P8_SQL_FILES]);
});
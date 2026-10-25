import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  classify,
  expectedLedgerNames,
  ensureD1Migrations,
  resolveMaintenanceMode,
  P8_SQL_FILES
} from "../scripts/p8-deploy.mjs";
import type { WranglerRunner } from "../scripts/p8-deploy.mjs";

// P8 部署链接入验收（setup-cloudflare.mjs → scripts/p8-deploy.mjs）：
//   1. 全新库：只走普通 migrations/（20 条账本，无 P8）；
//   2. 精确旧库（feat/memory-dimensions 形状 + 旧账本 10 条）：自动执行
//      账本引导 → 普通迁移剩余 → 0021–0025 → P8 post-verify，账本终态 30 条；
//   3. stage 1 冻结推送（MAINTENANCE_MODE=true）：跳过全部 D1 变更只部署维护态；
//   4. 已完成库（legacy-done / current）：跳过特殊升级继续普通部署；
//   5. 部分迁移恢复：0023 中断 → 重跑按账本跳过已成功步骤、只补 0023–0025；
//   6. 未知结构拒绝；任一步失败（迁移失败 / post-verify 抓到损坏）不进入
//      最终 Worker 部署（镜像 `npm run deploy` 的 && 短路语义）；
//   7. 未来迁移兼容：P8 完成后新增 0026 不误判 unknown，legacy-done 续跑
//      普通迁移；但旧库升级序列遇 >0020 文件中止（0026+ 假定 P8 后形状）；
//   8. MAINTENANCE_MODE 契约：--keep-vars 下删行解不了冻（远端旧值保留），
//      缺键/拼错/空值一律构建失败，只接受显式 "true"/"false"；
//   9. post-verify 失败恢复缺口（fail-closed）：损坏 0025 只写账本 → 第一次
//      运行失败不部署；不修库直接重推，账本齐全但缺 p8_verification 标记 →
//      强制重验仍失败仍不部署；修复并验过写标记后，后续重推才走正常
//      legacy-done（不再重验）；
//   10. 写标记失败（验过 → 写标记之间中断）：构建中止；下次重推重验（只读
//      幂等）通过后写标记并部署——标记只能在 postVerify 全部成功之后写入。
// fake executor 用 node:sqlite 模拟远端 D1（含 wrangler d1 execute --file 的
// 整文件事务与 migrations apply 的按名跳过语义）。

const ROOT = join(import.meta.dirname, "..");
const MIGRATIONS_DIR = join(ROOT, "migrations");
const P8_DIR = join(ROOT, "migrations-p8");
const DB_NAME = "unit-test-db";
const D1_MIGRATIONS_DDL =
  "CREATE TABLE IF NOT EXISTS d1_migrations(\n\t\tid INTEGER PRIMARY KEY AUTOINCREMENT,\n\t\tname TEXT UNIQUE,\n\t\tapplied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL\n)";
const TS = "2026-01-01T00:00:00.000Z";

const SCHEMA_SECTIONS: { name: string; sql: string }[] = (() => {
  const raw = readFileSync(new URL("./fixtures/old-branch-schema.sql", import.meta.url), "utf8");
  const parts = raw.split(/^-- ==== /m).filter((p) => p.trim().length > 0);
  return parts.map((p) => {
    const nl = p.indexOf("\n");
    return { name: p.slice(0, nl).replace(/ ====$/, "").trim(), sql: p.slice(nl + 1) };
  });
})();

const SECTION_ORDER = [
  "0001_init", "0002_v4_assembler_cache", "0003_v2_memory_lifecycle", "0004_v2_daily_log",
  "0005_memory_candidates", "0006_role_memory_baseline", "0007_baseline_changelog",
  "0008_precious_soft_delete", "0009_daily_log_affect_chord", "0010_memory_weight_dimensions"
];

// 旧分支账本名（feat/memory-dimensions 的迁移文件名，与 fixture 一致）
const OLD_LEDGER = SECTION_ORDER.map((n) => `${n}.sql`);

function buildLegacyDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  for (const name of SECTION_ORDER) {
    const section = SCHEMA_SECTIONS.find((s) => s.name === name);
    assert.ok(section, `fixture 缺少 ${name}`);
    db.exec(section.sql);
  }
  db.exec(D1_MIGRATIONS_DDL);
  for (const name of OLD_LEDGER) db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run(name);
  seedLegacy(db);
  return db;
}

function seedLegacy(db: DatabaseSync): void {
  db.prepare(
    `INSERT INTO memories (id, namespace, type, content, importance, status, created_at, updated_at, role_id, role_name, role_scope, emotional, recurrence, unresolved, weight)
     VALUES ('m1','ns-a','fact','SECRET_MEM_A',0.5,'active','${TS}','${TS}','sol','Sol','id:sol',0,0,0,0.175)`
  ).run();
  db.prepare(
    `INSERT INTO memories (id, namespace, type, content, importance, status, created_at, updated_at, role_id, role_name, role_scope, emotional, recurrence, unresolved, weight)
     VALUES ('m2','ns-s','fact','SECRET_MEM_B',0.5,'superseded','${TS}','${TS}',NULL,NULL,'shared',0,0,0,0.175)`
  ).run();
  db.prepare(
    `INSERT INTO memory_lifecycle (memory_id, namespace, fact_key, seen_count, role_scope) VALUES ('m1','ns-a','SECRET_FK',1,'id:sol')`
  ).run();
  db.prepare(
    `INSERT INTO memory_lifecycle (memory_id, namespace, fact_key, seen_count, role_scope) VALUES ('orphan','ns-x','SECRET_FK_O',1,'id:sol')`
  ).run();
  db.prepare(
    `INSERT INTO daily_log (namespace, role_scope, date, title, summary, updated_at, affect_chord)
     VALUES ('ns-a','id:sol','2026-01-01','SECRET_T','SECRET_S','${TS}','F -> Am')`
  ).run();
  db.exec(
    `INSERT INTO long_term_baselines (namespace, role_scope, content, version, generated_at) VALUES ('ns-a','id:sol','SECRET_BL',1,'${TS}')`
  );
  db.exec(
    `INSERT INTO long_term_baseline_snapshots (id, namespace, role_scope, version, content, created_at) VALUES ('s1','ns-a','id:sol',1,'SECRET_SNAP','${TS}')`
  );
  db.exec(
    `INSERT INTO baseline_changelog (id, namespace, role_scope, op, after_content, reason, created_at, status) VALUES ('c1','ns-a','id:sol','add','SECRET_AFTER','SECRET_REASON','${TS}','pending')`
  );
  db.exec(`INSERT INTO digest (namespace, content, updated_at) VALUES ('ns-a', 'SECRET_DIGEST', '${TS}')`);
  db.exec(
    `INSERT INTO precious (id, namespace, content, source, pinned, created_at, status) VALUES ('p1','ns-a','SECRET_P','human',1,'${TS}','active')`
  );
  db.exec(
    `INSERT INTO glossary (id, namespace, term, definition, status, updated_at) VALUES ('g1','ns-a','SECRET_TERM','SECRET_DEF','active','${TS}')`
  );
  db.exec(`INSERT INTO longtail (id, namespace, content, ts) VALUES ('lt1','ns-a','SECRET_LT','${TS}')`);
  db.exec(
    `INSERT INTO memory_candidates (id, namespace, content, status, created_at, updated_at) VALUES ('mc1','ns-a','SECRET_CAND','pending','${TS}','${TS}')`
  );
  db.exec(`INSERT INTO summaries (id, namespace, content, created_at, updated_at) VALUES ('sm1','ns-a','SECRET_SUMMARY','${TS}','${TS}')`);
  db.exec(
    `INSERT INTO messages (id, conversation_id, namespace, role, content, client_message_hash, created_at, role_id, role_name)
     VALUES ('msg1','conv1','ns-a','user','SECRET_CHAT_1','old-hash-1','${TS}','sol','Sol'),
            ('msg2','conv2','ns-plain','assistant','SECRET_CHAT_2',NULL,'${TS}',NULL,NULL)`
  );
  db.exec(
    `INSERT INTO conversations (id, namespace, title, created_at, updated_at, role_id, role_name)
     VALUES ('conv1','ns-a','SECRET_CONV','${TS}','${TS}','sol','Sol'),
            ('conv2','ns-plain',NULL,'${TS}','${TS}',NULL,NULL)`
  );
  db.exec(
    `INSERT INTO usage_logs (id, message_id, namespace, raw_usage_json, created_at, client_system_hash) VALUES ('u1','msg1','ns-a','SECRET_USAGE','${TS}','sys-hash')`
  );
  db.exec(`INSERT INTO users (id, display_name, created_at, updated_at) VALUES ('u1','SECRET_USER','${TS}','${TS}')`);
  db.exec(`INSERT INTO cache_entries (id, namespace, key, created_at, updated_at) VALUES ('ce1','ns-a','k1','${TS}','${TS}')`);
  db.exec(
    `INSERT INTO idempotency_keys (key, task_type, status, created_at, updated_at) VALUES ('SECRET_IDEM','digest','done','${TS}','${TS}')`
  );
  db.exec(
    `INSERT INTO processing_cursors (name, value, updated_at) VALUES ('cursor-1','SECRET_V1','${TS}'), ('cursor-2','SECRET_V2','${TS}')`
  );
  db.exec(
    `INSERT INTO memory_changelog (id, namespace, role_scope, op, after_content, payload_json, created_at, status) VALUES ('ch1','ns-a','id:sol','add','SECRET_MC','{}','${TS}','pending')`
  );
}

// —— fake wrangler：node:sqlite 模拟远端 D1 ——

interface FakeD1 {
  db: DatabaseSync;
  run: WranglerRunner;
  calls: string[][];
}

function createFakeD1(db: DatabaseSync, opts: { failOn?: (args: string[]) => boolean; migrationsDir?: string } = {}): FakeD1 {
  const calls: string[][] = [];

  const hasLedgerTable = (): boolean =>
    (
      db
        .prepare("SELECT COUNT(*) AS c FROM sqlite_schema WHERE type='table' AND name='d1_migrations'")
        .get() as { c: number }
    ).c > 0;

  const ledgerOf = (): Set<string> =>
    new Set((db.prepare("SELECT name FROM d1_migrations").all() as { name: string }[]).map((r) => r.name));

  const runStatements = (sql: string): Array<{ results: unknown[]; success: true }> =>
    sql
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((statement) => {
        if (/^\s*(SELECT|PRAGMA)/i.test(statement)) {
          const rows = db.prepare(statement).all() as Record<string, unknown>[];
          return { results: JSON.parse(JSON.stringify(rows)) as unknown[], success: true as const };
        }
        db.exec(statement);
        return { results: [], success: true as const };
      });

  const execFile = (path: string): void => {
    const sql = readFileSync(path, "utf8");
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
      throw new Error(`wrangler d1 execute --file failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const simulateMigrationsApply = (): void => {
    const migDir = opts.migrationsDir ?? MIGRATIONS_DIR;
    if (!hasLedgerTable()) db.exec(D1_MIGRATIONS_DDL);
    const ledger = ledgerOf();
    for (const file of readdirSync(migDir).filter((f) => f.endsWith(".sql")).sort()) {
      if (ledger.has(file)) continue;
      const sql = readFileSync(join(migDir, file), "utf8");
      db.exec("BEGIN");
      try {
        db.exec(sql);
        db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run(file);
        db.exec("COMMIT");
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // 事务不在进行中则忽略
        }
        throw new Error(`wrangler d1 migrations apply failed at ${file}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };

  const run: WranglerRunner = (args, options = {}) => {
    calls.push(args);
    if (opts.failOn?.(args)) {
      throw new Error(`wrangler ${args.join(" ")} failed (注入失败)`);
    }
    if (args[0] === "d1" && args[1] === "migrations" && args[2] === "apply") {
      simulateMigrationsApply();
      return { status: 0, stdout: "" };
    }
    if (args[0] === "d1" && args[1] === "execute") {
      const cmdIdx = args.indexOf("--command");
      if (cmdIdx !== -1) {
        return { status: 0, stdout: JSON.stringify(runStatements(args[cmdIdx + 1] as string)) };
      }
      const fileIdx = args.indexOf("--file");
      if (fileIdx !== -1) {
        execFile(args[fileIdx + 1] as string);
        return { status: 0, stdout: "" };
      }
    }
    throw new Error(`fake wrangler 不支持: ${args.join(" ")}`);
  };

  return { db, run, calls };
}

// 镜像 `npm run setup:cloudflare && wrangler deploy` 的 && 短路：setup 抛错 → 不部署。
function runChain(fake: FakeD1, opts: { maintenance?: boolean; p8Dir?: string; migrationsDir?: string } = {}) {
  const deployed = { value: false };
  try {
    const result = ensureD1Migrations({
      run: fake.run,
      dbName: DB_NAME,
      root: ROOT,
      maintenance: opts.maintenance ?? false,
      migrationsDir: opts.migrationsDir,
      p8Dir: opts.p8Dir ?? P8_DIR
    });
    deployed.value = true;
    return { ok: true as const, result, deployed: deployed.value };
  } catch (error) {
    return { ok: false as const, error: error as Error, deployed: deployed.value };
  }
}

function quiet<T>(fn: () => T): T {
  const orig = console.log;
  console.log = () => {};
  try {
    return fn();
  } finally {
    console.log = orig;
  }
}

const ledgerOfDb = (db: DatabaseSync): string[] =>
  (db.prepare("SELECT name FROM d1_migrations ORDER BY name").all() as { name: string }[]).map((r) => r.name);

const ledgerOfDbSafe = (db: DatabaseSync): string[] => {
  const has = (
    db.prepare("SELECT COUNT(*) AS c FROM sqlite_schema WHERE type='table' AND name='d1_migrations'").get() as { c: number }
  ).c;
  return has > 0 ? ledgerOfDb(db) : [];
};

const colNames = (db: DatabaseSync, table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);

test("全新库：只走普通 migrations/，不执行 P8，可重复部署", () => {
  const db = new DatabaseSync(":memory:");
  const fake = createFakeD1(db);
  const first = quiet(() => runChain(fake));
  assert.strictEqual(first.ok, true, `全新库应通过：${first.ok ? "" : first.error?.message}`);
  assert.strictEqual(first.result.outcome, "applied");
  assert.strictEqual(first.result.state, "fresh");
  assert.strictEqual(first.deployed, true, "全新库部署应进行");
  const expected = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  assert.deepStrictEqual(ledgerOfDb(db), expected, "全新库账本 = 20 条普通迁移");
  assert.ok(!ledgerOfDb(db).some((n) => n.includes("_p8_")), "全新库不执行 P8");
  assert.ok(fake.calls.every((args) => !args.includes("--file")), "全新库不播放 P8 文件");
  assert.strictEqual(colNames(db, "memories").includes("role_scope"), false);

  // 第二次部署（current 状态）：普通迁移 no-op，继续部署
  const second = quiet(() => runChain(createFakeD1(db)));
  assert.strictEqual(second.ok, true);
  assert.strictEqual(second.result.outcome, "noop");
  assert.strictEqual(second.result.state, "current");
  assert.strictEqual(second.deployed, true);
});

test("stage 1 冻结推送：旧库 + MAINTENANCE_MODE=true → 跳过全部 D1 变更只部署维护态", () => {
  const db = buildLegacyDb();
  const fake = createFakeD1(db);
  const ledgerBefore = ledgerOfDb(db);
  const result = quiet(() => runChain(fake, { maintenance: true }));
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.result.outcome, "deferred");
  assert.strictEqual(result.result.state, "legacy-pending");
  assert.strictEqual(result.deployed, true, "维护态 Worker 要部署（冻结线上写入）");
  assert.deepStrictEqual(ledgerOfDb(db), ledgerBefore, "stage 1 不动账本");
  assert.deepStrictEqual(ledgerOfDb(db), OLD_LEDGER, "账本仍是旧 10 条");
  assert.ok(fake.calls.every((args) => !args.includes("--file")), "stage 1 不播放 P8 文件");
  assert.ok(
    fake.calls.every((args) => !(args[1] === "migrations" && args[2] === "apply")),
    "stage 1 不跑普通迁移"
  );
  assert.strictEqual(colNames(db, "memories").includes("role_scope"), true, "表结构原样");
});

test("精确旧库：自动升级全流程 + post-verify，账本终态 30 条，再次部署跳过", () => {
  const db = buildLegacyDb();
  const fake = createFakeD1(db);
  const result = quiet(() => runChain(fake));
  assert.strictEqual(result.ok, true, `旧库升级应通过：${result.ok ? "" : result.error?.message}`);
  assert.strictEqual(result.result.outcome, "upgraded");
  assert.strictEqual(result.deployed, true, "升级全过才进入 Worker 部署");

  // 账本 30 条（旧 10 + 引导 3 + 新 12 + P8 5）
  const expected = expectedLedgerNames(
    readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()
  );
  assert.strictEqual(expected.length, 30);
  assert.deepStrictEqual(ledgerOfDb(db), expected);

  // 升级顺序：账本引导在普通迁移之前（引导语句先于 migrations apply 出现）
  const bootstrapIdx = fake.calls.findIndex((args) => args.includes("--command") && String(args[args.indexOf("--command") + 1]).includes("INSERT INTO d1_migrations"));
  const applyIdx = fake.calls.findIndex((args) => args[1] === "migrations" && args[2] === "apply");
  assert.ok(bootstrapIdx !== -1 && applyIdx !== -1 && bootstrapIdx < applyIdx, "账本引导先于普通迁移");
  const p8FileCalls = fake.calls.filter((args) => args.includes("--file")).map((args) => String(args[args.indexOf("--file") + 1]));
  assert.deepStrictEqual(p8FileCalls.map((p) => p.split("/").pop()), [...P8_SQL_FILES], "P8 五文件按序播放");

  // 数据落法抽查（细节由 tests/migration-p8.test.ts 全量验收）
  const ns = (id: string) => (db.prepare("SELECT namespace FROM memories WHERE id = ?").get(id) as { namespace: string }).namespace;
  assert.strictEqual(ns("m1"), "sol", "id:sol → sol");
  assert.strictEqual(ns("m2"), "shared");
  assert.ok(!colNames(db, "memories").includes("role_scope"), "role 列收尾清除");
  assert.strictEqual(
    (db.prepare("SELECT COUNT(*) AS c FROM sqlite_schema WHERE type='table' AND name='memory_changelog'").get() as { c: number }).c,
    0,
    "memory_changelog 弃置删除"
  );
  assert.strictEqual((db.prepare("SELECT COUNT(*) AS c FROM processing_cursors").get() as { c: number }).c, 0, "游标清空");
  const dl = db.prepare("SELECT namespace, date, affect_chord FROM daily_log").get() as { namespace: string; date: string; affect_chord: string | null };
  assert.deepStrictEqual({ ...dl }, { namespace: "sol", date: "2026-01-01", affect_chord: "F -> Am" }, "daily_log 重建 + chord 保真");
  const lifecycle = db.prepare("SELECT COUNT(*) AS c FROM memory_lifecycle l WHERE NOT EXISTS (SELECT 1 FROM memories m WHERE m.id = l.memory_id)").get() as { c: number };
  assert.strictEqual(lifecycle.c, 0, "孤儿未迁入");
  const msg1 = db.prepare("SELECT namespace, client_message_hash, seq FROM messages WHERE id = 'msg1'").get() as { namespace: string; client_message_hash: string | null; seq: number };
  assert.deepStrictEqual({ ...msg1 }, { namespace: "sol", client_message_hash: null, seq: 0 }, "消息归属 + 0010 置 NULL + 0015 seq");

  // 再次部署（legacy-done）：跳过特殊升级，继续普通部署
  const againFake = createFakeD1(db);
  const again = quiet(() => runChain(againFake));
  assert.strictEqual(again.ok, true);
  assert.strictEqual(again.result.state, "legacy-done");
  assert.strictEqual(again.result.outcome, "noop");
  assert.strictEqual(again.deployed, true);
  assert.deepStrictEqual(ledgerOfDb(db), expected, "账本仍 30 条");
  assert.ok(againFake.calls.every((args) => !args.includes("--file")), "已完成库不再播放 P8");
});

test("部分迁移恢复：0023 中断 → 重跑按账本只补 0023–0025，不重复重建", () => {
  const db = buildLegacyDb();
  const interrupted = createFakeD1(db, {
    failOn: (args) => args.includes("--file") && String(args[args.indexOf("--file") + 1]).includes("0023_p8_baselines_rebuild.sql")
  });
  const first = quiet(() => runChain(interrupted));
  assert.strictEqual(first.ok, false, "0023 注入失败应中止构建");
  assert.strictEqual(first.deployed, false, "失败不进入最终 Worker 部署");
  assert.match(String(first.error?.message), /0023/);
  const ledgerMid = ledgerOfDb(db);
  assert.strictEqual(ledgerMid.length, 27, "旧10+引导3+新12+0021+0022");
  assert.ok(ledgerMid.includes("0021_p8_memories_and_sidecars.sql"));
  assert.ok(ledgerMid.includes("0022_p8_daily_log_rebuild.sql"));
  assert.ok(!ledgerMid.includes("0023_p8_baselines_rebuild.sql"), "失败文件未记账");
  assert.ok(!colNames(db, "daily_log").includes("role_scope"), "0022 已提交保持生效");
  assert.ok(colNames(db, "long_term_baselines").includes("role_scope"), "0023 回滚不留半迁移");

  // 重跑恢复：只补 0023–0025
  const resume = createFakeD1(db);
  const second = quiet(() => runChain(resume));
  assert.strictEqual(second.ok, true, `恢复应通过：${second.ok ? "" : second.error?.message}`);
  assert.strictEqual(second.deployed, true);
  const p8FilesRun = resume.calls
    .filter((args) => args.includes("--file"))
    .map((args) => String(args[args.indexOf("--file") + 1]).split("/").pop());
  assert.deepStrictEqual(p8FilesRun, ["0023_p8_baselines_rebuild.sql", "0024_p8_roleless_messages_shared.sql", "0025_p8_role_columns_cleanup.sql"], "按账本跳过已成功步骤");
  assert.strictEqual(ledgerOfDb(db).length, 30, "账本终态 30 条");
  // 引导与普通迁移幂等跳过（不再有 INSERT 引导命令）
  const bootstrapCalls = resume.calls.filter((args) => args.includes("--command") && String(args[args.indexOf("--command") + 1]).includes("INSERT INTO d1_migrations"));
  assert.strictEqual(bootstrapCalls.length, 0, "引导已存在不重插");
});

test("未知结构拒绝：多场景一律失败且不部署、不动库", () => {
  const cases: Array<{ label: string; build: () => DatabaseSync }> = [
    {
      label: "有表但无账本",
      build: () => {
        const db = new DatabaseSync(":memory:");
        db.exec("CREATE TABLE memories (id TEXT)");
        return db;
      }
    },
    {
      label: "账本缺一条旧迁移名",
      build: () => {
        const db = buildLegacyDb();
        db.prepare("DELETE FROM d1_migrations WHERE name = '0010_memory_weight_dimensions.sql'").run();
        return db;
      }
    },
    {
      label: "旧账本但表不是旧形状",
      build: () => {
        const db = buildLegacyDb();
        db.exec("DROP INDEX idx_memories_role_scope; ALTER TABLE memories DROP COLUMN role_scope");
        return db;
      }
    },
    {
      label: "账本含未知迁移名",
      build: () => {
        const db = buildLegacyDb();
        db.prepare("INSERT INTO d1_migrations (name) VALUES ('0099_mystery.sql')").run();
        return db;
      }
    },
    {
      label: "账本为空但有表",
      build: () => {
        const db = buildLegacyDb();
        db.exec("DELETE FROM d1_migrations");
        return db;
      }
    }
  ];
  for (const { label, build } of cases) {
    const db = build();
    const ledgerBefore = ledgerOfDbSafe(db);
    const fake = createFakeD1(db);
    const result = quiet(() => runChain(fake));
    assert.strictEqual(result.ok, false, `${label} 应拒绝`);
    assert.strictEqual(result.deployed, false, `${label} 不部署 Worker`);
    assert.match(String(result.error?.message), /无法识别|拒绝/, `${label} 报错说明原因`);
    assert.deepStrictEqual(ledgerOfDbSafe(db), ledgerBefore, `${label} 不动账本`);
    assert.ok(fake.calls.every((args) => !args.includes("--file")), `${label} 不播放 P8`);
  }

  // 维护态不豁免未知结构
  const unknown = createFakeD1(cases[0].build());
  const maintenance = quiet(() => runChain(unknown, { maintenance: true }));
  assert.strictEqual(maintenance.ok, false, "维护态下未知结构仍拒绝");
  assert.strictEqual(maintenance.deployed, false);
});

test("迁移/校验任一步失败：构建中止且不部署（&& 短路）", () => {
  // 普通迁移失败（全新库 migrations apply 阶段挂掉）
  const db = new DatabaseSync(":memory:");
  const failApply = createFakeD1(db, {
    failOn: (args) => args[1] === "migrations" && args[2] === "apply"
  });
  const r1 = quiet(() => runChain(failApply));
  assert.strictEqual(r1.ok, false);
  assert.strictEqual(r1.deployed, false, "迁移失败不部署");
  assert.strictEqual(fakeLedgerCount(db), 0, "migrations apply 未记账（事务未提交）");

  // P8 post-verify 抓到损坏：0025 被截断只剩记账 → role 列残留 → 校验失败不部署
  const dir = mkdtempSync(join(tmpdir(), "p8-deploy-corrupt-"));
  try {
    const p8Copy = join(dir, "migrations-p8");
    mkdirSync(p8Copy, { recursive: true });
    for (const file of P8_SQL_FILES) {
      let sql = readFileSync(join(P8_DIR, file), "utf8");
      if (file === "0025_p8_role_columns_cleanup.sql") {
        sql = `-- 截断损坏：只剩记账\nINSERT INTO d1_migrations (name) VALUES ('${file}');\n`;
      }
      writeFileSync(join(p8Copy, file), sql, "utf8");
    }
    const legacy = buildLegacyDb();
    const fake = createFakeD1(legacy);
    const result = quiet(() => runChain(fake, { p8Dir: p8Copy }));
    assert.strictEqual(result.ok, false, "post-verify 应抓到 role 列残留");
    assert.strictEqual(result.deployed, false, "校验失败不进入最终 Worker 部署");
    assert.match(String(result.error?.message), /post-verify/, "报错指向 post-verify");
    assert.match(String(result.error?.message), /role/, "报错指出 role 列残留");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fakeLedgerCount(db: DatabaseSync): number {
  const has = (
    db.prepare("SELECT COUNT(*) AS c FROM sqlite_schema WHERE type='table' AND name='d1_migrations'").get() as { c: number }
  ).c;
  if (!has) return 0;
  return (db.prepare("SELECT COUNT(*) AS c FROM d1_migrations").get() as { c: number }).c;
}
test("未来迁移兼容：P8 完成后新增 0026 不误判 unknown，legacy-done 续跑普通迁移", () => {
  // 用户探针的回归（纯函数层）：完整 30 条账本 + 0026 在 migrations/ 未应用。
  // 修复前 classify 要求"普通迁移全齐"才算 legacy-done，0026 未应用 → 掉进
  // "P8 未完成"分支 → role_scope 已被 0025 清除 → 误判 unknown 拒绝部署。
  const db = buildLegacyDb();
  const fake = createFakeD1(db);
  const upgraded = quiet(() => runChain(fake));
  assert.strictEqual(upgraded.ok, true, `升级应通过：${upgraded.ok ? "" : upgraded.error?.message}`);
  assert.strictEqual(ledgerOfDb(db).length, 30);

  const futureName = "0026_future_marker.sql";
  const migNames = [...readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort(), futureName];
  const verdict = classify({
    tables: (
      db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]
    ).map((r) => r.name),
    ledger: ledgerOfDb(db),
    memoriesCols: colNames(db, "memories"),
    dailyLogCols: colNames(db, "daily_log"),
    baselinesCols: colNames(db, "long_term_baselines"),
    migrationNames: migNames
  });
  assert.strictEqual(verdict.state, "legacy-done", `不应误判（${verdict.state}: ${verdict.reason}）`);
  assert.ok(!colNames(db, "memories").includes("role_scope"), "前置：P8 已清旧形状");

  // 全链层：下次部署把 0026 当普通迁移应用，不重播 P8
  const dir = mkdtempSync(join(tmpdir(), "p8-future-mig-"));
  try {
    const migDir = join(dir, "migrations");
    cpSync(MIGRATIONS_DIR, migDir, { recursive: true });
    writeFileSync(join(migDir, futureName), "CREATE TABLE IF NOT EXISTS future_marker (id INTEGER PRIMARY KEY);\n", "utf8");
    const nextFake = createFakeD1(db, { migrationsDir: migDir });
    const next = quiet(() => runChain(nextFake, { migrationsDir: migDir }));
    assert.strictEqual(next.ok, true, `未来迁移部署应通过：${next.ok ? "" : next.error?.message}`);
    assert.strictEqual(next.result.state, "legacy-done");
    assert.strictEqual(next.result.outcome, "noop");
    assert.strictEqual(next.deployed, true, "未来迁移不阻塞部署");
    assert.ok(ledgerOfDb(db).includes(futureName), "0026 已记账");
    assert.strictEqual(ledgerOfDb(db).length, 31, "账本 30 + 0026");
    assert.ok(
      nextFake.calls.every((args) => !args.includes("--file")),
      "legacy-done 不重播 P8 文件"
    );
    const marker = (
      db.prepare("SELECT COUNT(*) AS c FROM sqlite_schema WHERE type='table' AND name='future_marker'").get() as { c: number }
    ).c;
    assert.strictEqual(marker, 1, "0026 已应用");

    // 幂等：再部署一次仍是 no-op
    const again = quiet(() => runChain(createFakeD1(db, { migrationsDir: migDir }), { migrationsDir: migDir }));
    assert.strictEqual(again.ok, true);
    assert.strictEqual(again.result.outcome, "noop");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("旧库升级序列守卫：migrations/ 出现编号 >0020 的文件 → 中止构建、不碰库", () => {
  const dir = mkdtempSync(join(tmpdir(), "p8-guard-"));
  try {
    const migDir = join(dir, "migrations");
    cpSync(MIGRATIONS_DIR, migDir, { recursive: true });
    writeFileSync(
      join(migDir, "0026_future_marker.sql"),
      "CREATE TABLE IF NOT EXISTS future_marker (id INTEGER PRIMARY KEY);\n",
      "utf8"
    );
    const db = buildLegacyDb();
    const fake = createFakeD1(db, { migrationsDir: migDir });
    const result = quiet(() => runChain(fake, { migrationsDir: migDir }));
    assert.strictEqual(result.ok, false, "0026+ 混入旧库升级应中止");
    assert.strictEqual(result.deployed, false, "守卫失败不进入 Worker 部署");
    assert.match(String(result.error?.message), /0026_future_marker\.sql/, "报错点名越界文件");
    assert.match(String(result.error?.message), /0021–0025/, "报错说明 P8 保留区间");
    assert.deepStrictEqual(ledgerOfDb(db), OLD_LEDGER, "账本原样（旧 10 条）");
    assert.ok(colNames(db, "memories").includes("role_scope"), "表结构原样");
    assert.ok(fake.calls.every((args) => !args.includes("--file")), "不播放 P8 文件");
    assert.ok(
      fake.calls.every((args) => !(args[1] === "migrations" && args[2] === "apply")),
      "不跑普通迁移"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MAINTENANCE_MODE 契约：缺键/拼错/空值一律构建失败（--keep-vars 下删行解不了冻）", () => {
  assert.strictEqual(resolveMaintenanceMode("true"), true, "stage 1 冻结");
  assert.strictEqual(resolveMaintenanceMode("false"), false, "stage 2 解冻（显式写回）");
  for (const bad of [null, undefined, "", "ture", "TRUE", "1"]) {
    assert.throws(
      () => resolveMaintenanceMode(bad),
      (error: Error) => /keep-vars/.test(error.message) && /503/.test(error.message),
      `非法值 ${JSON.stringify(bad ?? null)} 应报可行动的错误`
    );
  }
});

function markerCount(db: DatabaseSync): number {
  return (
    db.prepare("SELECT COUNT(*) AS c FROM sqlite_schema WHERE type='table' AND name='p8_verification'").get() as { c: number }
  ).c;
}

const ranPostVerify = (fake: FakeD1): boolean =>
  fake.calls.some((args) => args.some((a) => String(a).includes("processing_cursors")));

test("fail-closed：损坏 0025 只写账本 → 重推必须重验、仍失败仍不部署；修复验过写标记后才放行", () => {
  const dir = mkdtempSync(join(tmpdir(), "p8-failclosed-"));
  try {
    const p8Copy = join(dir, "migrations-p8");
    mkdirSync(p8Copy, { recursive: true });
    const writeP8Dir = (corrupt: boolean): void => {
      for (const file of P8_SQL_FILES) {
        let sql = readFileSync(join(P8_DIR, file), "utf8");
        if (file === "0025_p8_role_columns_cleanup.sql" && corrupt) {
          sql = `-- 截断损坏：只剩记账\nINSERT INTO d1_migrations (name) VALUES ('${file}');\n`;
        }
        writeFileSync(join(p8Copy, file), sql, "utf8");
      }
    };

    // 第一次：升级构建 post-verify 抓到 role 列残留 → 中止、不部署
    writeP8Dir(true);
    const db = buildLegacyDb();
    const r1 = quiet(() => runChain(createFakeD1(db), { p8Dir: p8Copy }));
    assert.strictEqual(r1.ok, false, "post-verify 应抓到损坏");
    assert.strictEqual(r1.deployed, false, "第一次失败不部署");
    assert.match(String(r1.error?.message), /post-verify/);
    assert.strictEqual(ledgerOfDb(db).length, 30, "损坏 0025 只写账本：P8 五条全记账");
    assert.strictEqual(markerCount(db), 0, "未验证 → 无标记");
    assert.ok(colNames(db, "memories").includes("role_scope"), "库实际是坏的");

    // 第二次：不修数据库直接重推——账本齐全但缺标记，必须重验且仍失败、仍不部署
    const ledgerBeforeR2 = ledgerOfDb(db);
    const fake2 = createFakeD1(db);
    const r2 = quiet(() => runChain(fake2, { p8Dir: p8Copy }));
    assert.strictEqual(r2.ok, false, "缺验证标记的 legacy-done 不得直接部署（fail-closed）");
    assert.strictEqual(r2.deployed, false, "重验失败不部署");
    assert.match(String(r2.error?.message), /post-verify/);
    assert.match(String(r2.error?.message), /role/, "重验仍抓到 role 列残留");
    assert.ok(ranPostVerify(fake2), "第二次确实重跑了 post-verify");
    assert.strictEqual(markerCount(db), 0, "重验失败不写标记");
    assert.deepStrictEqual(ledgerOfDb(db), ledgerBeforeR2, "库原样未动（重验只读）");

    // 修复（模拟从备份恢复到 0025 未执行态）+ 换健康文件 → 补 0025、验过、写标记、部署
    db.prepare("DELETE FROM d1_migrations WHERE name = '0025_p8_role_columns_cleanup.sql'").run();
    writeP8Dir(false);
    const r3 = quiet(() => runChain(createFakeD1(db), { p8Dir: p8Copy }));
    assert.strictEqual(r3.ok, true, `修复后应通过：${r3.ok ? "" : r3.error?.message}`);
    assert.strictEqual(r3.deployed, true, "验过 + 标记在 → 允许部署");
    assert.strictEqual(r3.result.outcome, "upgraded");
    assert.strictEqual(markerCount(db), 1, "post-verify 成功后写入标记");
    assert.ok(!colNames(db, "memories").includes("role_scope"), "库已修复");

    // 后续重推：标记在 → 正常 legacy-done 路径，不再重验、不再写标记
    const fake4 = createFakeD1(db);
    const r4 = quiet(() => runChain(fake4, { p8Dir: p8Copy }));
    assert.strictEqual(r4.ok, true);
    assert.strictEqual(r4.result.state, "legacy-done");
    assert.strictEqual(r4.result.outcome, "noop");
    assert.strictEqual(r4.deployed, true);
    assert.strictEqual(ranPostVerify(fake4), false, "标记在 → 不重跑 post-verify");
    assert.ok(
      fake4.calls.every((args) => !args.some((a) => String(a).includes("p8_verification"))),
      "标记在 → 不再写标记"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("写标记失败：验过 → 写标记之间中断 → 构建中止；下次重推重验安全通过后写标记并部署", () => {
  const db = buildLegacyDb();
  // 只有"写标记"这一步失败（post-verify 本身通过）
  const failMarkerWrite = createFakeD1(db, {
    failOn: (args) =>
      args.includes("--command") && String(args[args.indexOf("--command") + 1]).includes("p8_verification")
  });
  const r1 = quiet(() => runChain(failMarkerWrite));
  assert.strictEqual(r1.ok, false, "写标记失败应中止构建");
  assert.strictEqual(r1.deployed, false, "标记没写成 → 不部署");
  assert.strictEqual(ledgerOfDb(db).length, 30, "P8 已全部记账");
  assert.strictEqual(markerCount(db), 0, "标记缺失");

  // 下次重推：legacy-done + 缺标记 → 重跑 post-verify（只读幂等，安全）→ 通过 → 补写标记 → 部署
  const fake2 = createFakeD1(db);
  const r2 = quiet(() => runChain(fake2));
  assert.strictEqual(r2.ok, true, `重推应通过：${r2.ok ? "" : r2.error?.message}`);
  assert.strictEqual(r2.result.state, "legacy-done");
  assert.strictEqual(r2.result.outcome, "noop");
  assert.strictEqual(r2.deployed, true, "重验通过 + 标记写成 → 部署");
  assert.ok(ranPostVerify(fake2), "重推确实重跑了 post-verify");
  assert.strictEqual(markerCount(db), 1, "标记补写成功");
});

import { strict as assert } from "node:assert";
import { beforeEach, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";

// P5-B precious 软删除验收（行为模板 = 旧分支 ee71f87 + 4d2b87b，0020 同构旧 0008）：
//   1. createPrecious 不写 status，走 DB DEFAULT 'active'；
//   2. deletePrecious = UPDATE status='deleted'，行保留在 D1；
//   3. getPreciousById / listPrecious 只见 active；
//   4. 重复删除 changes=0 → false（未命中语义不变）；
//   5. namespace 隔离不受软删影响；
//   6. 0020 之前的存量行升级后默认 active、正常可读。

function applyMigrations(sqlite: DatabaseSync, skip?: string) {
  for (const file of readdirSync("migrations").filter((f: string) => f.endsWith(".sql")).sort()) {
    if (file === skip) continue;
    try { sqlite.exec(readFileSync(`migrations/${file}`, "utf8")); }
    catch (error) { if (!String(error).includes("fts5")) throw error; }
  }
}

function makeDb(sqlite: DatabaseSync): any {
  return {
    prepare(sql: string) {
      const statement = sqlite.prepare(sql); let args: any[] = [];
      const api = {
        bind(...values: any[]) { args = values; return api; },
        async first() { return statement.get(...args) || null; },
        async all() { return { results: statement.all(...args) }; },
        async run() { const r = statement.run(...args); return { meta: { changes: r.changes } }; }
      };
      return api;
    }
  };
}

let sqlite: DatabaseSync;
let db: any;

beforeEach(() => {
  sqlite?.close(); sqlite = new DatabaseSync(":memory:");
  applyMigrations(sqlite);
  db = makeDb(sqlite);
});

function rawRow(id: string): Record<string, unknown> | undefined {
  return sqlite.prepare("SELECT * FROM precious WHERE id = ?").get(id) as
    Record<string, unknown> | undefined;
}

test("createPrecious leaves status to the DB default and returns active", async () => {
  const { createPrecious } = await import("../src/db/v2/precious");
  const row = await createPrecious(db, { namespace: "sol", content: "喜欢 Cloudflare" });
  assert.strictEqual(row.status, "active", "returned row carries the DB default");
  assert.strictEqual(rawRow(row.id)?.status, "active", "DB row is active without INSERT writing status");
});

test("soft-deleted row disappears from get/list but stays in D1 with status=deleted", async () => {
  const { createPrecious, deletePrecious, getPreciousById, listPrecious } =
    await import("../src/db/v2/precious");
  const row = await createPrecious(db, { namespace: "sol", content: "x" });
  assert.strictEqual(await deletePrecious(db, { namespace: "sol", id: row.id }), true);
  assert.strictEqual(await getPreciousById(db, { namespace: "sol", id: row.id }), null, "get hides deleted");
  assert.strictEqual((await listPrecious(db, { namespace: "sol", limit: 10 })).length, 0, "list hides deleted");
  const stored = rawRow(row.id);
  assert.ok(stored, "physical row must survive");
  assert.strictEqual(stored?.status, "deleted");
  assert.strictEqual(stored?.content, "x", "content untouched for later recovery/migration");
});

test("deleting twice returns false (miss semantics unchanged)", async () => {
  const { createPrecious, deletePrecious } = await import("../src/db/v2/precious");
  const row = await createPrecious(db, { namespace: "sol", content: "x" });
  assert.strictEqual(await deletePrecious(db, { namespace: "sol", id: row.id }), true);
  assert.strictEqual(await deletePrecious(db, { namespace: "sol", id: row.id }), false);
});

test("namespace isolation is unaffected by soft delete", async () => {
  const { createPrecious, deletePrecious, getPreciousById, listPrecious } =
    await import("../src/db/v2/precious");
  const a = await createPrecious(db, { namespace: "ns-a", content: "a" });
  const b = await createPrecious(db, { namespace: "ns-b", content: "b" });
  assert.strictEqual(await getPreciousById(db, { namespace: "ns-b", id: a.id }), null, "cross-namespace get stays isolated");
  assert.strictEqual(await deletePrecious(db, { namespace: "ns-a", id: a.id }), true);
  assert.strictEqual((await listPrecious(db, { namespace: "ns-a", limit: 10 })).length, 0);
  const bRows = await listPrecious(db, { namespace: "ns-b", limit: 10 });
  assert.strictEqual(bRows.length, 1);
  assert.strictEqual(bRows[0].id, b.id, "other namespace untouched");
  assert.strictEqual(rawRow(a.id)?.status, "deleted");
});

test("listPrecious returns only active rows", async () => {
  const { createPrecious, deletePrecious, listPrecious } = await import("../src/db/v2/precious");
  await createPrecious(db, { namespace: "sol", content: "keep1" });
  const doomed = await createPrecious(db, { namespace: "sol", content: "doomed" });
  await createPrecious(db, { namespace: "sol", content: "keep2" });
  assert.strictEqual((await listPrecious(db, { namespace: "sol", limit: 10 })).length, 3);
  assert.strictEqual(await deletePrecious(db, { namespace: "sol", id: doomed.id }), true);
  const after = await listPrecious(db, { namespace: "sol", limit: 10 });
  assert.strictEqual(after.length, 2, "mixed active/deleted listing keeps only active");
  assert.ok(after.every((r) => r.status === "active"));
  assert.ok(!after.some((r) => r.id === doomed.id));
});

test("rows created before 0020 upgrade come back active and readable", async () => {
  const legacy = new DatabaseSync(":memory:");
  applyMigrations(legacy, "0020_precious_status.sql");
  legacy.prepare(
    "INSERT INTO precious (id, namespace, content, created_at) VALUES ('legacy-1', 'sol', 'upgrade row', '2026-01-01')"
  ).run();
  legacy.exec(readFileSync("migrations/0020_precious_status.sql", "utf8"));
  const raw = legacy.prepare("SELECT status FROM precious WHERE id = 'legacy-1'").get() as { status: string };
  assert.strictEqual(raw.status, "active", "ADD COLUMN DEFAULT backfills active on existing rows");
  const legacyDb = makeDb(legacy);
  const { getPreciousById, listPrecious } = await import("../src/db/v2/precious");
  const visible = await getPreciousById(legacyDb, { namespace: "sol", id: "legacy-1" });
  assert.ok(visible, "pre-upgrade row reads normally after 0020");
  assert.strictEqual((await listPrecious(legacyDb, { namespace: "sol", limit: 10 })).length, 1);
  legacy.close();
});
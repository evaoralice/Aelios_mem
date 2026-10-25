import { strict as assert } from "node:assert";
import { beforeEach, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";

// P5-C retention 数据保护验收（行为模板 = 旧分支 4882057，P0-3/P0-4）：
//   1. expireOldMemories 尊重最近召回：updated_at 过期但 last_recalled_at 在窗口内不过期；
//   2. MEMORY_AUTO_DELETE 硬删闸门：默认关，只统计/报告候选，不物理删除；
//   3. 硬删窗口 365 天；
//   4. 真正硬删时连带清理 memory_lifecycle 侧车，不留孤儿。

let sqlite: DatabaseSync;
let db: any;
let env: any;

beforeEach(() => {
  sqlite?.close(); sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync("migrations").filter((f: string) => f.endsWith(".sql")).sort()) {
    try { sqlite.exec(readFileSync(`migrations/${file}`, "utf8")); }
    catch (error) { if (!String(error).includes("fts5")) throw error; }
  }
  db = {
    prepare(sql: string) {
      const statement = sqlite.prepare(sql); let args: any[] = [];
      const api = {
        bind(...values: any[]) { args = values; return api; },
        async first() { return statement.get(...args) || null; },
        async all() { return { results: statement.all(...args) }; },
        async run() { const r = statement.run(...args); return { meta: { changes: r.changes } }; }
      };
      return api;
    },
    async batch(statements: any[]) {
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec("COMMIT"); return results;
      } catch (e) { sqlite.exec("ROLLBACK"); throw e; }
    }
  };
  env = { DB: db };
});

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function insertMemory(row: {
  id: string; status: string; updatedAt: string; lastRecalledAt: string | null;
}) {
  sqlite.prepare(
    `INSERT INTO memories (id, namespace, type, content, status, pinned, vector_id,
       last_recalled_at, created_at, updated_at)
     VALUES (?, 'sol', 'note', ?, ?, 0, NULL, ?, ?, ?)`
  ).run(row.id, `content ${row.id}`, row.status, row.lastRecalledAt, row.updatedAt, row.updatedAt);
  sqlite.prepare(
    "INSERT INTO memory_lifecycle (memory_id, namespace, fact_key) VALUES (?, 'sol', ?)"
  ).run(row.id, `fk-${row.id}`);
}

function memoryStatus(id: string): string | undefined {
  const row = sqlite.prepare("SELECT status FROM memories WHERE id = ?").get(id) as
    { status?: string } | undefined;
  return row?.status;
}

// ---------------------------------------------------------------------------
// P0-4 · expireOldMemories 尊重最近召回
// ---------------------------------------------------------------------------

test("recently recalled memory is not expired even if updated_at is old", async () => {
  insertMemory({ id: "mr1", status: "active", updatedAt: daysAgoIso(200), lastRecalledAt: daysAgoIso(5) });
  const { count, expired } = await expireOldMemoriesForTest();
  assert.strictEqual(count, 0, "recently recalled memory must stay active");
  assert.strictEqual(expired.length, 0);
  assert.strictEqual(memoryStatus("mr1"), "active");
});

test("never-recalled memory whose updated_at is past expiry still expires", async () => {
  insertMemory({ id: "mr2", status: "active", updatedAt: daysAgoIso(200), lastRecalledAt: null });
  const { count, expired } = await expireOldMemoriesForTest();
  assert.strictEqual(count, 1);
  assert.strictEqual(expired[0].id, "mr2");
  assert.strictEqual(memoryStatus("mr2"), "expired");
});

test("memory whose recall time is also past expiry becomes a candidate again", async () => {
  insertMemory({ id: "mr3", status: "active", updatedAt: daysAgoIso(200), lastRecalledAt: daysAgoIso(200) });
  const { count, expired } = await expireOldMemoriesForTest();
  assert.strictEqual(count, 1, "stale recall does not keep memory alive");
  assert.strictEqual(expired[0].id, "mr3");
  assert.strictEqual(memoryStatus("mr3"), "expired");
});

async function expireOldMemoriesForTest() {
  const { expireOldMemories } = await import("../src/db/retention");
  return expireOldMemories(db, "sol", daysAgoIso(180));
}

// ---------------------------------------------------------------------------
// P0-3 · MEMORY_AUTO_DELETE 闸门 + lifecycle 侧车清理
// ---------------------------------------------------------------------------

function seedHardDeletable() {
  // 终态行（deleted），updated_at 400 天前（> 365 天窗口），vector_id NULL（无 VECTORIZE 路径）。
  insertMemory({ id: "hd1", status: "deleted", updatedAt: daysAgoIso(400), lastRecalledAt: null });
  insertMemory({ id: "hd2", status: "deleted", updatedAt: daysAgoIso(400), lastRecalledAt: null });
}

async function runRetention(autoDelete: string | undefined): Promise<Record<string, number>> {
  const { runMemoryRetention } = await import("../src/memory/retention");
  const testEnv = { ...env, MEMORY_AUTO_DELETE: autoDelete };
  const result = await runMemoryRetention(testEnv, "sol");
  assert.strictEqual(result.ran, true, "retention must run on a fresh cursor");
  assert.ok(result.stats, "retention must report stats when ran");
  return result.stats;
}

function lifecycleCount(id: string): number {
  const row = sqlite.prepare("SELECT COUNT(*) AS c FROM memory_lifecycle WHERE memory_id = ?").get(id) as { c: number };
  return row.c;
}

test("gate off (default): hard delete candidates are reported but rows survive", async () => {
  seedHardDeletable();
  const stats = await runRetention(undefined);
  assert.strictEqual(stats.hardDeleteCandidates, 2);
  assert.strictEqual(stats.hardDeletedMemories, 0);
  assert.strictEqual(memoryStatus("hd1"), "deleted", "row must survive when gate is off");
  assert.strictEqual(memoryStatus("hd2"), "deleted");
  assert.strictEqual(lifecycleCount("hd1"), 1, "sidecar must survive too");
});

test("gate on (MEMORY_AUTO_DELETE=true): hard delete executes within the 365-day window", async () => {
  seedHardDeletable();
  // 窗口内（< 365 天）的终态行不应被删。
  insertMemory({ id: "fresh", status: "deleted", updatedAt: daysAgoIso(30), lastRecalledAt: null });
  const stats = await runRetention("true");
  assert.strictEqual(stats.hardDeletedMemories, 2, "only rows older than 365 days are deleted");
  assert.strictEqual(memoryStatus("hd1"), undefined, "row physically deleted");
  assert.strictEqual(memoryStatus("fresh"), "deleted", "30-day-old terminal row survives (365-day window)");
});

test("hard delete leaves no orphan memory_lifecycle sidecar rows", async () => {
  seedHardDeletable();
  assert.strictEqual(lifecycleCount("hd1"), 1);
  const stats = await runRetention("true");
  assert.strictEqual(stats.hardDeletedMemories, 2);
  assert.strictEqual(lifecycleCount("hd1"), 0, "sidecar deleted together with memory row");
  assert.strictEqual(lifecycleCount("hd2"), 0);
});
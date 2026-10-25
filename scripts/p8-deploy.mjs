// =====================================================================
// P8 部署链接入模块（plan 工作包 P8 部署链；离线 tooling，不入 src/）。
//
// 在 `npm run deploy` 的 setup 阶段（scripts/setup-cloudflare.mjs 的 D1 步）
// 自动识别远端 D1 的三种谱系并采取对应动作：
//   fresh          全新库（零表）            → 只走普通 migrations/
//   legacy-pending 旧 feat/memory-dimensions 库 → 账本引导 → 普通迁移剩余 →
//                  migrations-p8/0021–0025 → P8 post-verify
//   legacy-done    旧库已完成 P8             → 验证标记在：跳过特殊升级，继续普通部署；
//                  缺标记（post-verify 从未成功）→ 强制重跑 post-verify，失败不部署
//   current        全新谱系（全新部署或其中断恢复）→ 普通迁移续跑
//   unknown        无法识别/结构矛盾          → 立即失败，不部署 Worker
//
// 关键事实（wrangler 4.85 源码核实）：
//   - `wrangler d1 execute --file` 整文件单事务（trimmer 明确注释
//     "D1 runs your SQL in a transaction for you"，多余 BEGIN/COMMIT 被剥离），
//     失败整文件回滚可安全重试 → 0021–0025 自带的记账 INSERT 与数据变更同事务；
//   - `wrangler d1 execute --json -y --command "多语句"` 输出纯 JSON 数组，
//     每语句一个 { results, success, meta } → 状态探测与 post-verify 的读通道；
//   - `wrangler deploy --keep-vars`（本仓库 npm run deploy 固定使用）上传时带
//     keep_bindings: ["plain_text","json"]——**不在本次 toml [vars] 里的远端变量
//     会被保留**。因此"从 toml 删除 MAINTENANCE_MODE"解不了冻：stage 1 部署的
//     "true" 会一直残留，服务永久 503。解冻只能**显式写回 "false"**（在 toml
//     里的变量部署时总是覆盖远端同名值），该行必须常驻 [vars]（缺键=构建失败，
//     见 resolveMaintenanceMode）。
//
// 写入冻结（两阶段发布）：本模块自身无法冻结"正在跑的旧 Worker"——推送只在新
// Worker 部署时生效，而迁移发生在部署之前。因此旧库升级按两阶段 Git 发布：
//   stage 1（冻结推送）: [vars] MAINTENANCE_MODE="false" 改为 "true" → push；
//     本模块跳过全部 D1 变更，只部署维护态 Worker（fetch 写路径全 503、cron
//     跳过、queue 不消费）；
//   stage 2（解冻推送）: 确认 stage 1 构建成功后，把 MAINTENANCE_MODE 改回
//     "false" → push；在"线上已冻结"的前提下执行完整升级序列 + post-verify，
//     然后部署正常 Worker（远端变量被显式覆盖回 "false"，解冻确定生效）。
// 用户操作只有推送；备份（wrangler d1 export + 确认恢复点）是上线前置条件，
// 由用户在 stage 1 之前自行完成，脚本不做备份。
//
// 未来迁移兼容：账本识别的"普通迁移名"从 migrations/ 目录实时派生——P8 完成
// 后新增 0026+ 不会把库误判为 unknown（legacy-done 只看旧 10 + P8 5 是否齐，
// 新增普通迁移由 d1 migrations apply 续跑）。但旧库升级序列里 migrations/
// 不允许出现编号 >0020 的文件（P8 保留 0021–0025；0026+ 假定 P8 后形状），
// 出现即中止构建，等旧环境全部完成 P8 后再加入。
//
// 测试（tests/p8-deploy.test.ts）通过注入 fake executor（node:sqlite 模拟远端）
// 覆盖：全新库 / 精确旧库 / 已完成库 / 部分迁移恢复 / 未知结构拒绝 /
// 任一步失败不进入最终 Worker 部署。
// =====================================================================

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// 线上旧分支（feat/memory-dimensions）已应用的迁移名（inspect 实测账本）。
export const OLD_LEDGER = [
  "0001_init.sql",
  "0002_v4_assembler_cache.sql",
  "0003_v2_memory_lifecycle.sql",
  "0004_v2_daily_log.sql",
  "0005_memory_candidates.sql",
  "0006_role_memory_baseline.sql",
  "0007_baseline_changelog.sql",
  "0008_precious_soft_delete.sql",
  "0009_daily_log_affect_chord.sql",
  "0010_memory_weight_dimensions.sql"
];

// 账本引导：三个新号迁移的目标列已由旧 0010/0009/0008 同构加好，先登记名字，
// `d1 migrations apply` 才会跳过它们（否则 duplicate column 中断部署）。
export const LEDGER_BOOTSTRAP = [
  "0018_memory_weight_dimensions.sql",
  "0019_daily_log_affect_chord.sql",
  "0020_precious_status.sql"
];

// P8 迁移（migrations-p8/，文件末尾自带同事务记账；不进 migrations/）。
export const P8_SQL_FILES = [
  "0021_p8_memories_and_sidecars.sql",
  "0022_p8_daily_log_rebuild.sql",
  "0023_p8_baselines_rebuild.sql",
  "0024_p8_roleless_messages_shared.sql",
  "0025_p8_role_columns_cleanup.sql"
];

const D1_MIGRATIONS_DDL =
  "CREATE TABLE IF NOT EXISTS d1_migrations(\n\t\tid INTEGER PRIMARY KEY AUTOINCREMENT,\n\t\tname TEXT UNIQUE,\n\t\tapplied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL\n)";

// —— 纯函数：MAINTENANCE_MODE 契约（tests 直接覆盖） ——
//
// deploy 用 --keep-vars：不在 toml [vars] 里的远端 plain_text 变量会被保留。
// 所以该键**必须显式常驻** [vars]，且只接受 "true" / "false" 两个字面值：
// 缺键（远端旧值是保留还是无值，无法区分）或拼错都直接构建失败，
// 避免 stage 2 "删行解冻" 把服务永久锁在 503。
export function resolveMaintenanceMode(raw) {
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(
    `MAINTENANCE_MODE 必须在 wrangler.toml [vars] 显式声明为 "true" 或 "false"（当前: ${JSON.stringify(raw ?? null)}）。deploy 使用 --keep-vars：从 [vars] 删除该行不会清除远端旧值——上次推送的 "true" 会一直生效，服务会永久 503。stage 1 冻结 = 设 "true"；stage 2 解冻 = 显式改回 "false"（在 toml 里的键部署时总是覆盖远端同名值）；该行常驻不删。`
  );
}

// —— P8 验证标记（fail-closed） ——
//
// 账本齐全只证明"执行过"，不证明"验证过"。postVerify 第一次失败后 P8 五条可能已
// 全部记账，重推时若无机制兜底，classify 判 legacy-done 就会跳过 postVerify、把
// Worker 部署到坏库上。因此 postVerify **全部成功之后**由部署链写入这张持久标记表；
// "P8 五条已记账但缺标记"的库必须重跑 postVerify，失败即中止不部署。标记是单条
// CREATE TABLE（单语句事务），写失败/构建中断 → 下次构建看到缺标记 → 重跑
// postVerify（只读、幂等），天然安全。应用代码不读该表；线上升级后的库会比全新
// 部署多这一张表。
export const P8_VERIFICATION_TABLE = "p8_verification";

export function writeP8VerificationMarker(run, dbName) {
  run([
    "d1", "execute", dbName, "--remote", "--json", "-y", "--command",
    `CREATE TABLE IF NOT EXISTS ${P8_VERIFICATION_TABLE} (verified_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)`
  ]);
  console.log(`[p8-deploy] P8 验证标记已写入（${P8_VERIFICATION_TABLE} 表；此后 legacy-done 不再重验）`);
}

// —— 纯函数：状态识别（tests 直接覆盖） ——

export function classify({ tables, ledger, memoriesCols, dailyLogCols, baselinesCols, migrationNames }) {
  const unknown = (reason) => ({ state: "unknown", reason });
  const tableSet = new Set(tables);
  const has = (cols, name) => Array.isArray(cols) && cols.includes(name);

  if (tableSet.size === 0) return { state: "fresh", reason: "零表（全新库）" };

  if (!tableSet.has("d1_migrations")) {
    return unknown("有表但无迁移账本（d1_migrations）");
  }
  if (!Array.isArray(ledger)) {
    return unknown("账本存在但读取失败");
  }
  if (ledger.length === 0) {
    return unknown("账本为空但库里有表");
  }

  const universe = new Set([...OLD_LEDGER, ...LEDGER_BOOTSTRAP, ...P8_SQL_FILES, ...migrationNames]);
  for (const name of ledger) {
    if (!universe.has(name)) return unknown(`账本含未知迁移名 ${name}`);
  }

  const ledgerSet = new Set(ledger);
  const oldAll = OLD_LEDGER.every((name) => ledgerSet.has(name));
  if (oldAll) {
    // P8 完成只看 P8 五文件是否记账——不看普通迁移是否全齐：P8 之后新增的
    // 普通迁移（0026+）由 d1 migrations apply 续跑，绝不能因此把已完成库误判
    // 回"未完成"再撞 role_scope 判据（0025 已把旧形状清了）而拒绝部署。
    if (P8_SQL_FILES.every((name) => ledgerSet.has(name))) {
      // 账本齐全 ≠ 验证通过：p8Verified=false（无 p8_verification 标记表）时，
      // ensureD1Migrations 必须重跑 postVerify 才允许部署（fail-closed）。
      const p8Verified = tableSet.has(P8_VERIFICATION_TABLE);
      return {
        state: "legacy-done",
        p8Verified,
        reason: p8Verified
          ? "旧库已完成 P8 且验证标记在（新增普通迁移如有未应用，由 d1 migrations apply 续跑）"
          : "旧库 P8 五条已记账但缺验证标记——必须重跑 post-verify，未验证不部署"
      };
    }
    // P8 未完成：账本说旧分支，memories 就必须仍是旧形状（role_scope 只由
    // 0025（最后一个文件）清除，任何可恢复的中断态都保留它；daily_log/
    // baselines 可能已被 0022/0023 重建，不参与此判据——它们由 P8 文件自身的
    // fail-loud 与 post-verify 兜底）
    if (!has(memoriesCols, "role_scope")) {
      return unknown("账本为旧分支 0001–0010 且 P8 未完成，但 memories 已非旧形状（role_scope 缺失）");
    }
    return {
      state: "legacy-pending",
      reason: "旧 feat/memory-dimensions 库，P8 待执行（或上次构建中断，按账本续跑）"
    };
  }

  const freshLineage = ledger.every((name) => migrationNames.includes(name));
  if (freshLineage) {
    return {
      state: "current",
      reason: "全新部署谱系（已完成或中断待续，普通迁移续跑）"
    };
  }
  return unknown("账本与新旧两套迁移谱都不匹配");
}

// —— 纯函数：P8 完成后的期望账本（30 条） ——

export function expectedLedgerNames(migrationNames) {
  const expected = new Set([...OLD_LEDGER, ...LEDGER_BOOTSTRAP, ...P8_SQL_FILES]);
  for (const name of migrationNames) expected.add(name);
  return [...expected].sort();
}

// —— 远端读通道（wrangler d1 execute --json，多语句逐条返回 results 数组） ——

function queryJson(run, dbName, sql) {
  const result = run(
    ["d1", "execute", dbName, "--remote", "--json", "-y", "--command", sql],
    { capture: true }
  );
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`D1 探测输出不是 JSON（wangler --json 行为变化？）：${String(error).slice(0, 200)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`D1 探测输出不是结果数组：${typeof parsed}`);
  }
  for (const entry of parsed) {
    if (entry?.success !== true) throw new Error("D1 探测语句执行失败");
  }
  return parsed;
}

function probeDb(run, dbName) {
  const schema = queryJson(run, dbName, "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  const tables = schema[0].results.map((row) => String(row.name));
  if (!tables.includes("d1_migrations")) {
    return { tables, ledger: null, memoriesCols: null, dailyLogCols: null, baselinesCols: null };
  }
  const detail = queryJson(run, dbName, [
    "SELECT name FROM d1_migrations ORDER BY name",
    "SELECT name FROM pragma_table_info('memories')",
    "SELECT name FROM pragma_table_info('daily_log')",
    "SELECT name FROM pragma_table_info('long_term_baselines')"
  ].join(";"));
  return {
    tables,
    ledger: detail[0].results.map((row) => String(row.name)),
    memoriesCols: detail[1].results.map((row) => String(row.name)),
    dailyLogCols: detail[2].results.map((row) => String(row.name)),
    baselinesCols: detail[3].results.map((row) => String(row.name))
  };
}

// —— P8 迁移后专用校验（不再用旧库专用的 migration:inspect） ——

export const POST_VERIFY_SQL = [
  "SELECT name FROM d1_migrations ORDER BY name",
  "SELECT COUNT(*) AS bad FROM pragma_table_info('memories') WHERE name IN ('role_id','role_name','role_scope')",
  "SELECT COUNT(*) AS ok FROM pragma_table_info('memories') WHERE name IN ('fact_key','version_status','superseded_by','authored_by','response_tendency','emotional','recurrence','unresolved','weight')",
  "SELECT COUNT(*) AS bad FROM pragma_table_info('memory_lifecycle') WHERE name = 'role_scope'",
  "SELECT COUNT(*) AS bad FROM pragma_table_info('messages') WHERE name IN ('role_id','role_name')",
  "SELECT COUNT(*) AS bad FROM pragma_table_info('conversations') WHERE name IN ('role_id','role_name')",
  "SELECT COUNT(*) AS bad FROM pragma_table_info('daily_log') WHERE name = 'role_scope'",
  "SELECT COUNT(*) AS pkcols FROM pragma_table_info('daily_log') WHERE pk > 0",
  "SELECT COUNT(*) AS ok FROM pragma_table_info('daily_log') WHERE name IN ('source_message_ids','affect_chord')",
  "SELECT COUNT(*) AS bad FROM pragma_table_info('long_term_baselines') WHERE name IN ('role_scope','role_id','role_name')",
  "SELECT COUNT(*) AS bad FROM pragma_table_info('long_term_baseline_snapshots') WHERE name = 'role_scope'",
  "SELECT COUNT(*) AS bad FROM pragma_table_info('baseline_changelog') WHERE name IN ('role_scope','role_id','role_name')",
  "SELECT COUNT(*) AS present FROM sqlite_schema WHERE type='table' AND name='memory_changelog'",
  "SELECT COUNT(*) AS cursors FROM processing_cursors"
].join(";");

export function postVerify({ run, dbName, migrationNames, sql = POST_VERIFY_SQL }) {
  const entries = queryJson(run, dbName, sql);
  // 第 0 条是多行账本（全量 name）；其余每条是单行单值聚合
  const ledger = entries[0].results.map((row) => String(row.name));
  const value = (i, key) => Number(entries[i].results[0]?.[key] ?? -1);
  const failures = [];

  const expected = expectedLedgerNames(migrationNames);
  const missing = expected.filter((name) => !ledger.includes(name));
  if (missing.length > 0) {
    failures.push(`账本缺 ${missing.length} 条（期望全 ${expected.length}）：${missing.join("、")}`);
  }
  if (value(1, "bad") !== 0) failures.push(`memories 残留 role 列 ${value(1, "bad")}`);
  if (value(2, "ok") !== 9) failures.push(`memories 新列缺失（9 期望，实得 ${value(2, "ok")}）`);
  if (value(3, "bad") !== 0) failures.push("memory_lifecycle 残留 role_scope");
  if (value(4, "bad") !== 0) failures.push("messages 残留 role 列");
  if (value(5, "bad") !== 0) failures.push("conversations 残留 role 列");
  if (value(6, "bad") !== 0) failures.push("daily_log 残留 role_scope");
  if (value(7, "pkcols") !== 2) failures.push(`daily_log 主键列 ${value(7, "pkcols")} ≠ 2（namespace,date）`);
  if (value(8, "ok") !== 2) failures.push("daily_log 缺 source_message_ids/affect_chord");
  if (value(9, "bad") !== 0) failures.push("long_term_baselines 残留 role 列");
  if (value(10, "bad") !== 0) failures.push("snapshots 残留 role_scope");
  if (value(11, "bad") !== 0) failures.push("baseline_changelog 残留 role 列");
  if (value(12, "present") !== 0) failures.push("memory_changelog 应已弃置删除");
  if (value(13, "cursors") !== 0) failures.push(`processing_cursors 应清空（${value(13, "cursors")} 行）`);

  if (failures.length > 0) {
    throw new Error(`P8 post-verify 未通过：${failures.join("；")}`);
  }
}

// —— 主入口：ensureD1 的迁移阶段 ——

export function ensureD1Migrations({
  run,
  dbName,
  root,
  maintenance = false,
  migrationsDir,
  p8Dir
}) {
  const migDir = migrationsDir ?? join(root, "migrations");
  const p8 = p8Dir ?? join(root, "migrations-p8");
  const migrationNames = readdirSync(migDir).filter((f) => f.endsWith(".sql")).sort();

  const probe = probeDb(run, dbName);
  const verdict = classify({ ...probe, migrationNames });
  console.log(`[p8-deploy] 远端 D1 状态: ${verdict.state}（${verdict.reason}）`);

  if (verdict.state === "unknown") {
    throw new Error(`远端 D1 结构无法识别，按合同拒绝迁移与部署（不部署 Worker）。${verdict.reason}`);
  }

  if (maintenance) {
    if (verdict.state === "legacy-pending") {
      console.log(
        "[p8-deploy] MAINTENANCE_MODE=true：旧库升级推迟到解除维护的 stage 2 推送（本次只部署维护态 Worker 冻结写入）"
      );
    }
    console.log("[p8-deploy] MAINTENANCE_MODE=true：跳过全部 D1 变更（维护态发布）");
    return { outcome: "deferred", state: verdict.state };
  }

  if (verdict.state === "legacy-pending") {
    return upgradeLegacyDb({ run, dbName, migrationsDir: migDir, p8Dir: p8, migrationNames, probe });
  }

  // fail-closed 闸：P8 五条已记账但缺验证标记（post-verify 从未成功，或上次
  // 构建在"验过→写标记"之间中断）→ 账本齐全不得直接部署，必须重跑 post-verify；
  // 失败即中止，不部署 Worker。
  if (verdict.state === "legacy-done" && !verdict.p8Verified) {
    assertNoMigrationsBeyondP8(migrationNames);
    postVerify({ run, dbName, migrationNames });
    writeP8VerificationMarker(run, dbName);
    console.log("[p8-deploy] 缺验证标记的 legacy-done：post-verify 重验通过，标记已写入");
  }

  run(["d1", "migrations", "apply", dbName, "--remote"]);
  console.log(`[p8-deploy] 普通迁移完成（状态 ${verdict.state}）`);
  return { outcome: verdict.state === "fresh" ? "applied" : "noop", state: verdict.state };
}

// 守卫：migrations/ 编号 >0020（P8 保留 0021–0025）的文件不得进入旧库升级/重验
// 序列——0026+ 假定 P8 后形状，先于 0021–0025（或在对旧形状的验证期望里）出现
// 都会出错；等所有旧环境完成 P8 升级后再加入。
function assertNoMigrationsBeyondP8(migrationNames) {
  const beyondP8 = migrationNames.filter((name) => Number.parseInt(name, 10) > 20);
  if (beyondP8.length > 0) {
    throw new Error(
      `migrations/ 含编号 >0020 的文件（${beyondP8.join("、")}）：P8 保留 0021–0025，0026+ 假定 P8 后形状，不能在旧库升级序列（0021–0025 之前）应用。请先完成所有旧环境的 P8 升级再加入该文件，或确认其对旧形状安全后调整本守卫。`
    );
  }
}

function upgradeLegacyDb({ run, dbName, migrationsDir, p8Dir, migrationNames, probe }) {
  // 0. 守卫（见 assertNoMigrationsBeyondP8）
  assertNoMigrationsBeyondP8(migrationNames);

  // 1. 账本引导（幂等：只补缺失名；0018–0020 同构列已由旧 0010/0009/0008 加好）
  const ledgerSet = new Set(probe.ledger);
  const missingBootstrap = LEDGER_BOOTSTRAP.filter((name) => !ledgerSet.has(name));
  if (missingBootstrap.length > 0) {
    const values = missingBootstrap.map((name) => `('${name}')`).join(",");
    run([
      "d1", "execute", dbName, "--remote", "--json", "-y", "--command",
      `INSERT INTO d1_migrations (name) VALUES ${values}`
    ]);
    console.log(`[p8-deploy] 账本引导: ${missingBootstrap.length} 条（0018–0020 同构列已存在，防 duplicate column）`);
  } else {
    console.log("[p8-deploy] 账本引导已存在，跳过（构建中断恢复）");
  }

  // 2. 普通迁移中尚未应用的部分（wrangler 按账本名字跳过；0017 对旧形状表是静默 no-op，修复在 0023）
  run(["d1", "migrations", "apply", dbName, "--remote"]);
  console.log("[p8-deploy] 普通迁移已应用（新名 0006–0017）");

  // 3. P8 文件按序播放；按账本跳过已成功步骤（构建中断恢复不重复执行重建 SQL）
  const ledgerNow = new Set(probeDb(run, dbName).ledger);
  const pending = P8_SQL_FILES.filter((name) => !ledgerNow.has(name));
  for (const file of pending) {
    run(["d1", "execute", dbName, "--remote", "-y", "--file", join(p8Dir, file)]);
    console.log(`[p8-deploy] P8 迁移应用: ${file}（整文件事务，记账与数据同事务）`);
  }
  if (pending.length === 0) {
    console.log("[p8-deploy] P8 五文件均已记账，跳过（构建中断恢复）");
  }

  // 4. 迁移后专用校验（P0 §4 的远端轻量版；失败 = 构建中止，不部署 Worker）
  postVerify({ run, dbName, migrationNames });
  // 5. 验证标记：postVerify 全部成功之后才写（单语句事务；写失败 → 构建中止，
  //    下次构建看到缺标记会重验，安全）
  writeP8VerificationMarker(run, dbName);
  console.log("[p8-deploy] P8 post-verify 通过（账本齐全 / 无 role 列残留 / 目标形状正确 / 游标已清空）");
  return { outcome: "upgraded", state: "legacy-pending", p8Applied: pending };
}
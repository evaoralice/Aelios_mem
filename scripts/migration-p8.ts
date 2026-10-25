#!/usr/bin/env node
// =====================================================================
// P8 旧数据正式迁移 CLI 入口（离线 orchestrator）。
//
// 用法（源库路径显式传入；工具不读任何配置文件、不碰 wrangler）：
//   node --import tsx scripts/migration-p8.ts upgrade --source /tmp/aelios-latest.sql \
//     [--copy <副本路径>] [--report <报告路径>] [--force]
//
//   <源>：wrangler d1 export 的 .sql（内存还原，全程只读）或本地 .sqlite（readOnly）。
//   --copy/--report 缺省落 .migration-work/p8/（已 gitignore）。
//   副本 = **未脱敏**的一次性真实数据副本：本地敏感文件，不可提交、不可外发。
//   副本已存在时拒绝重跑（一次性），--force 才从源库重建。
//
// stdout 只打表名与数量（隐私口径同 P7）；namespace/冲突键/正文只进本地 JSON 报告。
// 退出码：0 = 升级+验收全过；1 = 拒绝（预检不过）/失败（中途或验收发现）。
// 线上执行手册见报告 runbook 节与 DEV.md（本工具不触网、不部署）。
// =====================================================================

import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { runP8Upgrade } from "./migration/p8";
import type { P8UpgradeReport } from "./migration/p8";

const WORK_DIR = ".migration-work/p8";

interface ParsedArgs {
  source: string;
  copy: string | null;
  report: string | null;
  force: boolean;
}

const USAGE = `用法:
  node --import tsx scripts/migration-p8.ts upgrade --source <旧库导出> [--copy <副本>] [--report <报告>] [--force]
  <旧库导出>：wrangler d1 export 的 .sql 或本地 .sqlite（全程只读）。
  --copy/--report 缺省落 ${WORK_DIR}/（gitignored）；副本为未脱敏一次性真实数据副本，属本地敏感文件。`;

function fail(message: string): never {
  throw new Error(`${message}\n\n${USAGE}`);
}

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { source: "", copy: null, report: null, force: false };
  const rest = argv.length > 0 && argv[0] === "upgrade" ? argv.slice(1) : argv;
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    const next = rest[i + 1];
    switch (flag) {
      case "--source":
        if (!next) fail("--source 需要一个路径");
        parsed.source = next;
        i++;
        break;
      case "--copy":
        if (!next) fail("--copy 需要一个路径");
        parsed.copy = next;
        i++;
        break;
      case "--report":
        if (!next) fail("--report 需要一个路径");
        parsed.report = next;
        i++;
        break;
      case "--force":
        parsed.force = true;
        break;
      default:
        fail(`未知参数: ${flag}`);
    }
  }
  if (!parsed.source) fail("缺少 --source（数据库路径由显式参数传入）");
  return parsed;
}

function timestamped(prefix: string, ext: string): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${prefix}-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.${ext}`;
}

function defaultWorkPath(name: string): string {
  mkdirSync(WORK_DIR, { recursive: true });
  return resolve(join(WORK_DIR, name));
}

export function printP8Summary(report: P8UpgradeReport): void {
  console.log(`[p8] 源: ${report.source.path} (${report.source.kind}, ${report.source.bytes} bytes)`);
  console.log(
    `[p8] 源库只读校验: sha256 前后一致=${report.source.unchanged}，计数一致=${JSON.stringify(report.source.counts_before) === JSON.stringify(report.source.counts_after)}`
  );
  console.log(
    `[p8] 副本（一次性，未脱敏，本地敏感）: ${report.copy.path}${report.copy.built ? "" : "（未构建）"}`
  );
  console.log(
    `[p8] 账本: 初始 ${report.upgrade.ledger_initial.length} 条；引导跳过 ${report.upgrade.ledger_bootstrap.length} 个（0018–0020 同构列已存在）`
  );
  console.log(
    `[p8] 部署序列: 应用 ${report.upgrade.migrations_applied.length} 个，同名跳过 ${report.upgrade.migrations_skipped_same_name.length} 个（0001–0005 与旧账本同名）`
  );
  console.log(`[p8] P8 迁移: 应用 ${report.upgrade.p8_files_applied.length} 个（${report.upgrade.p8_files_applied.length === 5 ? "0021–0025" : "未全部应用"}）`);
  const countsLine = Object.entries(report.counts.post)
    .filter(([t]) => t !== "d1_migrations")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([t, n]) => `${t}=${n}`)
    .join("  ");
  console.log(`[p8] 迁移后逐表行数: ${countsLine}`);
  console.log(
    `[p8] 孤儿侧车: pre ${report.fidelity.lifecycle.orphan_rows_pre} → post ${report.fidelity.lifecycle.orphan_rows_post}（6 条裁定只入报告不迁入，清单在本地报告）`
  );
  console.log(
    `[p8] 保真: findings=${report.fidelity.findings.length}${report.fidelity.findings.length > 0 ? `（${report.fidelity.findings.join("；")}）` : ""}`
  );
  console.log(
    `[p8] 结构: 表集合一致=${report.shape.tables_equal}，列 parity=${Object.values(report.shape.columns_parity).every(Boolean)}，索引一致=${report.shape.indexes_equal}，role 列残留=${report.shape.role_columns_remaining.length}`
  );
  console.log(`[p8] 账本终态: ${report.ledger_final.length} 条（期望 ${report.ledger_expected.length}）`);
  console.log(`[p8] 状态: ${report.status}${report.failure ? `（失败于 ${report.failure.step}）` : ""}`);
  console.log("[p8] 线上执行手册见报告 runbook 节与 DEV.md；本工具不触网、不部署");
}

async function main(): Promise<void> {
  const invoked =
    process.argv[1] !== undefined &&
    (() => {
      try {
        return fileURLToPath(import.meta.url) === realpathSync(process.argv[1] as string);
      } catch {
        return false;
      }
    })();
  if (!invoked) return;

  const parsed = parseArgs(process.argv.slice(2));
  const sourceBase = basename(parsed.source).replace(/\.[^.]+$/, "");
  const copyPath = parsed.copy ?? defaultWorkPath(`${sourceBase}.upgrade.sqlite`);
  // 显式 --copy 时确保父目录存在（缺省路径已由 defaultWorkPath 创建）
  mkdirSync(dirname(copyPath), { recursive: true });
  const result = await runP8Upgrade({ sourcePath: parsed.source, copyPath, force: parsed.force });
  if (result.status === "refused") {
    console.error(`[p8] 拒绝执行: ${result.reason}`);
    process.exitCode = 1;
    return;
  }
  const report = result.report;
  const defaultPath = defaultWorkPath(
    timestamped(`${sourceBase}.upgrade`, "report.json")
  );
  const outPath = resolve(parsed.report ?? defaultPath);
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  printP8Summary(report);
  console.log(`[p8] 报告: ${outPath}`);
  process.exitCode = result.status === "ok" && report.status === "upgraded" ? 0 : 1;
}

main().catch((error) => {
  console.error(`[migration-p8] 失败: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
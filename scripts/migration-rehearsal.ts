#!/usr/bin/env node
// =====================================================================
// P7 迁移预演工具（CLI 入口）。
//
// 用法（数据库路径一律显式传入；工具不读任何配置文件、不碰 wrangler）：
//   默认 dry-run（inspect，零写入）：
//     node --import tsx scripts/migration-rehearsal.ts inspect --source <旧库文件>
//   副本演练（只写脱敏副本与其 .meta.json，绝不写源库）：
//     node --import tsx scripts/migration-rehearsal.ts rehearse \
//       --source <旧库文件> [--copy <副本.sqlite>] [--allow ns1,ns2] [--force-rebuild]
//
//   <旧库文件>：D1 导出 .sql（wrangler d1 export 的产物，内存还原，不落盘）
//              或本地 SQLite 文件（readOnly 打开）。
//   --copy/--report 缺省时一律落在 ./.migration-work/（已加入 .gitignore），
//   副本默认名 = <源文件名>.copy.sqlite，报告带时间戳。
//   --allow：部署 identity 的 namespace 清单（逗号分隔），启用白名单审计。
//
// stdout 只打表名与数量（隐私收口）：namespace/role_scope/角色名/冲突键/
// allowlist 值一律只进本地 JSON 报告。
// **副本与报告即使经掩码仍属本地敏感文件：不得提交仓库、不得外发。**
//
// 退出码：0 = 完成；1 = 参数错误 / 源不可读 / 形状偏离（rehearse 拒绝）/
//         副本漂移等操作性失败。冲突、孤儿、超界值是"发现"不是"失败"，
//         不影响退出码——它们进报告等裁定。
// 本包不编写正式迁移 SQL（P8 的 0021+ 另写），也不触碰运行期逻辑。
// =====================================================================

import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, realpathSync } from "node:fs";
import { collectInspectStats } from "./migration/inspect";
import {
  detectSourceKind,
  listTables,
  openSource,
  sha256File,
  tableCount
} from "./migration/dbio";
import { runRehearse } from "./migration/rehearse";
import type { RehearseOptions } from "./migration/rehearse";
import {
  deriveInspectSections,
  printInspectSummary,
  printRehearseSummary,
  writeReportFile,
  TOOL_VERSION
} from "./migration/report";
import type { InspectReport } from "./migration/report";
import { SENSITIVITY_NOTE } from "./migration/schema";

// 统一输出目录：默认副本/报告只落这里（.gitignore 已忽略），不进可跟踪目录。
export const WORK_DIR = ".migration-work";

interface ParsedArgs {
  subcommand: string;
  source: string | null;
  copy: string | null;
  report: string | null;
  allow: string[] | null;
  forceRebuild: boolean;
}

const USAGE = `用法:
  node --import tsx scripts/migration-rehearsal.ts inspect  --source <旧库文件> [--report <路径>]
  node --import tsx scripts/migration-rehearsal.ts rehearse --source <旧库文件> [--copy <副本文件>]
        [--allow ns1,ns2,...] [--report <路径>] [--force-rebuild]
  不带子命令时默认 inspect（dry-run，零写入）。
  --copy/--report 缺省时落在 ${WORK_DIR}/（gitignored）；副本与报告属本地敏感文件，不可提交或外发。`;

function fail(message: string): never {
  // 只抛错不设 exitCode：本模块会被测试 import，退出码由 CLI 入口决定。
  throw new Error(`${message}\n\n${USAGE}`);
}

export function parseArgs(argv: string[]): ParsedArgs {
  // 不带子命令或第一个参数就是 flag 时，默认 inspect（dry-run，零写入）。
  const hasSubcommand = argv.length > 0 && !argv[0].startsWith("--");
  const subcommand = hasSubcommand ? argv[0] : "inspect";
  const rest = hasSubcommand ? argv.slice(1) : argv;
  if (subcommand !== "inspect" && subcommand !== "rehearse") {
    fail(`未知子命令: ${subcommand}`);
  }
  const parsed: ParsedArgs = {
    subcommand,
    source: null,
    copy: null,
    report: null,
    allow: null,
    forceRebuild: false
  };
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
      case "--allow":
        if (!next) fail("--allow 需要逗号分隔的 namespace 清单");
        parsed.allow = next.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
        i++;
        break;
      case "--force-rebuild":
        parsed.forceRebuild = true;
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

// 缺省输出统一进 ./.migration-work/（不进可跟踪目录；显式路径优先）。
function defaultWorkPath(name: string): string {
  mkdirSync(WORK_DIR, { recursive: true });
  return resolve(join(WORK_DIR, name));
}

export async function runInspect(sourcePath: string, reportPath: string | null): Promise<number> {
  const abs = resolve(sourcePath);
  const kind = detectSourceKind(abs);
  const shaBefore = await sha256File(abs);
  const handle = openSource(abs, kind);
  let report: InspectReport;
  const countsBefore: Record<string, number> = {};
  const countsAfter: Record<string, number> = {};
  try {
    for (const table of listTables(handle.db)) countsBefore[table] = tableCount(handle.db, table);
    const inspection = collectInspectStats(handle.db);
    for (const table of listTables(handle.db)) countsAfter[table] = tableCount(handle.db, table);
    const sections = deriveInspectSections(inspection);
    report = {
      tool: "aelios-migration-rehearsal",
      tool_version: TOOL_VERSION,
      mode: "inspect",
      generated_at: new Date().toISOString(),
      sensitivity_note: SENSITIVITY_NOTE,
      source: {
        path: abs,
        kind,
        sha256_before: shaBefore,
        sha256_after: shaBefore, // 占位，关闭源后重新哈希再填
        unchanged: true,
        bytes: 0,
        counts_before: countsBefore,
        counts_after: countsAfter
      },
      inspection,
      ...sections
    };
  } finally {
    handle.db.close();
  }
  const shaAfter = await sha256File(abs);
  const { statSync } = await import("node:fs");
  report.source.sha256_after = shaAfter;
  report.source.unchanged = shaBefore === shaAfter;
  report.source.bytes = statSync(abs).size;

  const defaultPath = defaultWorkPath(
    timestamped(`${basename(abs).replace(/\.[^.]+$/, "")}.inspect`, "json")
  );
  const outPath = resolve(reportPath ?? defaultPath);
  writeReportFile(outPath, report);
  printInspectSummary(report);
  console.log(`[inspect] 报告: ${outPath}`);
  return report.inspection.migration_shape.shape_ok ? 0 : 1;
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
  if (parsed.subcommand === "inspect") {
    const code = await runInspect(parsed.source as string, parsed.report);
    process.exitCode = code;
    return;
  }

  // rehearse 缺省路径：副本与报告都落 ./.migration-work/（gitignored）。
  const sourceBase = basename(parsed.source as string).replace(/\.[^.]+$/, "");
  const copyPath = parsed.copy ?? defaultWorkPath(`${sourceBase}.copy.sqlite`);
  const options: RehearseOptions = {
    sourcePath: parsed.source as string,
    copyPath,
    forceRebuild: parsed.forceRebuild,
    allowNamespaces: parsed.allow
  };
  const result = await runRehearse(options);
  if (result.status === "refused") {
    console.error(`[rehearse] 拒绝执行: ${result.reason}`);
    process.exitCode = 1;
    return;
  }
  const report = result.report;
  const defaultPath = defaultWorkPath(
    timestamped(`${basename(report.copy.path).replace(/\.[^.]+$/, "")}.report`, "json")
  );
  writeReportFile(resolve(parsed.report ?? defaultPath), report);
  printRehearseSummary(report);
  const healthy =
    report.source.unchanged &&
    report.fidelity.findings.length === 0 &&
    report.conflicts.keys_consistent &&
    report.audit.scope_tables.every((a) => a.mismatches === a.awaiting_ruling) &&
    report.audit.follow_tables.every((a) => a.mismatches === 0);
  process.exitCode = healthy ? 0 : 1;
}

main().catch((error) => {
  console.error(`[migration-rehearsal] 失败: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
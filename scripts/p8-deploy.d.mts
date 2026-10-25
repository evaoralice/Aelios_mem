// scripts/p8-deploy.mjs 的类型声明（.mjs 本体被 setup-cloudflare.mjs 在 Node 直载，
// tests 经此声明获得类型；实现改动时保持同步）。

export interface DbVerdict {
  state: "fresh" | "legacy-pending" | "legacy-done" | "current" | "unknown";
  reason: string;
  /** 仅 legacy-done 有意义：p8_verification 标记表是否存在（false = 必须重跑 postVerify） */
  p8Verified?: boolean;
}

export interface ClassifyInput {
  tables: string[];
  ledger: string[] | null;
  memoriesCols: string[] | null;
  dailyLogCols: string[] | null;
  baselinesCols: string[] | null;
  migrationNames: string[];
}

export interface WranglerRunResult {
  status: number;
  stdout: string;
}

export type WranglerRunner = (
  args: string[],
  options?: { capture?: boolean; allowFailure?: boolean }
) => WranglerRunResult;

export interface EnsureD1MigrationsOptions {
  run: WranglerRunner;
  dbName: string;
  root?: string;
  maintenance?: boolean;
  migrationsDir?: string;
  p8Dir?: string;
}

export interface EnsureD1MigrationsResult {
  outcome: "applied" | "noop" | "deferred" | "upgraded";
  state: DbVerdict["state"];
  p8Applied?: string[];
}

export declare const OLD_LEDGER: string[];
export declare const LEDGER_BOOTSTRAP: string[];
export declare const P8_SQL_FILES: string[];
export declare const P8_VERIFICATION_TABLE: string;
export declare const POST_VERIFY_SQL: string;

export declare function classify(input: ClassifyInput): DbVerdict;
export declare function resolveMaintenanceMode(raw: string | null | undefined): boolean;
export declare function writeP8VerificationMarker(run: WranglerRunner, dbName: string): void;
export declare function expectedLedgerNames(migrationNames: string[]): string[];
export declare function postVerify(options: {
  run: WranglerRunner;
  dbName: string;
  migrationNames: string[];
  sql?: string;
}): void;
export declare function ensureD1Migrations(options: EnsureD1MigrationsOptions): EnsureD1MigrationsResult;
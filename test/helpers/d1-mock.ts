import { vi } from "vitest";

// Polyfill crypto.randomUUID for Node 18 test environment
const _gt = globalThis as any;
if (!_gt.crypto?.randomUUID) {
  _gt.crypto = {
    ..._gt.crypto,
    randomUUID: () => "00000000-0000-4000-8000-000000000000",
  };
}

/**
 * Mock D1Database for unit tests.
 *
 * Usage:
 *   const db = createMockD1({
 *     onQuery: (sql, args) => {
 *       if (sql.includes("SELECT ... FROM daily_log"))
 *         return [{ date: "2025-07-10", ... }, { date: "2025-07-09", ... }];
 *       return [];
 *     },
 *   });
 *
 * Conditions: binds can chain, first/all/run all work.
 */
type D1Row = Record<string, any>;

interface MockPreparedStatement {
  bind: (...vals: any[]) => MockPreparedStatement;
  first: <T = any>() => Promise<T | null>;
  all: <T = any>() => Promise<{ results: T[]; success: boolean; meta: any }>;
  run: () => Promise<{ success: boolean; meta: any }>;
  raw: <T = any>() => Promise<T[]>;
}

export interface MockD1Options {
  onQuery?: (sql: string, args: any[]) => D1Row[] | Promise<D1Row[]>;
  onRun?: (sql: string, args: any[]) => void | Promise<void>;
}

export function createMockD1(options: MockD1Options = {}): D1Database {
  function makeStatement(sql: string, args: any[] = []): MockPreparedStatement {
    return {
      bind: (...vals: any[]) => makeStatement(sql, vals),
      first: async <T = any>(): Promise<T | null> => {
        const rows = (await options.onQuery?.(sql, args)) ?? [];
        return (rows[0] as T) ?? null;
      },
      all: async <T = any>() => {
        const rows = (await options.onQuery?.(sql, args)) ?? [];
        return { results: rows as T[], success: true, meta: { changes: rows.length } };
      },
      run: async () => {
        await options.onRun?.(sql, args);
        return { success: true, meta: { changes: 1 } };
      },
      raw: async <T = any>(): Promise<T[]> => {
        const rows = (await options.onQuery?.(sql, args)) ?? [];
        return rows as T[];
      },
    };
  }

  return {
    prepare: (sql: string) => makeStatement(sql) as any,
    batch: vi.fn(),
    exec: vi.fn(),
    dump: vi.fn(),
  } as unknown as D1Database;
}

/**
 * Build a minimal mock Env with just what memory/ and db/ modules need
 * for D1-only tests (no Vectorize, no AI, no Queue).
 */
export function createMockEnv(db: D1Database, overrides: Record<string, any> = {}): any {
  return {
    DB: db,
    MEMORY_LIFECYCLE_ENABLED: "true",
    DREAM_NAMESPACE: "test",
    DREAM_MAX_RUNS: "1",
    ...overrides,
  };
}
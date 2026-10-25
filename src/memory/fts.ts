import { tokenizeForIndex } from "./queryShape";
import { cleanMessageText } from "../utils/sanitize";

const FTS_WRITE_ATTEMPTS = 3;

function isMissingFtsError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no such (table|module)|fts5/i.test(message);
}

export function toFtsBody(text: string): string {
  return tokenizeForIndex(text).join(" ");
}

export function toFtsMatch(tokens: string[]): string {
  const unique = [...new Set(tokens.map((token) => token.trim().toLowerCase()).filter((token) => token.length >= 2))];
  return unique
    .map((token) => `"${token.replace(/["*]/g, "")}"`)
    .filter((token) => token.length > 2)
    .slice(0, 12)
    .join(" OR ");
}

// 单条 FTS 写入的三态（P9-DS）：
//   indexed      —— 写入可搜索正文。
//   unindexable  —— 分词后为空（"..."、纯 emoji、单停用词）：写入 fts_body='' 的空标记行，
//                   让"不可索引"成为可重复识别的稳定终态——backfill 的 LEFT JOIN 不再
//                   每轮反复选中它；空标记无 token，任何 MATCH 都查不到，不参与搜索；
//                   内容以后更新成正常文本时，正常写入路径的 delete+insert 原样替换标记行。
//   failed       —— 真实写入失败，下次还会重试。
export type FtsWriteStatus = "indexed" | "unindexable" | "failed";

async function writeFtsRow(
  db: D1Database,
  table: "message_fts" | "memory_fts",
  idColumn: "message_id" | "memory_id",
  input: { namespace: string; id: string; body: string }
): Promise<FtsWriteStatus> {
  const body = input.body || "";
  try {
    await withRetry(async () => {
      await db.prepare(`DELETE FROM ${table} WHERE ${idColumn} = ?`).bind(input.id).run();
      await db
        .prepare(`INSERT INTO ${table} (fts_body, namespace, ${idColumn}) VALUES (?, ?, ?)`)
        .bind(body, input.namespace, input.id)
        .run();
    }, "fts index failed", { table, id: input.id });
    return input.body ? "indexed" : "unindexable";
  } catch (error) {
    if (!isMissingFtsError(error)) console.error("fts index failed", { table, id: input.id, error });
    return "failed";
  }
}

async function withRetry<T>(fn: () => Promise<T>, label: string, meta: Record<string, unknown>): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < FTS_WRITE_ATTEMPTS; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      if (isMissingFtsError(error) || attempt === FTS_WRITE_ATTEMPTS - 1) {
        if (!isMissingFtsError(error)) console.error(label, { ...meta, attempt: attempt + 1, error });
        break;
      }
    }
  }
  throw last;
}

export async function deleteFtsRow(
  db: D1Database,
  table: "message_fts" | "memory_fts",
  idColumn: "message_id" | "memory_id",
  id: string
): Promise<void> {
  try {
    await withRetry(
      () => db.prepare(`DELETE FROM ${table} WHERE ${idColumn} = ?`).bind(id).run(),
      "fts delete failed",
      { table, id }
    );
  } catch {
    // Search already falls back to LIKE; a stale row is worse than a missing one only if content changed.
  }
}

export async function upsertMessageFts(
  db: D1Database,
  input: { namespace: string; messageId: string; content: string }
): Promise<boolean> {
  const status = await writeFtsRow(db, "message_fts", "message_id", {
    namespace: input.namespace,
    id: input.messageId,
    body: toFtsBody(cleanMessageText(input.content))
  });
  return status === "indexed";
}

export async function upsertMemoryFts(
  db: D1Database,
  input: { namespace: string; memoryId: string; content: string }
): Promise<boolean> {
  const status = await writeFtsRow(db, "memory_fts", "memory_id", {
    namespace: input.namespace,
    id: input.memoryId,
    body: toFtsBody(input.content)
  });
  return status === "indexed";
}

export async function searchFtsIds(
  db: D1Database,
  table: "message_fts" | "memory_fts",
  idColumn: "message_id" | "memory_id",
  input: { namespace: string; tokens: string[]; limit: number }
): Promise<string[]> {
  const match = toFtsMatch(input.tokens);
  if (!match) return [];
  try {
    const result = await db
      .prepare(
        `SELECT ${idColumn} AS id FROM ${table}
         WHERE ${table} MATCH ? AND namespace = ?
         ORDER BY bm25(${table})
         LIMIT ?`
      )
      .bind(match, input.namespace, input.limit)
      .all<{ id: string }>();
    return (result.results ?? []).map((row) => row.id).filter(Boolean);
  } catch (rankedError) {
    if (isMissingFtsError(rankedError)) return [];
    try {
      const result = await db
        .prepare(
          `SELECT ${idColumn} AS id FROM ${table}
           WHERE ${table} MATCH ? AND namespace = ?
           LIMIT ?`
        )
        .bind(match, input.namespace, input.limit)
        .all<{ id: string }>();
      return (result.results ?? []).map((row) => row.id).filter(Boolean);
    } catch (error) {
      if (!isMissingFtsError(error)) console.error("fts search failed", { table, error, rankedError });
      return [];
    }
  }
}

export interface FtsBackfillResult {
  messagesIndexed: number;
  memoriesIndexed: number;
  messagesUnindexable: number;
  memoriesUnindexable: number;
  messageOrphansPurged: number;
  memoryOrphansPurged: number;
  failed: number;
  // 顶层失败（P9-DS；二轮补 orphan purge）：查询/清空/purge 删除挂了 → 无法证明
  // "没有待处理 / 表状态一致"，本次结果不得判成功。
  // 有 fatal 时 handler 必须返回 ok:false / converged:false。
  fatal: string | null;
}

function emptyFtsResult(fatal: string | null): FtsBackfillResult {
  return {
    messagesIndexed: 0,
    memoriesIndexed: 0,
    messagesUnindexable: 0,
    memoriesUnindexable: 0,
    messageOrphansPurged: 0,
    memoryOrphansPurged: 0,
    failed: 0,
    fatal
  };
}

async function indexMissingMessages(
  db: D1Database,
  input: { namespace?: string; limit: number }
): Promise<{ indexed: number; unindexable: number; failed: number }> {
  const scoped = Boolean(input.namespace);
  const sql = scoped
    ? `SELECT m.id, m.namespace, m.content
       FROM messages m
       LEFT JOIN message_fts f ON f.message_id = m.id
       WHERE m.namespace = ? AND f.message_id IS NULL
         AND m.role IN ('user', 'assistant')
       LIMIT ?`
    : `SELECT m.id, m.namespace, m.content
       FROM messages m
       LEFT JOIN message_fts f ON f.message_id = m.id
       WHERE f.message_id IS NULL AND m.role IN ('user', 'assistant')
       LIMIT ?`;
  const result = scoped
    ? await db.prepare(sql).bind(input.namespace, input.limit).all<{ id: string; namespace: string; content: string }>()
    : await db.prepare(sql).bind(input.limit).all<{ id: string; namespace: string; content: string }>();

  let indexed = 0;
  let unindexable = 0;
  let failed = 0;
  for (const row of result.results ?? []) {
    const status = await writeFtsRow(db, "message_fts", "message_id", {
      namespace: row.namespace,
      id: row.id,
      body: toFtsBody(cleanMessageText(row.content))
    });
    if (status === "indexed") indexed += 1;
    else if (status === "unindexable") unindexable += 1;
    else failed += 1;
  }
  return { indexed, unindexable, failed };
}

async function indexMissingMemories(
  db: D1Database,
  input: { namespace?: string; limit: number }
): Promise<{ indexed: number; unindexable: number; failed: number }> {
  const scoped = Boolean(input.namespace);
  const sql = scoped
    ? `SELECT m.id, m.namespace, m.content, m.summary
       FROM memories m
       LEFT JOIN memory_fts f ON f.memory_id = m.id
       WHERE m.namespace = ? AND f.memory_id IS NULL
         AND m.status = 'active'
       LIMIT ?`
    : `SELECT m.id, m.namespace, m.content, m.summary
       FROM memories m
       LEFT JOIN memory_fts f ON f.memory_id = m.id
       WHERE f.memory_id IS NULL AND m.status = 'active'
       LIMIT ?`;
  const result = scoped
    ? await db.prepare(sql).bind(input.namespace, input.limit).all<{ id: string; namespace: string; content: string; summary: string | null }>()
    : await db.prepare(sql).bind(input.limit).all<{ id: string; namespace: string; content: string; summary: string | null }>();

  let indexed = 0;
  let unindexable = 0;
  let failed = 0;
  for (const row of result.results ?? []) {
    const status = await writeFtsRow(db, "memory_fts", "memory_id", {
      namespace: row.namespace,
      id: row.id,
      body: toFtsBody(`${row.content}\n${row.summary ?? ""}`)
    });
    if (status === "indexed") indexed += 1;
    else if (status === "unindexable") unindexable += 1;
    else failed += 1;
  }
  return { indexed, unindexable, failed };
}

// FTS 单次 backfill 的硬上限（P9-DS 二轮）：writeFtsRow 最坏 3 次重试 × 每次
// (DELETE + INSERT) 两条 D1 语句 = 6 个子请求/行；单次 messages+memories 总上限
// 据此收紧为 100——最坏 ≈ 6×100 + 固定开销（2 次扫描 SELECT + 2 次 orphan DELETE）
// ≈ 604，明显低于 Workers 每请求 1000 的子请求上限。不做游标/队列/预算器，
// 传入更大的 limit 一律在此截断（scheduled cron 的 limit:400 同样生效为 100），
// 响应由 handler 报 requested_limit / effective_limit。
export const FTS_BACKFILL_MAX_LIMIT = 100;

export interface FtsPurgeResult {
  messages: number;
  memories: number;
  // 删除失败（P9-DS 二轮）：purge 也是写操作，挂了不得只 console.error 后照常
  // 报成功；backfillFts 把它并入顶层 fatal → ok:false / converged:false。
  fatal: string | null;
}

// orphan 清理只允许影响当前请求的 namespace（P9-DS 二轮）：跨 namespace 的
// orphan 行留给各自空间自己的 backfill，不做全局 DELETE。迁移残留（fts 行停在
// 旧 namespace）不是 orphan，不在这里处理——那是 rebuild 显式 namespace 时
// 两层清空子查询的职责，规则不变。
export async function purgeOrphanFts(db: D1Database, namespace: string): Promise<FtsPurgeResult> {
  let messages = 0;
  let memories = 0;
  try {
    const msg = await db.prepare(
      "DELETE FROM message_fts WHERE namespace = ? AND message_id NOT IN (SELECT id FROM messages)"
    ).bind(namespace).run();
    messages = msg.meta.changes ?? 0;
  } catch (error) {
    console.error("message fts orphan purge failed", error);
    return {
      messages,
      memories,
      fatal: `message_orphan_purge_failed: ${error instanceof Error ? error.message : String(error)}`
    };
  }
  try {
    const mem = await db.prepare(
      `DELETE FROM memory_fts WHERE namespace = ? AND memory_id NOT IN (SELECT id FROM memories WHERE status = 'active')`
    ).bind(namespace).run();
    memories = mem.meta.changes ?? 0;
  } catch (error) {
    console.error("memory fts orphan purge failed", error);
    return {
      messages,
      memories,
      fatal: `memory_orphan_purge_failed: ${error instanceof Error ? error.message : String(error)}`
    };
  }
  return { messages, memories, fatal: null };
}

export async function backfillFts(
  db: D1Database,
  input: { namespace?: string; limit?: number } = {}
): Promise<FtsBackfillResult> {
  // limit 是本次调用的总处理上限（messages + memories 共用一份，P9-DS），不是各一份：
  // 先 messages，用剩的额度再 memories；额度用完时本轮不碰 memories，
  // converged 由"本轮什么都没处理到"来证明，不会因跳过而误报。
  // 硬上限 100（FTS_BACKFILL_MAX_LIMIT）：请求更大的值一律截断。
  const limit = Math.min(Math.max(input.limit ?? FTS_BACKFILL_MAX_LIMIT, 1), FTS_BACKFILL_MAX_LIMIT);
  let messagesIndexed = 0;
  let messagesUnindexable = 0;
  let failed = 0;
  try {
    const messages = await indexMissingMessages(db, { namespace: input.namespace, limit });
    messagesIndexed = messages.indexed;
    messagesUnindexable = messages.unindexable;
    failed = messages.failed;
  } catch (error) {
    // 顶层 D1 查询失败：还有多少待处理未知，不得伪装成功——fatal 直接上报。
    console.error("message fts backfill failed", error);
    return emptyFtsResult(`messages_query_failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  let memoriesIndexed = 0;
  let memoriesUnindexable = 0;
  const remaining = Math.max(0, limit - (messagesIndexed + messagesUnindexable + failed));
  if (remaining > 0) {
    try {
      const memories = await indexMissingMemories(db, { namespace: input.namespace, limit: remaining });
      memoriesIndexed = memories.indexed;
      memoriesUnindexable = memories.unindexable;
      failed += memories.failed;
    } catch (error) {
      console.error("memory fts backfill failed", error);
      return {
        ...emptyFtsResult(null),
        messagesIndexed,
        messagesUnindexable,
        failed,
        fatal: `memories_query_failed: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }
  // orphan 清理只发生在有明确 namespace 的调用里，且只动当前 namespace 的行；
  // 没有明确 namespace 的路径直接跳过 purge——宁可不清，也不越界删（P9-DS 二轮）。
  const skippedPurge: FtsPurgeResult = { messages: 0, memories: 0, fatal: null };
  const purged = input.namespace ? await purgeOrphanFts(db, input.namespace) : skippedPurge;
  return {
    messagesIndexed,
    memoriesIndexed,
    messagesUnindexable,
    memoriesUnindexable,
    messageOrphansPurged: purged.messages,
    memoryOrphansPurged: purged.memories,
    failed,
    // purge 删除失败同样顶层失败：无法证明 fts 表处于一致状态，不得判成功。
    fatal: purged.fatal
  };
}

export async function rebuildFts(
  db: D1Database,
  input: { namespace?: string; limit?: number } = {}
): Promise<FtsBackfillResult> {
  try {
    if (input.namespace) {
      // 清两层（P9-DS）：本 namespace 的行 + D1 归属在本 namespace、fts 行却停在迁移前
      // 旧 namespace 的残留行（P8 改写过 D1 namespace，这类行 backfill 的 LEFT JOIN
      // 够不到、按 namespace 的 DELETE 也够不到，只能靠归属子查询清）。
      await db
        .prepare("DELETE FROM message_fts WHERE namespace = ? OR message_id IN (SELECT id FROM messages WHERE namespace = ?)")
        .bind(input.namespace, input.namespace)
        .run();
      await db
        .prepare("DELETE FROM memory_fts WHERE namespace = ? OR memory_id IN (SELECT id FROM memories WHERE namespace = ?)")
        .bind(input.namespace, input.namespace)
        .run();
    } else {
      await db.prepare("DELETE FROM message_fts").run();
      await db.prepare("DELETE FROM memory_fts").run();
    }
  } catch (error) {
    // 清空失败后不得继续 backfill 伪装成功（P9-DS）：直接 fatal 返回，本轮不重建任何行，
    // 下一轮 rebuild 从清空重新开始（DELETE 幂等）。
    console.error("fts rebuild truncate failed", error);
    return emptyFtsResult(`truncate_failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return backfillFts(db, input);
}

import { newId } from "../../utils/ids";
import { nowIso } from "../../utils/time";
import { SQLITE_BIND_BATCH_SIZE, uniqueStrings } from "./shared";

// =====================================================================
// L3 珍贵记录 precious (打标，含上下文，豁免去重/衰减/删)
// =====================================================================

export interface PreciousRow {
  id: string;
  namespace: string;
  content: string;
  context_message_ids: string | null;
  source: string;
  pinned: number;
  created_at: string;
  last_injected_at: string | null;
  status: string;
}

export interface CreatePreciousInput {
  namespace: string;
  content: string;
  contextMessageIds?: string[];
  source?: string;
}

export async function createPrecious(db: D1Database, input: CreatePreciousInput): Promise<PreciousRow> {
  const id = newId("pcz");
  const now = nowIso();
  const record: PreciousRow = {
    id,
    namespace: input.namespace,
    content: input.content,
    context_message_ids: JSON.stringify(input.contextMessageIds ?? []),
    source: input.source ?? "human",
    pinned: 1,
    created_at: now,
    last_injected_at: null,
    status: "active"
  };

  // status 不进 INSERT 列清单，走 0020 的 DB DEFAULT 'active'。
  await db
    .prepare(
      `INSERT INTO precious (id, namespace, content, context_message_ids, source, pinned, created_at, last_injected_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      record.id,
      record.namespace,
      record.content,
      record.context_message_ids,
      record.source,
      record.pinned,
      record.created_at,
      record.last_injected_at
    )
    .run();

  return record;
}

export async function getPreciousById(
  db: D1Database,
  input: { namespace: string; id: string }
): Promise<PreciousRow | null> {
  const row = await db
    .prepare("SELECT * FROM precious WHERE namespace = ? AND id = ? AND status = 'active'")
    .bind(input.namespace, input.id)
    .first<PreciousRow>();
  return row ?? null;
}

export async function listPrecious(
  db: D1Database,
  input: { namespace: string; limit: number }
): Promise<PreciousRow[]> {
  const limit = Math.min(Math.max(Math.floor(input.limit), 1), 200);
  const result = await db
    .prepare(
      `SELECT * FROM precious WHERE namespace = ? AND pinned = 1 AND status = 'active'
       ORDER BY created_at DESC LIMIT ?`
    )
    .bind(input.namespace, limit)
    .all<PreciousRow>();
  return result.results ?? [];
}

// P5-B: 软删——status='deleted' 行保留在 D1（迁移/核查/恢复），读路径只见 active；
// 已删行再次删除不命中（changes=0 → false，REST 404 未命中语义不变）。
export async function deletePrecious(
  db: D1Database,
  input: { namespace: string; id: string }
): Promise<boolean> {
  const r = await db
    .prepare("UPDATE precious SET status = 'deleted' WHERE namespace = ? AND id = ? AND status = 'active'")
    .bind(input.namespace, input.id)
    .run();
  return (r.meta?.changes ?? 0) > 0;
}

// 闸三：记 last_injected_at，近期注入过的降权 (不动 importance/pinned)。
export async function markPreciousInjected(
  db: D1Database,
  input: { namespace: string; ids: string[] }
): Promise<void> {
  const ids = uniqueStrings(input.ids);
  if (ids.length === 0) return;
  const stamp = nowIso();
  for (let i = 0; i < ids.length; i += SQLITE_BIND_BATCH_SIZE) {
    const batch = ids.slice(i, i + SQLITE_BIND_BATCH_SIZE);
    const placeholders = batch.map(() => "?").join(", ");
    await db
      .prepare(
        `UPDATE precious SET last_injected_at = ? WHERE namespace = ? AND id IN (${placeholders})`
      )
      .bind(stamp, input.namespace, ...batch)
      .run();
  }
}

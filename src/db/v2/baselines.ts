import { newId } from "../../utils/ids";
import { nowIso } from "../../utils/time";

// =====================================================================
// Baseline：当前 namespace 的稳定长期印象。
// 只由对话模型经 MCP baseline_change 主动提交修改，Dream 夜间把 pending
// 合并进旧 baseline；原子记忆不参与生成、重建或修正（见 plan 阶段 3）。
// 每个namespace 只有一行 current，历史进 snapshots。
// =====================================================================

export interface BaselineRow {
  namespace: string;
  content: string;
  version: number;
  generated_at: string;
}

export async function getBaseline(
  db: D1Database,
  input: { namespace: string }
): Promise<BaselineRow | null> {
  return db
    .prepare("SELECT namespace, content, version, generated_at FROM long_term_baselines WHERE namespace = ?")
    .bind(input.namespace)
    .first<BaselineRow>();
}

export async function upsertBaseline(
  db: D1Database,
  input: { namespace: string; content: string; snapshotKeep?: number }
): Promise<BaselineRow> {
  const now = nowIso();
  const existing = await db
    .prepare("SELECT content, version FROM long_term_baselines WHERE namespace = ?")
    .bind(input.namespace)
    .first<{ content: string; version: number }>();
  const version = (existing?.version ?? 0) + 1;

  // 先把上一版内容存进快照（仅当存在旧版；首次创建没有"上一版"）。
  // baseline 更新、快照写入、旧快照清理放同一次 batch：任一步失败整体回滚，
  // current baseline 不变，调用方（Dream 合并）可以安全重试。
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO long_term_baselines (namespace, content, version, generated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(namespace) DO UPDATE SET content = excluded.content, version = excluded.version, generated_at = excluded.generated_at`
      )
      .bind(input.namespace, input.content, version, now)
  ];
  if (existing) {
    statements.push(
      db
        .prepare(
          `INSERT INTO long_term_baseline_snapshots (id, namespace, version, content, created_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .bind(newId("snap"), input.namespace, existing.version, existing.content, now)
    );
  }
  const keep = Math.max(1, Math.floor(input.snapshotKeep ?? 7));
  statements.push(
    db
      .prepare(
        `DELETE FROM long_term_baseline_snapshots
         WHERE namespace = ?
         AND id NOT IN (
           SELECT id FROM long_term_baseline_snapshots
           WHERE namespace = ?
           ORDER BY created_at DESC, version DESC LIMIT ?
         )`
      )
      .bind(input.namespace, input.namespace, keep)
  );
  await db.batch(statements);

  return { namespace: input.namespace, content: input.content, version, generated_at: now };
}

// =====================================================================
// baseline_changelog —— pending 机制
// =====================================================================

export interface BaselineChangelogRow {
  id: string;
  namespace: string;
  op: "add" | "update" | "delete";
  before_content: string | null;
  after_content: string | null;
  reason: string;
  created_at: string;
  status: "pending" | "applied" | "conflict";
  error_message: string | null;
  applied_at: string | null;
}

export async function createBaselineChangelogEntry(
  db: D1Database,
  input: {
    namespace: string;
    op: "add" | "update" | "delete";
    beforeContent?: string | null;
    afterContent?: string | null;
    reason: string;
  }
): Promise<BaselineChangelogRow> {
  const id = newId("bch");
  const now = nowIso();
  await db
    .prepare(
      `INSERT INTO baseline_changelog (
        id, namespace, op, before_content, after_content, reason, created_at, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`
    )
    .bind(
      id,
      input.namespace,
      input.op,
      input.beforeContent ?? null,
      input.afterContent ?? null,
      input.reason,
      now
    )
    .run();
  return {
    id,
    namespace: input.namespace,
    op: input.op,
    before_content: input.beforeContent ?? null,
    after_content: input.afterContent ?? null,
    reason: input.reason,
    created_at: now,
    status: "pending",
    error_message: null,
    applied_at: null
  };
}

export async function listPendingBaselineChangelog(
  db: D1Database,
  input: { namespace: string; limit?: number }
): Promise<BaselineChangelogRow[]> {
  const limit = Math.min(input.limit ?? 50, 200);
  const result = await db
    .prepare(
      `SELECT * FROM baseline_changelog WHERE namespace = ? AND status = 'pending'
       ORDER BY created_at ASC LIMIT ?`
    )
    .bind(input.namespace, limit)
    .all<BaselineChangelogRow>();
  return result.results ?? [];
}

export async function markBaselineChangelogApplied(
  db: D1Database,
  input: { id: string }
): Promise<void> {
  await db
    .prepare("UPDATE baseline_changelog SET status = 'applied', applied_at = ?, error_message = NULL WHERE id = ?")
    .bind(nowIso(), input.id)
    .run();
}

export async function markBaselineChangelogConflict(
  db: D1Database,
  input: { id: string; errorMessage: string }
): Promise<void> {
  await db
    .prepare("UPDATE baseline_changelog SET status = 'conflict', error_message = ? WHERE id = ?")
    .bind(input.errorMessage, input.id)
    .run();
}

// 记录错误但保持 pending（临时故障，下次 Dream 重试）
export async function markBaselineChangelogError(
  db: D1Database,
  input: { id: string; errorMessage: string }
): Promise<void> {
  await db
    .prepare("UPDATE baseline_changelog SET error_message = ? WHERE id = ?")
    .bind(input.errorMessage, input.id)
    .run();
}

/**
 * 原子应用：baseline 新版本 + 上一版快照 + 快照清理 + 整组 pending 标 applied
 * 放进同一次 D1 batch。任一步失败整体回滚：baseline 不变、pending 保留，
 * 下次 Dream 重新合并同一批，不会出现"新 baseline 生效但 pending 残留"的半应用状态。
 */
export async function applyBaselineGroup(
  db: D1Database,
  input: {
    namespace: string;
    content: string;
    snapshotKeep?: number;
    pendingIds: string[];
  }
): Promise<BaselineRow> {
  const now = nowIso();
  const existing = await db
    .prepare("SELECT content, version FROM long_term_baselines WHERE namespace = ?")
    .bind(input.namespace)
    .first<{ content: string; version: number }>();
  const version = (existing?.version ?? 0) + 1;

  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO long_term_baselines (namespace, content, version, generated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(namespace) DO UPDATE SET content = excluded.content, version = excluded.version, generated_at = excluded.generated_at`
      )
      .bind(input.namespace, input.content, version, now)
  ];
  if (existing) {
    statements.push(
      db
        .prepare(
          `INSERT INTO long_term_baseline_snapshots (id, namespace, version, content, created_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .bind(newId("snap"), input.namespace, existing.version, existing.content, now)
    );
  }
  const keep = Math.max(1, Math.floor(input.snapshotKeep ?? 7));
  statements.push(
    db
      .prepare(
        `DELETE FROM long_term_baseline_snapshots
         WHERE namespace = ?
         AND id NOT IN (
           SELECT id FROM long_term_baseline_snapshots
           WHERE namespace = ?
           ORDER BY created_at DESC, version DESC LIMIT ?
         )`
      )
      .bind(input.namespace, input.namespace, keep)
  );
  for (const id of input.pendingIds) {
    statements.push(
      db
        .prepare(
          "UPDATE baseline_changelog SET status = 'applied', applied_at = ?, error_message = NULL WHERE id = ? AND status = 'pending'"
        )
        .bind(now, id)
    );
  }
  await db.batch(statements);

  return { namespace: input.namespace, content: input.content, version, generated_at: now };
}
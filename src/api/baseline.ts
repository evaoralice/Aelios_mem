import { authenticate } from "../auth/apiKey";
import { requireScope } from "../auth/scopes";
import {
  getBaselineChangelogById,
  listBaselineChangelog,
  markBaselineChangelogApplied,
  markBaselineChangelogConflict,
  reopenBaselineChangelog,
  type BaselineChangelogRow,
} from "../db/v2";
import type { Env } from "../types";
import { resolveNamespace } from "../utils/request";
import { json, openAiError } from "../utils/json";

const VALID_STATUSES = new Set(["pending", "applied", "conflict"]);

function parsePaging(value: unknown, fallback: number, max: number): number {
  const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : fallback;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.floor(n), 0), max);
}

function serializeRow(row: BaselineChangelogRow): Record<string, unknown> {
  return {
    id: row.id,
    namespace: row.namespace,
    role_scope: row.role_scope,
    role_id: row.role_id,
    role_name: row.role_name,
    op: row.op,
    before_content: row.before_content,
    after_content: row.after_content,
    reason: row.reason,
    status: row.status,
    error_message: row.error_message,
    created_at: row.created_at,
    applied_at: row.applied_at,
  };
}

// GET /v1/baseline_changelog
export async function handleBaselineChangelogList(request: Request, env: Env): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth.ok) return openAiError("Unauthorized", 401);
  const scopeError = requireScope(auth.profile, "memory:read");
  if (scopeError) return scopeError;

  const url = new URL(request.url);
  const namespace = resolveNamespace(auth.profile, url.searchParams.get("namespace"));

  const statusParam = url.searchParams.get("status");
  const status = statusParam && VALID_STATUSES.has(statusParam) ? (statusParam as "pending" | "applied" | "conflict") : undefined;

  const limit = parsePaging(url.searchParams.get("limit"), 50, 200);
  const offset = parsePaging(url.searchParams.get("offset"), 0, 100000);

  const rows = await listBaselineChangelog(env.DB, {
    namespace,
    status,
    roleScope: url.searchParams.get("role_scope") || undefined,
    limit,
    offset,
  });

  return json({
    data: rows.map(serializeRow),
    paging: { limit, offset, count: rows.length, has_more: rows.length === limit },
  });
}

// POST /v1/baseline_changelog/:id/apply
export async function handleBaselineChangelogApply(request: Request, env: Env, id: string): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth.ok) return openAiError("Unauthorized", 401);
  const scopeError = requireScope(auth.profile, "memory:write");
  if (scopeError) return scopeError;

  if (!id) return openAiError("Missing changelog id", 400);

  const url = new URL(request.url);
  const namespace = resolveNamespace(auth.profile, url.searchParams.get("namespace"));

  const row = await getBaselineChangelogById(env.DB, { namespace, id });
  if (!row) return openAiError("Baseline changelog entry not found", 404);
  if (row.status !== "pending") {
    return openAiError(`Entry already ${row.status}`, 409);
  }

  await markBaselineChangelogApplied(env.DB, { id });

  return json({
    data: { id, status: "applied", applied_at: new Date().toISOString() },
  });
}

// POST /v1/baseline_changelog/:id/conflict
export async function handleBaselineChangelogConflict(request: Request, env: Env, id: string): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth.ok) return openAiError("Unauthorized", 401);
  const scopeError = requireScope(auth.profile, "memory:write");
  if (scopeError) return scopeError;

  if (!id) return openAiError("Missing changelog id", 400);

  const url = new URL(request.url);
  const namespace = resolveNamespace(auth.profile, url.searchParams.get("namespace"));

  let body: { reason?: string } = {};
  try {
    body = (await request.json()) as { reason?: string };
  } catch {
    // body optional
  }
  const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : "Marked as conflict by admin";

  const row = await getBaselineChangelogById(env.DB, { namespace, id });
  if (!row) return openAiError("Baseline changelog entry not found", 404);
  if (row.status !== "pending") {
    return openAiError(`Entry already ${row.status}`, 409);
  }

  await markBaselineChangelogConflict(env.DB, { id, errorMessage: reason });

  return json({
    data: { id, status: "conflict", error_message: reason },
  });
}

// POST /v1/baseline_changelog/:id/reopen
// conflict → pending 回退，让做梦流程重新处理。用于 admin 标错 conflict 时恢复。
export async function handleBaselineChangelogReopen(request: Request, env: Env, id: string): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth.ok) return openAiError("Unauthorized", 401);
  const scopeError = requireScope(auth.profile, "memory:write");
  if (scopeError) return scopeError;

  if (!id) return openAiError("Missing changelog id", 400);

  const url = new URL(request.url);
  const namespace = resolveNamespace(auth.profile, url.searchParams.get("namespace"));

  const row = await getBaselineChangelogById(env.DB, { namespace, id });
  if (!row) return openAiError("Baseline changelog entry not found", 404);
  if (row.status !== "conflict") {
    return openAiError(`Entry is ${row.status}, only conflict entries can be reopened`, 409);
  }

  await reopenBaselineChangelog(env.DB, { id });

  return json({
    data: { id, status: "pending" },
  });
}
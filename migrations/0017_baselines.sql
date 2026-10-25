-- Baseline: namespace-owned long-term impression with version history and a pending-change queue.
-- Merges the old role_scope tables (0006, role-specific) into the v2 namespace model:
--   old namespace + role_scope=id:<role>  →  new namespace=<role> (assistant write space)
-- No role dimension here; the namespace IS the ownership key (see plan/Aelios-upstream-v2-baseline-integration.md).

CREATE TABLE IF NOT EXISTS long_term_baselines (
  namespace TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  generated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS long_term_baseline_snapshots (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_baseline_snapshots_namespace_created
ON long_term_baseline_snapshots(namespace, created_at);

-- Pending baseline changes submitted by the chat model via MCP baseline_change.
-- Dream merges each namespace's whole pending group nightly; failures keep the group pending.
CREATE TABLE IF NOT EXISTS baseline_changelog (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  op TEXT NOT NULL CHECK (op IN ('add', 'update', 'delete')),
  before_content TEXT,
  after_content TEXT,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'conflict')),
  error_message TEXT,
  applied_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_baseline_changelog_namespace_status
ON baseline_changelog(namespace, status, created_at);
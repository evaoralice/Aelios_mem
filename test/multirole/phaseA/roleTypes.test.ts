import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import type { MemoryRecord, MemoryApiRecord, MessageRecord, Conversation, MemoryLifecycleRow } from "../../../src/types";

describe("types.ts role fields (Phase A)", () => {
  it("MemoryRecord has role_id, role_name, role_scope", () => {
    const record: MemoryRecord = {
      id: "m1", namespace: "ns", type: "fact", content: "test",
      summary: null, importance: 0.7, confidence: 0.8,
      status: "active", pinned: 0, tags: null, source: null,
      source_message_ids: null, vector_id: null,
      last_recalled_at: null, recall_count: 0,
      created_at: "t", updated_at: "t", expires_at: null,
    };
    record.role_id = "alice-001";
    record.role_name = "Alice";
    record.role_scope = "id:alice-001";
    expect(record.role_id).toBe("alice-001");
    expect(record.role_name).toBe("Alice");
    expect(record.role_scope).toBe("id:alice-001");
  });

  it("MemoryApiRecord has optional role_id, role_name, role_scope", () => {
    const rec: MemoryApiRecord = {
      id: "m1", namespace: "ns", type: "fact", content: "test",
      summary: null, importance: 0.7, confidence: 0.8,
      status: "active", pinned: false, tags: [],
      source: null, source_message_ids: [], vector_id: null,
      last_recalled_at: null, recall_count: 0,
      created_at: "t", updated_at: "t", expires_at: null,
    };
    // Optional — should be undefined by default
    expect(rec.role_id).toBeUndefined();
    expect(rec.role_name).toBeUndefined();
    expect(rec.role_scope).toBeUndefined();
    // Can be set
    rec.role_id = "bob";
    rec.role_scope = "id:bob";
    expect(rec.role_id).toBe("bob");
    expect(rec.role_scope).toBe("id:bob");
  });

  it("MessageRecord has role_id, role_name", () => {
    const msg: MessageRecord = {
      id: "msg1", conversation_id: "c1", namespace: "ns",
      role: "user", content: "hi", source: "chatbox", created_at: "t",
    };
    msg.role_id = "alice-001";
    msg.role_name = "Alice";
    expect(msg.role_id).toBe("alice-001");
    expect(msg.role_name).toBe("Alice");
  });

  it("Conversation has role_id, role_name", () => {
    const conv: Conversation = {
      id: "ns:default", namespace: "ns", created_at: "t", updated_at: "t",
    };
    conv.role_id = "alice-001";
    conv.role_name = "Alice";
    expect(conv.role_id).toBe("alice-001");
    expect(conv.role_name).toBe("Alice");
  });

  it("MemoryLifecycleRow has role_scope", () => {
    const row: MemoryLifecycleRow = {
      memory_id: "m1", namespace: "ns", fact_key: "key1",
      supersedes_id: null, superseded_by_id: null,
      review_reason: null, valid_as_of: null,
      last_seen_at: null, seen_count: 0, last_injected_at: null,
    };
    row.role_scope = "id:alice-001";
    expect(row.role_scope).toBe("id:alice-001");
  });

  it("Env type includes role memory env vars", () => {
    const src = readFileSync(resolve(__dirname, "../../../src/types.ts"), "utf-8");
    expect(src).toMatch(/ROLE_MEMORY_ENABLED/);
    expect(src).toMatch(/RECALL_ROLE_BOOST_EXACT/);
    expect(src).toMatch(/RECALL_ROLE_BOOST_NAME/);
  });
});

describe("migration file exists (Phase A)", () => {
  it("0006_role_memory_baseline.sql exists and has expected tables", () => {
    const src = readFileSync(
      resolve(__dirname, "../../../migrations/0006_role_memory_baseline.sql"),
      "utf-8"
    );
    // Role columns on memories
    expect(src).toMatch(/ALTER TABLE memories ADD COLUMN role_id/);
    expect(src).toMatch(/ALTER TABLE memories ADD COLUMN role_name/);
    expect(src).toMatch(/ALTER TABLE memories ADD COLUMN role_scope/);
    // Role columns on messages
    expect(src).toMatch(/ALTER TABLE messages ADD COLUMN role_id/);
    expect(src).toMatch(/ALTER TABLE messages ADD COLUMN role_name/);
    // Role columns on conversations
    expect(src).toMatch(/ALTER TABLE conversations ADD COLUMN role_id/);
    // memory_lifecycle role_scope
    expect(src).toMatch(/ALTER TABLE memory_lifecycle ADD COLUMN role_scope/);
    // daily_log rebuild with role_scope PK
    expect(src).toMatch(/daily_log_v2/);
    expect(src).toMatch(/namespace, role_scope, date/);
    // New tables
    expect(src).toMatch(/CREATE TABLE IF NOT EXISTS memory_changelog/);
    expect(src).toMatch(/CREATE TABLE IF NOT EXISTS long_term_baselines/);
    expect(src).toMatch(/CREATE TABLE IF NOT EXISTS long_term_baseline_snapshots/);
    // Indexes
    expect(src).toMatch(/idx_memories_role_scope/);
    expect(src).toMatch(/idx_lifecycle_role_fact/);
    expect(src).toMatch(/idx_messages_role_created/);
    expect(src).toMatch(/idx_changelog_namespace_role_status/);
  });
});
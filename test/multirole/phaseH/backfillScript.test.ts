import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

describe("Phase H: backfill script exists", () => {
  it("backfill-vectorize-role.mjs exists and has expected structure", () => {
    const src = readFileSync(
      resolve(__dirname, "../../../scripts/backfill-vectorize-role.mjs"),
      "utf-8"
    );
    // Reads from D1
    expect(src).toMatch(/FROM memories/);
    expect(src).toMatch(/role_id/);
    expect(src).toMatch(/role_name/);
    expect(src).toMatch(/role_scope/);
    // Upserts to Vectorize
    expect(src).toMatch(/vectorize/i);
    expect(src).toMatch(/upsert/i);
    // Has dry run mode
    expect(src).toMatch(/DRY RUN/);
    expect(src).toMatch(/--apply/);
    // Defaults role_scope to shared
    expect(src).toMatch(/"shared"/);
  });
});

describe("Phase H: vectorMetadataToMemoryRecord defaults role_scope to shared", () => {
  it("missing role_scope in metadata defaults to 'shared'", async () => {
    const { vectorMetadataToMemoryRecord } = await import("../../../src/memory/vectorStore");
    const record = vectorMetadataToMemoryRecord({
      id: "mem_test1",
      metadata: {
        kind: "memory",
        namespace: "ns",
        ref_id: "test1",
        type: "fact",
        content: "test content",
        status: "active",
        importance: 0.5,
        confidence: 0.8,
        pinned: false,
        tags: "[]",
        source: "",
        source_message_ids: "[]",
        created_at: "t",
        updated_at: "t",
        expires_at: "",
        // No role_id, role_name, role_scope — should default
      },
    });
    expect(record).toBeTruthy();
    expect(record!.role_scope).toBe("shared");
    expect(record!.role_id).toBeNull();
    expect(record!.role_name).toBeNull();
  });

  it("reads role fields from metadata when present", async () => {
    const { vectorMetadataToMemoryRecord } = await import("../../../src/memory/vectorStore");
    const record = vectorMetadataToMemoryRecord({
      id: "mem_test2",
      metadata: {
        kind: "memory",
        namespace: "ns",
        ref_id: "test2",
        type: "fact",
        content: "test content",
        status: "active",
        importance: 0.5,
        confidence: 0.8,
        pinned: false,
        tags: "[]",
        source: "",
        source_message_ids: "[]",
        created_at: "t",
        updated_at: "t",
        expires_at: "",
        role_id: "alice-001",
        role_name: "Alice",
        role_scope: "id:alice-001",
      },
    });
    expect(record).toBeTruthy();
    expect(record!.role_id).toBe("alice-001");
    expect(record!.role_name).toBe("Alice");
    expect(record!.role_scope).toBe("id:alice-001");
  });
});
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

describe("memory_upsert tool description — fact_key clarity (Phase 3)", () => {
  const mcpSrc = readFileSync(resolve(__dirname, "../../src/api/mcp.ts"), "utf-8");

  it("fact_key field has a description explaining its dedup purpose", () => {
    // The fact_key property should have a description that explains what it does.
    // Look for the fact_key property inside the memory_upsert tool definition.
    const upsertSection = mcpSrc.match(/name:\s*"memory_upsert"[\s\S]*?required:\s*\["fact_key"/);
    expect(upsertSection).toBeTruthy();

    const section = upsertSection![0];
    // Should mention dedup or update (not just "string" type with no explanation)
    expect(section).toMatch(/fact_key[\s\S]*?description/);
    const factKeyDesc = section.match(/fact_key:[\s\S]*?description:\s*"([^"]+)"/);
    expect(factKeyDesc).toBeTruthy();
    const desc = factKeyDesc![1].toLowerCase();
    expect(desc).toMatch(/dedup|update|reuse|same|duplicate|overwrite|existing/);
  });

  it("fact_key description includes naming examples", () => {
    const upsertSection = mcpSrc.match(/name:\s*"memory_upsert"[\s\S]*?required:\s*\["fact_key"/);
    expect(upsertSection).toBeTruthy();

    const section = upsertSection![0];
    // Should include examples like 'user_work_schedule' or similar
    expect(section).toMatch(/example/i);
    expect(section).toMatch(/user_|preference_|relationship_|fact_/i);
  });

  it("tool description encourages proactive use during conversation", () => {
    const upsertSection = mcpSrc.match(/name:\s*"memory_upsert"[\s\S]*?required:\s*\["fact_key"/);
    expect(upsertSection).toBeTruthy();

    const section = upsertSection![0];
    // Description is split across concatenated strings, check the full section.
    const descLower = section.toLowerCase();
    expect(descLower).toMatch(/proactive|during conversation|when the user|reveals/);
  });

  it("type enum is aligned with admin panel tabs + world_fact", () => {
    const upsertSection = mcpSrc.match(/name:\s*"memory_upsert"[\s\S]*?required:\s*\["fact_key"/);
    expect(upsertSection).toBeTruthy();

    const section = upsertSection![0];
    // Should list all 9 types: fact, event, preference, relationship, boundary, habit, decision, note, world_fact
    expect(section).toMatch(/fact.*event.*preference.*relationship.*boundary.*habit.*decision.*note.*world_fact/s);
  });
});

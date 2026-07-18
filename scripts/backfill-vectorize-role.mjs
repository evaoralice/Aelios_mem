#!/usr/bin/env node
/**
 * Vectorize role metadata 回填脚本
 *
 * 遍历 D1 memories 表，读每条记录的 role_id/role_name/role_scope，
 * 按对应 vector_id 重新 upsert Vectorize metadata。
 *
 * 用法:
 *   CLOUDFLARE_ACCOUNT_ID=... \
 *   CLOUDFLARE_API_TOKEN=... \
 *   D1_DATABASE_NAME=companion_memory_proxy \
 *   VECTORIZE_INDEX_NAME=memo-kb \
 *   node scripts/backfill-vectorize-role.mjs           # dry run
 *   node scripts/backfill-vectorize-role.mjs --apply    # 实际执行
 *
 * 未回填的向量 role_scope 缺失，召回时视为 shared（向后兼容）。
 */

import { sleep } from "./_sleep.mjs";

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || process.env.CF_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN;
const d1Name = process.env.D1_DATABASE_NAME || "companion_memory_proxy";
const vectorizeIndex = process.env.VECTORIZE_INDEX_NAME || "memo-kb";
const apply = process.argv.includes("--apply");
const batchSize = 100;

if (!accountId || !token) {
  console.error("Missing CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.");
  process.exit(1);
}

const headers = {
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
};

const d1Base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${d1Name}`;
const vecBase = `https://api.cloudflare.com/client/v4/accounts/${accountId}/vectorize/v2/indexes/${vectorizeIndex}`;

async function d1Query(sql, params = []) {
  const response = await fetch(`${d1Base}/query`, {
    method: "POST",
    headers,
    body: JSON.stringify({ sql, params }),
  });
  const json = await response.json();
  if (!json.success) {
    throw new Error(`D1 query failed: ${JSON.stringify(json.errors)}`);
  }
  return json.result?.[0]?.results ?? [];
}

async function vectorizeUpsert(vectors) {
  const response = await fetch(`${vecBase}/upsert`, {
    method: "POST",
    headers,
    body: JSON.stringify({ vectors }),
  });
  const json = await response.json();
  if (!json.success) {
    throw new Error(`Vectorize upsert failed: ${JSON.stringify(json.errors)}`);
  }
  return json;
}

async function vectorizeQueryByIds(ids) {
  // Vectorize doesn't have a direct "get by id" API, but we can use describe
  // to verify the vector exists. For backfill we just upsert with new metadata.
  return ids;
}

async function main() {
  console.log(`Vectorize role metadata backfill`);
  console.log(`  D1: ${d1Name}`);
  console.log(`  Vectorize: ${vectorizeIndex}`);
  console.log(`  Mode: ${apply ? "APPLY" : "DRY RUN (use --apply to execute)"}`);
  console.log("");

  // Step 1: Read all memories with role fields from D1
  console.log("Step 1: Reading memories from D1...");
  const memories = await d1Query(`
    SELECT id, namespace, type, content, summary, importance, confidence,
           status, pinned, tags, source, source_message_ids, vector_id,
           created_at, updated_at, expires_at,
           role_id, role_name, role_scope
    FROM memories
    WHERE vector_id IS NOT NULL AND status IN ('active', 'superseded', 'deleted')
  `);

  console.log(`  Found ${memories.length} memories with vector_id`);

  if (memories.length === 0) {
    console.log("Nothing to backfill. Exiting.");
    return;
  }

  // Step 2: Group by namespace for batch processing
  const byNamespace = new Map();
  for (const mem of memories) {
    if (!byNamespace.has(mem.namespace)) byNamespace.set(mem.namespace, []);
    byNamespace.get(mem.namespace).push(mem);
  }
  console.log(`  ${byNamespace.size} namespaces`);

  // Step 3: For each memory, we need to re-upsert the vector with updated metadata.
  // Problem: we don't have the original embedding vectors in D1.
  // Solution: We use the Vectorize API to get existing vectors by ID,
  // then re-upsert with new metadata.
  // Vectorize's get-by-id API returns the vector values.

  let updated = 0;
  let skipped = 0;
  let errors = 0;

  for (let i = 0; i < memories.length; i += batchSize) {
    const batch = memories.slice(i, i + batchSize);
    console.log(`  Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(memories.length / batchSize)}...`);

    // Fetch existing vectors from Vectorize to get their values
    const vectorIds = batch.map((m) => m.vector_id);

    // Vectorize API: get vectors by IDs
    const vectorsToUpsert = [];
    for (const mem of batch) {
      try {
        // Query Vectorize by ID to get the existing vector values
        const queryResponse = await fetch(`${vecBase}/get`, {
          method: "POST",
          headers,
          body: JSON.stringify({ ids: [mem.vector_id] }),
        });
        const queryJson = await queryResponse.json();

        if (!queryJson.success || !queryJson.result?.vectors?.length) {
          console.warn(`    Skip ${mem.vector_id}: not found in Vectorize`);
          skipped++;
          continue;
        }

        const existingVector = queryJson.result.vectors[0];
        if (!existingVector.values) {
          console.warn(`    Skip ${mem.vector_id}: no values returned`);
          skipped++;
          continue;
        }

        // Build updated metadata with role fields
        const metadata = {
          kind: "memory",
          namespace: mem.namespace,
          ref_id: mem.id,
          type: mem.type || "note",
          content: mem.content || "",
          summary: mem.summary || "",
          importance: mem.importance ?? 0.5,
          confidence: mem.confidence ?? 0.8,
          status: mem.status || "active",
          pinned: Boolean(mem.pinned),
          tags: mem.tags || "[]",
          source: mem.source || "",
          source_message_ids: mem.source_message_ids || "[]",
          created_at: mem.created_at || "",
          updated_at: mem.updated_at || "",
          expires_at: mem.expires_at || "",
          role_id: mem.role_id || "",
          role_name: mem.role_name || "",
          role_scope: mem.role_scope || "shared",
        };

        vectorsToUpsert.push({
          id: mem.vector_id,
          namespace: mem.namespace,
          values: existingVector.values,
          metadata,
        });
      } catch (error) {
        console.error(`    Error fetching ${mem.vector_id}:`, error.message);
        errors++;
      }
    }

    if (vectorsToUpsert.length === 0) {
      continue;
    }

    if (apply) {
      try {
        await vectorizeUpsert(vectorsToUpsert);
        updated += vectorsToUpsert.length;
        console.log(`    Updated ${vectorsToUpsert.length} vectors`);
      } catch (error) {
        console.error(`    Upsert failed:`, error.message);
        errors += vectorsToUpsert.length;
      }
    } else {
      updated += vectorsToUpsert.length;
      console.log(`    [DRY RUN] Would update ${vectorsToUpsert.length} vectors`);
      // Show sample
      if (i === 0 && vectorsToUpsert[0]) {
        const sample = vectorsToUpsert[0].metadata;
        console.log(`    Sample metadata: role_id=${sample.role_id}, role_scope=${sample.role_scope}`);
      }
    }

    // Rate limit
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log("");
  console.log("=== Backfill Summary ===");
  console.log(`  Total memories: ${memories.length}`);
  console.log(`  ${apply ? "Updated" : "Would update"}: ${updated}`);
  console.log(`  Skipped: ${skipped}`);
  console.log(`  Errors: ${errors}`);

  if (!apply) {
    console.log("");
    console.log("This was a DRY RUN. Run with --apply to execute.");
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
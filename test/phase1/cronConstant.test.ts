import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Phase 1 requires DAILY_MAINTENANCE_CRON to change from "10 20 * * *"
 * (04:10 Singapore) to "0 19 * * *" (03:00 Singapore).
 *
 * Tests check:
 *   1. src/index.ts exports DAILY_MAINTENANCE_CRON as "0 19 * * *"
 *   2. wrangler.toml crons array has "0 19 * * *" (not "10 20 * * *")
 */
describe("cron constant — DAILY_MAINTENANCE_CRON", () => {
  it("index.ts exports DAILY_MAINTENANCE_CRON = '0 19 * * *'", () => {
    const src = readFileSync(resolve(__dirname, "../../src/index.ts"), "utf-8");

    // Should be exported (not just a local const).
    expect(src).toMatch(/export\s+const\s+DAILY_MAINTENANCE_CRON/);

    // Should have the new value.
    expect(src).toMatch(/DAILY_MAINTENANCE_CRON\s*=\s*["']0 19 \* \* \*["']/);

    // Should NOT have the old value anywhere.
    expect(src).not.toMatch(/["']10 20 \* \* \*["']/);
  });

  it("wrangler.toml uses '0 19 * * *' for the daily cron (not '10 20 * * *')", () => {
    const src = readFileSync(resolve(__dirname, "../../wrangler.toml"), "utf-8");

    // Should have the new cron.
    expect(src).toMatch(/["']0 19 \* \* \*["']/);

    // Should NOT have the old cron.
    expect(src).not.toMatch(/["']10 20 \* \* \*["']/);
  });

  it("wrangler.toml still has the 4-hourly extract cron", () => {
    const src = readFileSync(resolve(__dirname, "../../wrangler.toml"), "utf-8");
    expect(src).toMatch(/["']0 \*\/4 \* \* \*["']/);
  });
});
-- P2: four-dimension memory weight system (ported from old branch 0010_memory_weight_dimensions.sql).
-- importance (0001) already exists; this adds the three dims + the stored weight column.
-- Existing rows take D1 defaults 0.0 — identical to old 0010. Historical values arrive later via
-- the P8 data migration and are carried VERBATIM (P0 ruling: stored weight is never recomputed).
-- weight = round3(importance*0.35 + emotional*0.25 + recurrence*0.25 + unresolved*0.15),
-- computed at write time by src/extensions/memoryWeight.ts — the only authority for the formula.

ALTER TABLE memories ADD COLUMN emotional REAL NOT NULL DEFAULT 0.0;
ALTER TABLE memories ADD COLUMN recurrence REAL NOT NULL DEFAULT 0.0;
ALTER TABLE memories ADD COLUMN unresolved REAL NOT NULL DEFAULT 0.0;
ALTER TABLE memories ADD COLUMN weight REAL NOT NULL DEFAULT 0.0;
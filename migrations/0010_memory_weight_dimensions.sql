-- Add multi-dimensional weight system to memories.
-- Four dimensions (0-1 float): importance (existing), emotional, recurrence, unresolved.
-- weight = importance*0.35 + emotional*0.25 + recurrence*0.25 + unresolved*0.15, normalized to 0-1.
-- Computed at write time and stored for efficient querying.

ALTER TABLE memories ADD COLUMN emotional REAL NOT NULL DEFAULT 0.0;
ALTER TABLE memories ADD COLUMN recurrence REAL NOT NULL DEFAULT 0.0;
ALTER TABLE memories ADD COLUMN unresolved REAL NOT NULL DEFAULT 0.0;
ALTER TABLE memories ADD COLUMN weight REAL NOT NULL DEFAULT 0.0;

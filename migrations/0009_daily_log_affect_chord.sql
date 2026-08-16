-- Add affect_chord column to daily_log for chord-based emotion anchors.
-- Stores a single chord-progression line (e.g. "Fmaj9 → C/E → Am add9 → G6sus4 · 60bpm")
-- that captures the affective temperature of the day. Nullable; most days won't have one.

ALTER TABLE daily_log ADD COLUMN affect_chord TEXT;

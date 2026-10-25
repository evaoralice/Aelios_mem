-- P4 · daily_log 可选 affect_chord（和弦情绪锚点，plan 工作包 P4）。
-- 与旧分支 fix/logic-review 的 0009_daily_log_affect_chord.sql 同构
-- （线上已应用的是旧分支那套重号迁移，新分支一律另编 0019+，禁止直接播放旧号）。
-- 存一行和弦进行（如 "Fmaj9 → C/E → Am add9 → G6sus4 · 60bpm"）表达当日情绪温度。
-- 可空；多数日子没有。P8 迁移时旧值原样迁入本列（schema manifest §3.4）。

ALTER TABLE daily_log ADD COLUMN affect_chord TEXT;
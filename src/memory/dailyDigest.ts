import { listMessagesByNamespaceInRange } from "../db/messages";
import { listMemoriesPage } from "../db/memories";
import { readCursor, writeCursor } from "../db/retention";
import { callOpenAICompat } from "../proxy/openaiAdapter";
import type { Env, MemoryApiRecord, MessageRecord, OpenAIChatRequest, OpenAIChatResponse } from "../types";
import type { ExtractedMemory } from "./extract";
import {
  createVectorMemory,
  deleteVectorMemory,
  getVectorMemory,
  listVectorMemories,
  updateVectorMemory
} from "./vectorStore";
import { isV2Enabled } from "./v2/recall";
import { toMemoryApiRecord } from "./search";
import {
  upsertMemoryByFactKey,
  supersedeMemory,
  archiveMemory,
  upsertDigest,
  createLongtail,
  upsertDailyLog,
  upsertBaseline,
  fetchMemoryLifecycleRows,
  upsertLongtailEmbedding,
  listPendingChangelog,
  markChangelogApplied,
  markChangelogConflict,
  DIGEST_MAX_CHARS
} from "../db/v2";
import { computeRoleScope, isRoleMemoryEnabled } from "../utils/role";
import { newId } from "../utils/ids";
import { nowIso } from "../utils/time";

interface DigestMemoryUpdate {
  target_id: string;
  content?: string;
  type?: string;
  importance?: number;
  confidence?: number;
  tags?: string[];
}

interface DigestMemoryDelete {
  target_id: string;
  reason?: string;
}

interface ImportantExcerpt {
  quote: string;
  reason?: string;
  tags?: string[];
  source_message_ids?: string[];
}

interface DailyDigestResult {
  date?: string;
  title?: string;
  summary?: string;
  sections?: Array<{ heading?: string; content?: string }>;
  important_excerpts?: ImportantExcerpt[];
  memories_to_add?: ExtractedMemory[];
  memories_to_update?: DigestMemoryUpdate[];
  memories_to_delete?: DigestMemoryDelete[];
  baseline_texts?: Record<string, string>;
  groups?: Array<{
    role_scope: string;
    memories_to_update?: DigestMemoryUpdate[];
    memories_to_delete?: DigestMemoryDelete[];
  }>;
}

interface DailyDigestStats {
  date: string;
  mode: "dream";
  processedMessages: number;
  addedMemories: number;
  updatedMemories: number;
  deletedMemories: number;
  savedExcerpts: number;
  cleanedEmptyMemories: number;
  cursorAdvanced: boolean;
  hasMore: boolean;
}

type DailyDigestSkipReason =
  | "dream_disabled"
  | "already_done"
  | "no_messages"
  | "missing_model"
  | "model_error"
  | "model_invalid_json";

interface DailyDigestSkipped {
  ran: false;
  mode: "dream";
  date?: string;
  reason: DailyDigestSkipReason;
  startIso?: string;
  endIso?: string;
  cursor?: string | null;
  processedMessages?: number;
  model?: string;
  status?: number;
  finishReason?: string | null;
}

type DailyDigestRunResult = { ran: true; stats: DailyDigestStats } | DailyDigestSkipped;

interface DigestModelCallResult {
  digest: DailyDigestResult | null;
  reason?: Extract<DailyDigestSkipReason, "missing_model" | "model_error" | "model_invalid_json">;
  model?: string;
  status?: number;
  finishReason?: string | null;
}

const DEFAULT_MAX_MESSAGES = 40;
const DEFAULT_MEMORY_CONTEXT_LIMIT = 40;
const DEFAULT_EXCERPT_LIMIT = 8;
const DEFAULT_EMPTY_MEMORY_MIN_CHARS = 4;
const DEFAULT_TIME_ZONE = "Asia/Singapore";
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function isDreamEnabled(env: Env): boolean {
  const dreamFlag = readString(env.ENABLE_DREAM);
  if (dreamFlag) return dreamFlag !== "false";
  return env.ENABLE_DAILY_MEMORY_DIGEST !== "false";
}

function readDreamStrategy(env: Env): "legacy" | "upsert" | "review" {
  const raw = env.DREAM_STRATEGY;
  if (raw === "legacy" || raw === "review") return raw;
  return "upsert";
}

function readFirstEnvValue(...values: unknown[]): unknown {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function readDreamModel(env: Env): string | null {
  return readString(readFirstEnvValue(env.DREAM_MODEL, env.DAILY_DIGEST_MODEL, env.SUMMARY_MODEL));
}

function readDreamTimeZone(env: Env): string {
  return readString(readFirstEnvValue(env.DREAM_TIME_ZONE, env.DAILY_DIGEST_TIME_ZONE)) || DEFAULT_TIME_ZONE;
}

function readDreamMaxMessages(env: Env): number {
  return readPositiveInt(
    readFirstEnvValue(env.DREAM_MAX_MESSAGES, env.DAILY_DIGEST_MAX_MESSAGES),
    DEFAULT_MAX_MESSAGES,
    1000
  );
}

function readDreamMaxTokens(env: Env): number {
  return readPositiveInt(readFirstEnvValue(env.DREAM_MAX_TOKENS, env.DAILY_DIGEST_MAX_TOKENS), 3000, 8000);
}

function readDreamMemoryContextLimit(env: Env): number {
  return readPositiveInt(
    readFirstEnvValue(env.DREAM_MEMORY_CONTEXT_LIMIT, env.DAILY_DIGEST_MEMORY_CONTEXT_LIMIT),
    DEFAULT_MEMORY_CONTEXT_LIMIT,
    1000
  );
}

function readDreamExcerptLimit(env: Env): number {
  return readPositiveInt(readFirstEnvValue(env.DREAM_EXCERPT_LIMIT, env.DAILY_DIGEST_EXCERPT_LIMIT), DEFAULT_EXCERPT_LIMIT, 20);
}

function readPositiveInt(value: unknown, fallback: number, max: number): number {
  const parsed = typeof value === "string" ? Number(value) : typeof value === "number" ? value : fallback;
  const numeric = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(Math.max(Math.floor(numeric), 1), max);
}

function clampScore(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : fallback;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 3)}...`;
}

function formatDate(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function getTargetDigestDateLabel(timeZone: string, now = new Date()): string {
  return formatDate(new Date(now.getTime() - ONE_DAY_MS), timeZone);
}

function parseDateLabel(dateLabel: string): { year: number; month: number; day: number } {
  const [year, month, day] = dateLabel.split("-").map((value) => Number(value));
  if (!year || !month || !day) {
    throw new Error(`Invalid date label: ${dateLabel}`);
  }
  return { year, month, day };
}

function getTimeZoneOffsetMs(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(date);

  const values = new Map(parts.map((part) => [part.type, part.value]));
  const year = Number(values.get("year"));
  const month = Number(values.get("month"));
  const day = Number(values.get("day"));
  const hour = Number(values.get("hour")) % 24;
  const minute = Number(values.get("minute"));
  const second = Number(values.get("second"));
  const zonedAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);

  return zonedAsUtc - date.getTime();
}

function zonedWallTimeToUtc(input: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  timeZone: string;
}): Date {
  const wallClockUtc = Date.UTC(input.year, input.month - 1, input.day, input.hour, input.minute, input.second);
  let utc = wallClockUtc;

  for (let i = 0; i < 3; i += 1) {
    const offset = getTimeZoneOffsetMs(new Date(utc), input.timeZone);
    const next = wallClockUtc - offset;
    if (Math.abs(next - utc) < 1000) break;
    utc = next;
  }

  return new Date(utc);
}

function addDaysToDateLabel(dateLabel: string, days: number, timeZone: string): string {
  const { year, month, day } = parseDateLabel(dateLabel);
  const localNoonUtc = zonedWallTimeToUtc({
    year,
    month,
    day,
    hour: 12,
    minute: 0,
    second: 0,
    timeZone
  });
  return formatDate(new Date(localNoonUtc.getTime() + days * ONE_DAY_MS), timeZone);
}

function getDateRangeForLabel(dateLabel: string, timeZone: string): { startIso: string; endIso: string } {
  const start = parseDateLabel(dateLabel);
  const end = parseDateLabel(addDaysToDateLabel(dateLabel, 1, timeZone));

  return {
    startIso: zonedWallTimeToUtc({ ...start, hour: 0, minute: 0, second: 0, timeZone }).toISOString(),
    endIso: zonedWallTimeToUtc({ ...end, hour: 0, minute: 0, second: 0, timeZone }).toISOString()
  };
}

function readDailyCursor(value: string | null, startIso: string, endIso: string): { done: boolean; after: string | null } {
  if (!value) return { done: false, after: null };
  if (value.startsWith("done:")) return { done: true, after: null };
  if (value >= startIso && value < endIso) return { done: false, after: value };
  return { done: false, after: null };
}

function extractJsonObject(text: string): unknown | null {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // Some providers wrap JSON in prose; pull out the outermost object.
  }

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;

  try {
    return JSON.parse(text.slice(start, end + 1)) as unknown;
  } catch {
    return null;
  }
}

function normalizeExtractedMemory(value: unknown): ExtractedMemory | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const content = readString(raw.content);
  if (!content) return null;

  return {
    type: readString(raw.type) || "note",
    content,
    importance: clampScore(raw.importance, 0.7),
    confidence: clampScore(raw.confidence, 0.82),
    tags: readStringArray(raw.tags),
    source_message_ids: readStringArray(raw.source_message_ids),
    fact_key: typeof raw.fact_key === "string" && raw.fact_key.trim() ? raw.fact_key.trim() : undefined
  };
}

function normalizeDigestResult(value: unknown): DailyDigestResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;

  const sections = Array.isArray(raw.sections)
    ? raw.sections.flatMap((item): Array<{ heading?: string; content?: string }> => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const record = item as Record<string, unknown>;
        const heading = readString(record.heading) ?? undefined;
        const content = readString(record.content) ?? undefined;
        return heading || content ? [{ heading, content }] : [];
      })
    : undefined;

  const important_excerpts = Array.isArray(raw.important_excerpts)
    ? raw.important_excerpts.flatMap((item): ImportantExcerpt[] => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const record = item as Record<string, unknown>;
        const quote = readString(record.quote);
        if (!quote) return [];
        return [
          {
            quote,
            reason: readString(record.reason) ?? undefined,
            tags: readStringArray(record.tags),
            source_message_ids: readStringArray(record.source_message_ids)
          }
        ];
      })
    : undefined;

  const memories_to_update = Array.isArray(raw.memories_to_update)
    ? raw.memories_to_update.flatMap((item): DigestMemoryUpdate[] => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const record = item as Record<string, unknown>;
        const targetId = readString(record.target_id);
        if (!targetId) return [];
        return [
          {
            target_id: targetId,
            content: readString(record.content) ?? undefined,
            type: readString(record.type) ?? undefined,
            importance: typeof record.importance === "number" ? clampScore(record.importance, 0.7) : undefined,
            confidence: typeof record.confidence === "number" ? clampScore(record.confidence, 0.82) : undefined,
            tags: Array.isArray(record.tags) ? readStringArray(record.tags) : undefined
          }
        ];
      })
    : undefined;

  const memories_to_delete = Array.isArray(raw.memories_to_delete)
    ? raw.memories_to_delete.flatMap((item): DigestMemoryDelete[] => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const record = item as Record<string, unknown>;
        const targetId = readString(record.target_id);
        return targetId ? [{ target_id: targetId, reason: readString(record.reason) ?? undefined }] : [];
      })
    : undefined;

  // baseline_texts: { "shared": "...", "id:alice-001": "..." }
  const baseline_texts: Record<string, string> | undefined =
    raw.baseline_texts && typeof raw.baseline_texts === "object" && !Array.isArray(raw.baseline_texts)
      ? Object.fromEntries(
          Object.entries(raw.baseline_texts as Record<string, unknown>)
            .filter(([, v]) => typeof v === "string")
            .map(([k, v]) => [k, v as string])
        )
      : undefined;

  // groups: multi-role dream output
  const groups: DailyDigestResult["groups"] = Array.isArray(raw.groups)
    ? raw.groups.flatMap((item): NonNullable<DailyDigestResult["groups"]>[number][] => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const record = item as Record<string, unknown>;
        const roleScope = readString(record.role_scope);
        if (!roleScope) return [];
        const subUpdates = Array.isArray(record.memories_to_update)
          ? record.memories_to_update.flatMap((sub): DigestMemoryUpdate[] => {
              if (!sub || typeof sub !== "object" || Array.isArray(sub)) return [];
              const subRecord = sub as Record<string, unknown>;
              const targetId = readString(subRecord.target_id);
              if (!targetId) return [];
              return [{
                target_id: targetId,
                content: readString(subRecord.content) ?? undefined,
                type: readString(subRecord.type) ?? undefined,
                importance: typeof subRecord.importance === "number" ? clampScore(subRecord.importance, 0.7) : undefined,
                confidence: typeof subRecord.confidence === "number" ? clampScore(subRecord.confidence, 0.82) : undefined,
                tags: Array.isArray(subRecord.tags) ? readStringArray(subRecord.tags) : undefined,
              }];
            })
          : undefined;
        const subDeletes = Array.isArray(record.memories_to_delete)
          ? record.memories_to_delete.flatMap((sub): DigestMemoryDelete[] => {
              if (!sub || typeof sub !== "object" || Array.isArray(sub)) return [];
              const subRecord = sub as Record<string, unknown>;
              const targetId = readString(subRecord.target_id);
              return targetId ? [{ target_id: targetId, reason: readString(subRecord.reason) ?? undefined }] : [];
            })
          : undefined;
        return [{ role_scope: roleScope, memories_to_update: subUpdates, memories_to_delete: subDeletes }];
      })
    : undefined;

  // If groups present, flatten into memories_to_update/delete for backward-compatible applyDreamV2
  let flatUpdates = memories_to_update;
  let flatDeletes = memories_to_delete;
  if (groups && groups.length > 0) {
    flatUpdates = groups.flatMap((g) => g.memories_to_update ?? []);
    flatDeletes = groups.flatMap((g) => g.memories_to_delete ?? []);
  }

  return {
    date: readString(raw.date) ?? undefined,
    title: readString(raw.title) ?? undefined,
    summary: readString(raw.summary) ?? undefined,
    sections,
    important_excerpts,
    memories_to_add: Array.isArray(raw.memories_to_add)
      ? raw.memories_to_add.flatMap((item): ExtractedMemory[] => {
          const memory = normalizeExtractedMemory(item);
          return memory ? [memory] : [];
        })
      : undefined,
    memories_to_update: flatUpdates,
    memories_to_delete: flatDeletes,
    baseline_texts,
    groups,
  };
}

function formatTranscript(messages: MessageRecord[]): string {
  return messages
    .map((message) => {
      const role = message.role === "assistant" ? "我(助手)" : "用户";
      return `[${message.id}][${message.created_at}][${role}] ${truncate(message.content.trim(), 700)}`;
    })
    .join("\n\n");
}

function formatExistingMemories(memories: MemoryApiRecord[]): string {
  if (memories.length === 0) return "[]";
  return JSON.stringify(
    memories.map((memory) => ({
      id: memory.id,
      type: memory.type,
      content: truncate(memory.content, 260),
      importance: memory.importance,
      confidence: memory.confidence,
      pinned: memory.pinned,
      tags: memory.tags
    })),
    null,
    2
  );
}

function buildDigestPrompt(input: {
  dateLabel: string;
  startIso: string;
  endIso: string;
  messages: MessageRecord[];
  existingMemories: MemoryApiRecord[];
  excerptLimit: number;
  hasMore: boolean;
  roleGroups?: Array<{ role_scope: string; role_name: string | null; messages: MessageRecord[]; memories: MemoryApiRecord[] }>;
}): string {
  const hasRoleGroups = input.roleGroups && input.roleGroups.length > 0;
  return [
    "你是 Aelios 的 nightly dream 记忆整理器。你的任务不是简单总结，而是在用户休息时整理长期记忆。",
    "你会读取旧长期记忆和当天聊天 transcript，产出一份更干净、更一致、更有用的 memory store 整理计划。",
    "只输出 JSON，不要 markdown，不要解释，不要输出思考过程。",
    "",
    "Dream 目标：",
    "- 合并重复记忆，避免同一事实以多个版本长期存在。",
    "- 发现过时、被新信息否定、互相矛盾的旧记忆，并更新或删除。",
    "- 检查当天小批抽取已经入库的记忆和旧记忆之间是否重复、过时或冲突。",
    "- 保留关键原文摘录，重写一份简洁的 L1 摘要。",
    "- 形成下一次对话可直接使用的简洁记忆，而不是保存流水账。",
    "",
    "窗口：",
    `- 你只能处理 ${input.dateLabel} 这一天窗口内的聊天。窗口是 ${input.startIso} 到 ${input.endIso}。`,
    input.hasMore ? "- 这是当天的一批聊天，不是完整一天；只整理这一批里明确出现的信息。" : "- 这是当天最后一批或完整批次。",
    "",
    "总原则：",
    "- 原始聊天不要逐条变成记忆，只保留未来真的会用到的事实、偏好、边界、项目进展、承诺。",
    "- 宁可少记，也不要把临时语气、寒暄、重复话、空内容、调试内容写进长期记忆。",
    "- 当旧记忆和新信息冲突时，优先更新或删除旧记忆，不要并排留下互相打架的版本。",
    "- 当新信息只是旧记忆的更准确版本，优先 memories_to_update，不要 memories_to_add。",
    "- v2 的首次抽取已由每 4 小时 extractor 负责；memories_to_add 默认给空数组，不要把当天聊天首次抽取成新长期记忆。",
    "- 当多条旧记忆重复，保留更完整的一条并删除重复项；必要时先 update 保留项。",
    "- pinned=true 的旧记忆不能删除，只能在 memories_to_update 中提出更保守的补充。",
    "- 站在“我=助手”的视角写。关于用户，用“你……”；关于助手承诺，用“我需要……”。",
    "- 不要提到 D1、Vectorize、RAG、数据库、记忆系统、代理层等实现细节。",
    "",
    "Dream 输出格式：",
    "- title 是 12 字以内标题。",
    "- summary 写成分条列点格式（每条一行，用「- 」开头），概括今天发生了什么、整理了什么。整个 summary 控制在 800 字以内，每条简洁，不要写成一大段。",
    "- sections 最多 3 段，每段有 heading 和 content；没有必要可以给空数组。",
    `- important_excerpts 最多 ${input.excerptLimit} 条，quote 必须是值得保留的原文片段。`,
    "- memories_to_add 保留兼容字段，v2 下默认输出空数组。",
    "- memories_to_update 只针对给出的旧记忆 id。",
    "- memories_to_delete 只删除空、重复、明显过期或被新信息否定的旧记忆。",
    "- 控制总输出长度，宁可少写也不要输出超长 JSON。",
    "",
    "输出 JSON 结构：",
    hasRoleGroups
      ? JSON.stringify({
          groups: input.roleGroups!.map((g) => ({
            role_scope: g.role_scope,
            memories_to_update: [{ target_id: "mem_x", content: "…", type: "fact", importance: 0.8 }],
            memories_to_delete: [{ target_id: "mem_y", reason: "重复" }],
          })),
          summary: "- 分条列点日志…",
          baseline_texts: {
            shared: "整理后的共享基线文本",
            "id:alice-001": "Alice 专属基线文本",
          },
          important_excerpts: [{ quote: "原文", reason: "理由", tags: ["project"] }],
        })
      : JSON.stringify({
          date: input.dateLabel,
          title: "夜间整理",
          summary: "- 合并了 2 条重复的项目记忆\n- 更新了用户的作息偏好（从凌晨改为早起）\n- 删除了 1 条过时的调试记忆\n- 保留了 3 段关键原文",
          sections: [{ heading: "整理结果", content: "……" }],
          important_excerpts: [
            {
              quote: "用户或助手说过的关键原文",
              reason: "为什么值得保留",
              tags: ["project"],
              source_message_ids: ["msg_x"]
            }
          ],
          memories_to_add: [],
          memories_to_update: [
            {
              target_id: "mem_x",
              content: "更新后的旧记忆正文",
              type: "project",
              importance: 0.88,
              confidence: 0.9,
              tags: ["project"]
            }
          ],
          memories_to_delete: [{ target_id: "mem_y", reason: "空内容或重复" }]
        }),
    "",
    hasRoleGroups
      ? input.roleGroups!.map((g) =>
          [
            `=== [${g.role_scope === "shared" ? "共享" : g.role_name ?? g.role_scope}] ===`,
            "旧记忆：",
            formatExistingMemories(g.memories),
            "今日聊天：",
            formatTranscript(g.messages),
          ].join("\n")
        ).join("\n\n")
      : [
          "旧长期记忆候选：",
          formatExistingMemories(input.existingMemories),
          "",
          "今日原始聊天：",
          formatTranscript(input.messages),
        ].join("\n")
  ].join("\n");
}

async function callDigestModel(
  env: Env,
  prompt: string,
  meta: { dateLabel: string; messageCount: number; memoryCount: number; hasMore: boolean }
): Promise<DigestModelCallResult> {
  const model = readDreamModel(env);
  if (!model) {
    console.error("dream: missing model");
    return { digest: null, reason: "missing_model" };
  }

  const request: OpenAIChatRequest = {
    model,
    messages: [
      { role: "system", content: "你是严格的 JSON 生成器。你只输出 JSON，不要输出思考过程。" },
      { role: "user", content: prompt }
    ],
    temperature: 0,
    max_tokens: readDreamMaxTokens(env),
    response_format: {
      type: "json_object"
    },
    stream: false
  };

  const startedAt = Date.now();
  console.log("dream: calling model", {
    date: meta.dateLabel,
    model,
    messageCount: meta.messageCount,
    memoryCount: meta.memoryCount,
    hasMore: meta.hasMore,
    promptChars: prompt.length,
    maxTokens: request.max_tokens
  });

  try {
    const response = await callOpenAICompat(env, request);
    const elapsedMs = Date.now() - startedAt;
    if (!response.ok) {
      console.error("dream: model returned non-ok", {
        date: meta.dateLabel,
        model,
        status: response.status,
        statusText: response.statusText,
        elapsedMs
      });
      return { digest: null, reason: "model_error", model, status: response.status };
    }
    const parsed = (await response.json()) as OpenAIChatResponse;
    const choice = parsed.choices?.[0];
    const message = choice?.message as ({ content?: unknown; reasoning_content?: unknown }) | undefined;
    const content = typeof message?.content === "string" ? message.content.trim() : "";
    const reasoning = typeof message?.reasoning_content === "string" ? message.reasoning_content.trim() : "";
    const json = extractJsonObject(content || reasoning);
    if (!json) {
      console.error("dream: model returned invalid JSON", {
        date: meta.dateLabel,
        model,
        elapsedMs,
        finishReason: choice?.finish_reason ?? null,
        contentChars: content.length,
        reasoningChars: reasoning.length
      });
      return { digest: null, reason: "model_invalid_json", model, finishReason: choice?.finish_reason };
    }
    console.log("dream: model returned valid JSON", {
      date: meta.dateLabel,
      model,
      elapsedMs,
      finishReason: choice?.finish_reason ?? null,
      contentChars: content.length,
      reasoningChars: reasoning.length
    });
    return { digest: normalizeDigestResult(json), model };
  } catch (error) {
    console.error("dream model failed", {
      date: meta.dateLabel,
      model,
      elapsedMs: Date.now() - startedAt,
      error: error instanceof Error && error.message ? error.message : String(error)
    });
    return { digest: null, reason: "model_error", model };
  }
}

async function retireMemoryRecord(
  env: Env,
  input: { namespace: string; id: string }
): Promise<boolean> {
  if (isV2Enabled(env)) {
    const archived = await archiveMemory(env, input);
    if (archived) return true;
  }
  return deleteVectorMemory(env, input.id);
}

async function cleanEmptyMemories(
  env: Env,
  namespace: string
): Promise<number> {
  const minChars = readPositiveInt(env.EMPTY_MEMORY_MIN_CHARS, DEFAULT_EMPTY_MEMORY_MIN_CHARS, 20);
  let page: Awaited<ReturnType<typeof listVectorMemories>>;
  try {
    page = await listVectorMemories(env, { namespace, count: 1000 });
  } catch (error) {
    console.error("dream: failed to list memories for cleanup", error);
    return 0;
  }
  const records = page.data.filter((record) => !record.pinned && record.content.trim().length < minChars);

  for (const record of records) {
    await retireMemoryRecord(env, { namespace, id: record.id });
  }

  return records.length;
}

async function saveImportantExcerpts(
  env: Env,
  input: { namespace: string; dateLabel: string; excerpts: ImportantExcerpt[]; fallbackMessageIds: string[] }
): Promise<number> {
  let saved = 0;
  const limit = readDreamExcerptLimit(env);

  for (const excerpt of input.excerpts.slice(0, limit)) {
    const quote = readString(excerpt.quote);
    if (!quote) continue;
    const reason = readString(excerpt.reason);
    const summary = [`【${input.dateLabel} 重要原文】`, reason ? `保存原因：${reason}` : ""]
      .filter(Boolean)
      .join("｜");

    await createVectorMemory(env, {
      namespace: input.namespace,
      type: "excerpt",
      content: quote,
      summary,
      importance: 0.72,
      confidence: 0.9,
      tags: uniqueStrings(["important-excerpt", input.dateLabel, ...(excerpt.tags ?? [])]),
      source: "dream",
      sourceMessageIds: excerpt.source_message_ids?.length ? excerpt.source_message_ids : input.fallbackMessageIds
    });
    saved += 1;
  }

  return saved;
}

async function applyMemoryUpdates(
  env: Env,
  input: { namespace: string; updates: DigestMemoryUpdate[]; deletes: DigestMemoryDelete[] }
): Promise<{ updated: number; deleted: number }> {
  let updated = 0;
  let deleted = 0;

  for (const item of input.updates) {
    const existing = await getVectorMemory(env, item.target_id);
    if (!existing || existing.namespace !== input.namespace || existing.status !== "active") continue;

    const next = await updateVectorMemory(env, item.target_id, {
      type: item.type,
      content: item.content,
      importance: item.importance,
      confidence: item.confidence,
      tags: item.tags
    });

    if (next) updated += 1;
  }

  for (const item of input.deletes) {
    const existing = await getVectorMemory(env, item.target_id);
    if (!existing || existing.status !== "active" || existing.pinned) continue;
    await deleteVectorMemory(env, item.target_id);
    deleted += 1;
  }

  return { updated, deleted };
}

async function recordDreamReviewProposal(
  env: Env,
  input: { namespace: string; dateLabel: string; digest: DailyDigestResult; messageIds: string[] }
): Promise<void> {
  await env.DB
    .prepare(
      `INSERT INTO memory_events (id, namespace, event_type, memory_id, payload_json, created_at)
       VALUES (?, ?, ?, NULL, ?, ?)`
    )
    .bind(
      newId("evt"),
      input.namespace,
      "dream_review_proposal",
      JSON.stringify({
        date: input.dateLabel,
        message_ids: input.messageIds,
        title: input.digest.title ?? null,
        summary: input.digest.summary ?? null,
        memories_to_add: input.digest.memories_to_add ?? [],
        memories_to_update: input.digest.memories_to_update ?? [],
        memories_to_delete: input.digest.memories_to_delete ?? [],
        important_excerpts: input.digest.important_excerpts ?? []
      }),
      nowIso()
    )
    .run();
}

// Phase G: Apply pending changelog entries (code execution, no model needed)
async function applyPendingChanges(
  env: Env,
  namespace: string
): Promise<{ applied: number; conflicts: number }> {
  let applied = 0;
  let conflicts = 0;

  // Get all pending entries for this namespace (all role_scopes)
  const pending = await listPendingChangelog(env.DB, { namespace, limit: 100 });

  for (const entry of pending) {
    try {
      if (entry.op === "add") {
        const payload = JSON.parse(entry.payload_json);
        // changelog add payload has content/type/importance but no fact_key
        // use chg_<id> as fact_key for uniqueness (dedup within same changelog entry)
        await upsertMemoryByFactKey(env, {
          namespace,
          factKey: payload.fact_key || `chg_${entry.id}`,
          content: entry.after_content || payload.content || "",
          type: payload.type || "fact",
          importance: payload.importance ?? 0.6,
          source: "model",
          roleId: entry.role_id,
          roleName: entry.role_name,
        });
        await markChangelogApplied(env.DB, { id: entry.id });
        applied++;
      } else if (entry.op === "update") {
        const payload = JSON.parse(entry.payload_json);
        // Check target exists and is active
        const existing = await getVectorMemory(env, entry.target_id!);
        if (!existing || existing.status !== "active") {
          await markChangelogConflict(env.DB, { id: entry.id, errorMessage: "target not found or not active" });
          conflicts++;
          continue;
        }
        // Inherit role from target memory, not from changelog entry
        await supersedeMemory(env, {
          namespace,
          oldId: entry.target_id!,
          newContent: payload.content || entry.after_content || "",
          newType: payload.type || existing.type,
          source: "model",
          // supersedeMemory defaults to inheriting old memory's role when roleId/roleName not passed
        });
        await markChangelogApplied(env.DB, { id: entry.id });
        applied++;
      } else if (entry.op === "delete") {
        const existing = await getVectorMemory(env, entry.target_id!);
        if (!existing || existing.status !== "active") {
          await markChangelogConflict(env.DB, { id: entry.id, errorMessage: "target not found or not active" });
          conflicts++;
          continue;
        }
        // Delete inherits role from target — no role params needed
        await archiveMemory(env, { namespace, id: entry.target_id! });
        await markChangelogApplied(env.DB, { id: entry.id });
        applied++;
      }
    } catch (error) {
      await markChangelogConflict(env.DB, {
        id: entry.id,
        errorMessage: error instanceof Error ? error.message : "unknown error",
      });
      conflicts++;
    }
  }

  return { applied, conflicts };
}

async function applyDreamV2(
  env: Env,
  input: {
    namespace: string;
    strategy: "upsert" | "review";
    dateLabel: string;
    messages: MessageRecord[];
    digest: DailyDigestResult;
    messageIds: string[];
  }
): Promise<{ added: number; updated: number; deleted: number; excerpts: number; longtail: number }> {
  const { namespace, strategy, dateLabel, digest, messageIds } = input;
  const isReview = strategy === "review";
  const added = 0;
  let updated = 0, deleted = 0, longtailCount = 0;

  if (isReview) {
    await recordDreamReviewProposal(env, { namespace, dateLabel, digest, messageIds });
    return { added: 0, updated: 0, deleted: 0, excerpts: 0, longtail: 0 };
  }

  // v2 首次抽取由每 4 小时 extractor 负责；dream 只整理、更新、删除和写 L1/daily_log。
  for (const item of digest.memories_to_update ?? []) {
    const existing = await getVectorMemory(env, item.target_id);
    if (!existing || existing.namespace !== namespace || existing.status !== "active") continue;

    const lifecycleRows = await fetchMemoryLifecycleRows(env.DB, [existing.id]);
    const existingFactKey = lifecycleRows[0]?.fact_key ?? null;

    if (existingFactKey && item.content) {
      await upsertMemoryByFactKey(env, {
        namespace,
        factKey: existingFactKey,
        content: item.content,
        type: item.type,
        importance: item.importance,
        confidence: item.confidence,
        tags: item.tags,
        source: "dream",
        sourceMessageIds: messageIds,
        roleId: existing.role_id ?? null,
        roleName: existing.role_name ?? null,
      });
      updated++;
    } else if (item.content) {
      await supersedeMemory(env, {
        namespace,
        oldId: item.target_id,
        newContent: item.content,
        newType: item.type,
        reason: isReview ? "dream_review_proposal" : "dream_update",
        source: "dream",
      });
      updated++;
    }
  }

  for (const item of digest.memories_to_delete ?? []) {
    const existing = await getVectorMemory(env, item.target_id);
    if (!existing || existing.status !== "active" || existing.pinned) continue;

    const lt = await createLongtail(env.DB, { namespace, content: existing.content, sourceMessageIds: messageIds });
    await upsertLongtailEmbedding(env, { id: lt.id, namespace, content: existing.content });
    longtailCount++;

    const retired = await retireMemoryRecord(env, { namespace, id: item.target_id });
    if (retired) deleted++;
  }

  const excerpts = await saveImportantExcerpts(env, {
    namespace,
    dateLabel,
    excerpts: digest.important_excerpts ?? [],
    fallbackMessageIds: messageIds
  });

  if (digest.summary) {
    const digestContent = [
      digest.title ? `【${digest.title}】` : "",
      digest.summary,
      ...(digest.sections ?? []).map((s) => (s.heading ? `${s.heading}: ${s.content}` : s.content ?? ""))
    ]
      .filter(Boolean)
      .join("\n");
    await upsertDigest(env.DB, { namespace, content: truncate(digestContent, DIGEST_MAX_CHARS) });
  }

  await upsertDailyLog(env.DB, {
    namespace,
    date: dateLabel,
    title: digest.title ?? dateLabel,
    summary: digest.summary ?? "",
    // Write to shared scope by default; multi-role dream will write per-role separately
    roleScope: "shared",
  });

  // Phase F/G: Generate and save baseline texts from dream output (only when role memory enabled)
  const baselineTexts = isRoleMemoryEnabled(env) ? digest.baseline_texts : undefined;
  if (baselineTexts) {
    const maxPerRole = Number(env.BASELINE_MAX_CHARS_PER_ROLE ?? "2000");
    const maxTotal = Number(env.BASELINE_MAX_CHARS_TOTAL ?? "8000");
    let totalChars = 0;
    // Sort: shared first, then by role_scope
    const sortedEntries = Object.entries(baselineTexts).sort(([a], [b]) => {
      if (a === "shared") return -1;
      if (b === "shared") return 1;
      return a.localeCompare(b);
    });
    for (const [roleScope, content] of sortedEntries) {
      if (typeof content !== "string" || !content.trim()) continue;
      const truncated = content.slice(0, maxPerRole);
      if (totalChars + truncated.length > maxTotal) {
        // Skip if would exceed total cap (shared already prioritized first)
        console.warn(`dream: baseline for ${roleScope} skipped (total cap ${maxTotal} exceeded)`);
        continue;
      }
      totalChars += truncated.length;
      await upsertBaseline(env.DB, { namespace, roleScope, content: truncated });
    }
  }

  return { added, updated, deleted, excerpts, longtail: longtailCount };
}

export async function runDailyMemoryDigest(
  env: Env,
  namespace: string,
  options: { dateLabel?: string; force?: boolean } = {}
): Promise<DailyDigestRunResult> {
  if (!isDreamEnabled(env)) return { ran: false, mode: "dream", reason: "dream_disabled" };

  const timeZone = readDreamTimeZone(env);
  const dateLabel = readString(options.dateLabel) || getTargetDigestDateLabel(timeZone);
  const { startIso, endIso } = getDateRangeForLabel(dateLabel, timeZone);
  const cursorName = `dream:${namespace}:${dateLabel}`;
  const legacyCursorName = `daily_digest:${namespace}:${dateLabel}`;
  const cursor = (await readCursor(env.DB, cursorName)) ?? (await readCursor(env.DB, legacyCursorName));
  const cursorState = options.force ? { done: false, after: null } : readDailyCursor(cursor, startIso, endIso);
  if (cursorState.done) {
    return { ran: false, mode: "dream", date: dateLabel, reason: "already_done", startIso, endIso, cursor };
  }

  const maxMessages = readDreamMaxMessages(env);
  const messages = await listMessagesByNamespaceInRange(env.DB, {
    namespace,
    startCreatedAt: startIso,
    endCreatedAt: endIso,
    afterCreatedAt: cursorState.after,
    limit: maxMessages
  });
  if (messages.length === 0) {
    await writeCursor(env.DB, cursorName, `done:${cursorState.after ?? startIso}`);
    return { ran: false, mode: "dream", date: dateLabel, reason: "no_messages", startIso, endIso, cursor };
  }

  const lastMessage = messages[messages.length - 1];
  const hasMore = messages.length >= maxMessages;
  const memoryContextLimit = readDreamMemoryContextLimit(env);
  const strategy = readDreamStrategy(env);
  const v2Enabled = isV2Enabled(env);
  let existingMemories: MemoryApiRecord[] = [];
  try {
    if (v2Enabled && strategy !== "legacy") {
      const page = await listMemoriesPage(env.DB, {
        namespace,
        status: "active",
        limit: memoryContextLimit,
        offset: 0
      });
      existingMemories = page.records.map((record) => toMemoryApiRecord(record));
    } else {
      existingMemories = (await listVectorMemories(env, {
        namespace,
        count: memoryContextLimit
      })).data;
    }
  } catch (error) {
    console.error("dream: failed to list existing memories", error);
  }
  const cleanedEmptyMemories = v2Enabled && strategy === "review" ? 0 : await cleanEmptyMemories(env, namespace);

  // Phase G: Group messages by role_id for multi-role prompt
  let roleGroups: Array<{ role_scope: string; role_name: string | null; messages: MessageRecord[]; memories: MemoryApiRecord[] }> | undefined;
  if (isRoleMemoryEnabled(env)) {
    const messagesByRole = new Map<string | null, MessageRecord[]>();
    for (const msg of messages) {
      const key = msg.role_id ?? null;
      if (!messagesByRole.has(key)) messagesByRole.set(key, []);
      messagesByRole.get(key)!.push(msg);
    }
    const sharedMessages = messagesByRole.get(null) ?? [];
    if (messagesByRole.size > 1) {
      const maxRoles = Number(env.DREAM_MAX_ROLES_PER_RUN ?? "5");
      const roleEntries = [...messagesByRole.entries()]
        .filter(([k]) => k !== null)
        .slice(0, maxRoles);
      roleGroups = [];
      for (const [roleId, roleMsgs] of roleEntries) {
        const roleName = roleMsgs[0]?.role_name ?? null;
        const roleScope = computeRoleScope(roleId, roleName);
        const roleMemories = await listMemoriesPage(env.DB, { namespace, status: "active", limit: memoryContextLimit, offset: 0 });
        const roleMemRecords = roleMemories.records
          .map((r) => toMemoryApiRecord(r))
          .filter((m) => m.role_scope === roleScope || m.role_scope === "shared");
        roleGroups.push({
          role_scope: roleScope,
          role_name: roleName,
          messages: [...sharedMessages, ...roleMsgs],
          memories: roleMemRecords,
        });
      }
    }
  }

  const prompt = buildDigestPrompt({
    dateLabel,
    startIso,
    endIso,
    messages,
    existingMemories,
    excerptLimit: readDreamExcerptLimit(env),
    hasMore,
    roleGroups
  });
  const modelResult = await callDigestModel(env, prompt, {
    dateLabel,
    messageCount: messages.length,
    memoryCount: existingMemories.length,
    hasMore
  });
  const digest = modelResult.digest;
  if (!digest) {
    console.error("dream: model did not return valid JSON; cursor not advanced", {
      reason: modelResult.reason,
      model: modelResult.model,
      status: modelResult.status
    });
    return {
      ran: false,
      mode: "dream",
      date: dateLabel,
      reason: modelResult.reason ?? "model_error",
      startIso,
      endIso,
      cursor,
      processedMessages: messages.length,
      model: modelResult.model,
      status: modelResult.status,
      finishReason: modelResult.finishReason
    };
  }
  const messageIds = messages.map((message) => message.id);

  // v2 path: fact_key upsert + L1 digest + longtail + recent_logs
  if (v2Enabled && strategy !== "legacy") {
    // Phase G: Apply pending changelog entries first (only when role memory enabled)
    if (isRoleMemoryEnabled(env)) {
      const pendingResult = await applyPendingChanges(env, namespace);
      if (pendingResult.applied > 0 || pendingResult.conflicts > 0) {
        console.log("dream: applied pending changes", pendingResult);
      }
    }

    const v2Result = await applyDreamV2(env, {
      namespace,
      strategy,
      dateLabel,
      messages,
      digest,
      messageIds,
    });

    await writeCursor(env.DB, cursorName, hasMore ? lastMessage.created_at : `done:${lastMessage.created_at}`);

    return {
      ran: true,
      stats: {
        date: dateLabel,
        mode: "dream",
        processedMessages: messages.length,
        addedMemories: v2Result.added,
        updatedMemories: v2Result.updated,
        deletedMemories: v2Result.deleted,
        savedExcerpts: v2Result.excerpts,
        cleanedEmptyMemories,
        cursorAdvanced: true,
        hasMore
      }
    };
  }

  const updates = await applyMemoryUpdates(env, {
    namespace,
    updates: digest.memories_to_update ?? [],
    deletes: digest.memories_to_delete ?? []
  });

  let addedMemories = 0;
  for (const memory of digest.memories_to_add ?? []) {
    const saved = await createVectorMemory(env, {
      namespace,
      type: memory.type,
      content: memory.content,
      importance: memory.importance,
      confidence: memory.confidence,
      tags: memory.tags,
      source: "dream",
      sourceMessageIds: memory.source_message_ids.length ? memory.source_message_ids : messageIds
    });
    if (saved) addedMemories += 1;
  }

  const savedExcerpts = await saveImportantExcerpts(env, {
    namespace,
    dateLabel,
    excerpts: digest.important_excerpts ?? [],
    fallbackMessageIds: messageIds
  });

  await writeCursor(env.DB, cursorName, hasMore ? lastMessage.created_at : `done:${lastMessage.created_at}`);

  return {
    ran: true,
    stats: {
      date: dateLabel,
      mode: "dream",
      processedMessages: messages.length,
      addedMemories,
      updatedMemories: updates.updated,
      deletedMemories: updates.deleted,
      savedExcerpts,
      cleanedEmptyMemories,
      cursorAdvanced: true,
      hasMore
    }
  };
}

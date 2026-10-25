export interface Env {
  GATEWAY_CONFIG?: string;
  AI_GATEWAY_ID?: string;
  DB: D1Database;
  AI?: Ai;
  MEMORY_QUEUE?: Queue<QueueMessage>;
  VECTORIZE?: Vectorize | VectorizeIndex;
  VECTORIZE_INDEX_NAME?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
  PUBLIC_MODEL_NAME?: string;
  CHAT_MODEL?: string;
  DEFAULT_UPSTREAM_MODEL?: string;
  ALLOW_MODEL_PASSTHROUGH?: string;
  AI_GATEWAY_BASE_URL?: string;
  /** Comma-separated tool-definition fields to strip before every upstream send. */
  UPSTREAM_STRIP_TOOL_FIELDS?: string;
  // P6 · Anthropic adaptive thinking（策略在 src/extensions/adaptiveThinking.ts，messages 协议主模型生效）
  // auto/adaptive/manual/off；不填时走旧开关 ANTHROPIC_THINKING_ENABLED
  ANTHROPIC_THINKING_MODE?: string;
  // adaptive effort 强度 low/medium/high/xhigh/max，默认 high；不做 budget→effort 换算
  ANTHROPIC_THINKING_EFFORT?: string;
  // manual 预算 1024–32000，默认 1024
  ANTHROPIC_THINKING_BUDGET?: string;
  // 旧开关：true = 主模型默认开 thinking（按模型自动选 adaptive/manual）；仅 MODE 未填时生效
  ANTHROPIC_THINKING_ENABLED?: string;
  CHATBOX_API_KEY?: string;
  IM_API_KEY?: string;
  DEBUG_API_KEY?: string;
  MEMORY_MCP_API_KEY?: string;
  GUIDE_DOG_API_KEY?: string;
  CF_AIG_TOKEN?: string;
  ENABLE_DREAM?: string;
  // --- Aelios 记忆库 v2 行为开关 ---
  // 默认走 v2；只有显式 false 才回退旧路径。
  MEMORY_LIFECYCLE_ENABLED?: string;
  // dream 策略：默认 upsert，可显式 review。
  DREAM_STRATEGY?: string;
  // 闸三降权窗口 (分钟)，默认 30
  MEMORY_INJECT_DECAY_WINDOW_MIN?: string;
  // 闸三降权系数 (0-1)，默认 0.5
  MEMORY_INJECT_DECAY_FACTOR?: string;
  // memory_recall 最低分地板，默认 0.15；调用方可用 min_score 临时覆盖。
  // #37 后地板打在"原始相关性分"上 (降权前)，闸三只影响排序，不再把命中挤出地板。
  RECALL_MIN_SCORE?: string;
  // E 轴: 亲笔记忆 (authored_by 非空) 的排序加成倍数，默认 1.15。只影响排序，不影响地板。
  MEMORY_AUTHORED_BOOST?: string;
  // 跨 ns 召回时写入 ns 记忆的排序加成倍数（旧 RECALL_ROLE_BOOST 语义），默认 1.3；填 1 关闭。
  RECALL_ROLE_BOOST?: string;
  // baseline（角色长期印象）合并的目标软长度，超限 Dream 追加一次压缩请求，不硬截断。
  BASELINE_MAX_CHARS_PER_ROLE?: string;
  BASELINE_MAX_CHARS_TOTAL?: string;
  // baseline 历史快照保留版本数（默认 7）。
  BASELINE_SNAPSHOT_KEEP?: string;
  // pending baseline 变更回执注入上限（沿用旧 memory changelog 回执数值）。
  MEMORY_CHANGELOG_MAX_INJECT?: string;
  MEMORY_CHANGELOG_MAX_CHARS?: string;
  // true = 丢弃没有有效 D1 记录背书的 Vectorize 命中 (清理 legacy 孤儿向量)，默认 false 保持现状。
  RECALL_REQUIRE_D1_BACKING?: string;
  // #35 周块附带：命中记忆所在那一周的 weekly_log 整块随召回下发。默认开，"false" 关。
  RECALL_WEEK_BLOCKS?: string;
  // 一次召回最多附带几块周记，默认 2。块是上下文不是命中，不占 k 的名额。
  RECALL_WEEK_BLOCK_LIMIT?: string;
  // LMC-5 Y 轴: 2-hop relation expansion. Default off (undefined/"off"/"false") = recall identical to pre-LMC5.
  // Set "on" or "true" to enable hop1/hop2 expansion after vector seed hits.
  RELATION_EXPANSION?: string;
  // Trigger 召回通道 (migration 0016)。默认全 off；gate 调低会往候选池灌噪音。
  TRIGGER_RECALL?: string;
  TRIGGER_RECALL_GATE?: string;
  TRIGGER_RECALL_TOP_K?: string;
  TRIGGER_BUILD?: string;
  TRIGGER_BUILD_MODEL?: string;
  ENABLE_DAILY_MEMORY_DIGEST?: string;
  DREAM_NAMESPACE?: string;
  DREAM_MAX_MESSAGES?: string;
  DREAM_MAX_RUNS?: string;
  DREAM_MAX_TOKENS?: string;
  DREAM_MODEL?: string;
  DREAM_MEMORY_CONTEXT_LIMIT?: string;
  DREAM_TIME_ZONE?: string;
  // weekly_log rollup after dream; default on unless "false"
  ENABLE_WEEKLY_ROLLUP?: string;
  // weekly rollup 是否顺手删除该周 daily_log。默认 false：周记落成待审，
  // 日志保留，审过后走 POST /admin/weekly-approve 亲手删。"true" 恢复旧行为 (写完即删，链上无人)。
  WEEKLY_ROLLUP_DELETE_DAILIES?: string;
  // monthly_log rollup after weekly; default on unless "false"
  ENABLE_MONTHLY_ROLLUP?: string;
  // boot [Impressions] ladder char budget; default 1000
  IMPRESSION_LADDER_MAX_CHARS?: string;
  // dedicated diary writer after dream; default on unless "false"
  ENABLE_DIARY_WRITER?: string;
  DIARY_MODEL?: string;
  DEDUP_COSINE?: string;
  // 候选队列自动评审（judge），默认开启；设 "false" 关闭
  CANDIDATE_JUDGE_ENABLED?: string;
  JUDGE_MODEL?: string;
  JUDGE_MAX_CANDIDATES?: string;
  // judge 评分阈值：>= APPROVE_MIN 自动入库，<= DISCARD_MAX 自动丢弃，中间留人工
  JUDGE_APPROVE_MIN?: string;
  JUDGE_DISCARD_MAX?: string;
  DAILY_DIGEST_MAX_MESSAGES?: string;
  DAILY_DIGEST_MAX_RUNS?: string;
  DAILY_DIGEST_MAX_TOKENS?: string;
  DAILY_DIGEST_MODEL?: string;
  SUMMARY_MODEL?: string;
  DAILY_DIGEST_MEMORY_CONTEXT_LIMIT?: string;
  DAILY_DIGEST_TIME_ZONE?: string;
  // GitHub daily archive pull (cmh-lite client → private repo → nightly cron ingest)
  GITHUB_DAILY_REPO?: string;
  GITHUB_DAILY_PATH?: string;
  GITHUB_DAILY_NAMESPACE?: string;
  GITHUB_DAILY_TOKEN?: string;
  EMPTY_MEMORY_MIN_CHARS?: string;
  MESSAGES_RETENTION_DAYS?: string;
  // 是否允许后台任务物理删除终态记忆（默认 false 锁死，只报候选不执行）
  MEMORY_AUTO_DELETE?: string;
  /** P8 两阶段发布维护闸（wrangler.toml [vars]，一次性迁移窗口用）：true 时 fetch 写路径全 503、cron 跳过、queue 不消费 */
  MAINTENANCE_MODE?: string;
  ENABLE_MEMORY_FILTER?: string;
  ENABLE_MEMORY_RERANKER?: string;
  MEMORY_RERANKER_MODEL?: string;
  VISION_MODEL?: string;
  MEMORY_FILTER_MAX_CANDIDATES?: string;
  MEMORY_FILTER_MAX_OUTPUT?: string;
  MEMORY_FILTER_MAX_CONTENT_CHARS?: string;
  MEMORY_FILTER_MIN_SCORE?: string;
  MEMORY_FILTER_FAIL_OPEN?: string;
  RECALL_RERANK_MIN_SCORE?: string;
  RECALL_RERANK_TIMEOUT_MS?: string;
  EMBEDDING_MODEL?: string;
  EMBEDDING_DIMENSIONS?: string;
  MEMORY_TOP_K?: string;
  MEMORY_MIN_SCORE?: string;
  MEMORY_LEGACY_VECTOR_FALLBACK_LIMIT?: string;
  MEMORY_LEGACY_VECTOR_FALLBACK_SCORE_FACTOR?: string;
  // P5-E · CORS 跨域白名单（传输层，行为模板 = 旧分支 77e25c0）：逗号分隔的精确
  // Origin 列表，例如 "https://memoria.pages.dev,https://memoria.example.com"。
  // 不配 = 保持现状（不返回任何 CORS 头，浏览器跨域请求全被拦）。
  CORS_ALLOW_ORIGINS?: string;
}

export interface RetentionQueueMessage {
  type: "retention";
  namespace: string;
}

export type QueueMessage = RetentionQueueMessage | import("./gateway/record").GatewayExchange;

export type Scope =
  | "chat:proxy"
  | "memory:read"
  | "memory:write"
  | "cache:read"
  | "cache:write"
  | "debug:read"
  | "export:read";


export interface KeyProfile {
  source: string;
  namespace: string;
  scopes: Scope[];
  allowModelPassthrough: boolean;
  debug: boolean;
  /** Owner keys may address any namespace via ?namespace= / body.namespace; others stay pinned. */
  chooseNamespace: boolean;
}

export interface AuthResult {
  ok: true;
  profile: KeyProfile;
  keyName: "CHATBOX_API_KEY" | "IM_API_KEY" | "DEBUG_API_KEY" | "MEMORY_MCP_API_KEY" | "GUIDE_DOG_API_KEY";
}

export interface OpenAIChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | Array<unknown> | null;
  name?: string;
  reasoning_content?: string;
  tool_call_id?: string;
  tool_calls?: unknown;
}

export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  /** vLLM 系模型的模板开关，如 {enable_thinking: false} 关闭思考链。 */
  chat_template_kwargs?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface OpenAIChatChoice {
  index?: number;
  message?: OpenAIChatMessage;
  finish_reason?: string | null;
  [key: string]: unknown;
}

export interface OpenAIChatResponse {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices?: OpenAIChatChoice[];
  usage?: TokenUsage;
  [key: string]: unknown;
}

export interface TokenUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  [key: string]: unknown;
}

export interface Conversation {
  id: string;
  namespace: string;
  created_at: string;
  updated_at: string;
}

export interface MessageRecord {
  id: string;
  conversation_id: string;
  namespace: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  source: string | null;
  created_at: string;
  /** Turn-local order. Hash IDs are unique only; same-timestamp rows sort by seq. */
  seq?: number;
}

export type MemoryVersionStatus = "current" | "superseded" | "under_review";

export interface MemoryRecord {
  id: string;
  namespace: string;
  type: string;
  content: string;
  summary: string | null;
  importance: number;
  confidence: number;
  // 四维权重列（0018，旧分支 0010 同构）。写入时经 computeWeight 计算；
  // 存量迁移行原样保留不重算（P0 全局规则 1/2）。
  emotional: number;
  recurrence: number;
  unresolved: number;
  weight: number;
  status: "active" | "deleted" | "superseded" | "low_confidence" | string;
  pinned: number;
  tags: string | null;
  source: string | null;
  source_message_ids: string | null;
  vector_id: string | null;
  last_recalled_at: string | null;
  recall_count: number;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  // LMC-5 Z 轴: 本体列 (0007)。与 memory_lifecycle 侧车双写；读时本体优先。
  fact_key?: string | null;
  version_status?: MemoryVersionStatus | string | null;
  superseded_by?: string | null;
  // LMC-5 E 轴: 本体列 (0011)。只许亲手写 (HAND_AUTHOR_SOURCES)，蒸馏链禁写。
  authored_by?: string | null;
  response_tendency?: string | null;
}

// v2 字段侧车表 (母帖 #11 第 1 步，sidecar 版)。
// 不放 memories 本体——ALTER ADD COLUMN 不幂等，会让 fork 部署炸。
// memory_id 关联 memories.id，PRIMARY KEY(memory_id) 一对一。
export interface MemoryLifecycleRow {
  memory_id: string;
  namespace: string;
  fact_key: string | null;
  supersedes_id: string | null;
  superseded_by_id: string | null;
  review_reason: string | null;
  valid_as_of: string | null;
  last_seen_at: string | null;
  seen_count: number;
  last_injected_at: string | null;
}

export interface MemoryApiRecord {
  id: string;
  namespace: string;
  type: string;
  content: string;
  summary: string | null;
  importance: number;
  confidence: number;
  // 四维权重（0018，P3 恢复 API 可见性；旧分支 MemoryApiRecord 同位必填）。
  // D1 本体为唯一真源；纯 Vectorize metadata 构造的记录按旧版硬编码 0。
  emotional: number;
  recurrence: number;
  unresolved: number;
  weight: number;
  status: string;
  pinned: boolean;
  tags: string[];
  source: string | null;
  source_message_ids: string[];
  vector_id: string | null;
  last_recalled_at: string | null;
  recall_count: number;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  score?: number;
  // --- v2 字段 (从 memory_lifecycle 侧车表合并来，可选) ---
  fact_key?: string | null;
  supersedes_id?: string | null;
  superseded_by_id?: string | null;
  review_reason?: string | null;
  valid_as_of?: string | null;
  last_seen_at?: string | null;
  seen_count?: number;
  last_injected_at?: string | null;
  // --- LMC-5 Z 轴 (memories 本体，可选 additive) ---
  version_status?: MemoryVersionStatus | string | null;
  superseded_by?: string | null;
  // --- LMC-5 E 轴 (memories 本体 0011，可选 additive) ---
  authored_by?: string | null;
  response_tendency?: string | null;
}

// LMC-5 Y 轴: relation 边类型
export type MemoryRelType =
  | "supports"
  | "contradicts"
  | "cause_effect"
  | "derived_from"
  | "same_thread"
  | "supersedes";

export interface MemoryRelationRow {
  id: number;
  src_id: string;
  dst_id: string;
  rel_type: MemoryRelType | string;
  weight: number;
  created_by: string | null;
  created_at: string;
}

export interface PerceptionCacheItem {
  id: string;
  content: string;
  importance: number;
}

export interface PerceptionCacheRow {
  namespace: string;
  date: string;
  items: string;
  created_at: string;
}

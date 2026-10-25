# P8 独立只读审查（2026-10-24）

> 审查对象：`Aelios` 分支 `integration/upstream-v2`，工作包 P8（旧线上数据迁移）。
> 审查方式：以实际代码、SQL、测试和真实导出副本为准，不沿用实现者最终报告结论。
> 约束：未执行任何 `--remote` 命令；未访问线上服务；`/tmp/aelios-latest.sql` 全程只读，内容/权限/时间戳/sha256 未变；所有写入产物仅在 `Aelios/.migration-work/`。
> 本地复审副本：`.migration-work/p8/audit.sqlite`（未脱敏，本地敏感，已 gitignore；可整体删除）。

## 1. 结论

**不通过（仅针对“可执行的线上上线包”）。**

- **迁移 SQL 与离线数据转换本身：通过。** `0021–0025` 的映射、重建、约束、索引、软删除/版本链/四维/weight/chord 处置，在真实导出副本上独立复现为 `findings=0`；没有发现静默丢列、覆盖、错配 namespace 或破坏版本链的 SQL 缺陷。
- **线上执行方案：不通过。** 现有 runbook 有一个直接的备份错误（漏 `--remote`）、没有真正的写入冻结、没有可执行的远端恢复机制；账本终态与演练结果不一致；上线后校验命令用错工具；旧 Worker 与迁移序列的兼容窗口被低估。按现 runbook 直接执行会同时失去“可恢复性”和“迁移期间一致性”。

因此：**P8 代码可以继续作为候选实现，但不能按当前交接文档上线。**

## 2. 已确认问题

### BLOCKER

#### B1. 备份命令实际导出的是本地库，不是线上 D1；且备份文件路径未被 gitignore

- **证据**
  - 交接 runbook 第 0 步：`doc/handovers/2026-10-24-opencode-aelios-p8.md:111`
    `wrangler d1 export companion_memory_proxy --output backup-pre-p8.sql`，**没有 `--remote`**。
  - `DEV.md:47` 同样只写“先 `wrangler d1 export` 备份”，没有 `--remote`。
  - 已安装 wrangler 的行为：不带 `--remote` 走 `exportLocal`，并打印 “To export your remote database, add a --remote flag”：`node_modules/wrangler/wrangler-dist/cli.js:183620-183628`。
  - 备份文件名落在仓库根目录；`git check-ignore backup-pre-p8.sql` 返回 1（未忽略），而 `backups/` 才是被忽略目录（`.gitignore:6`）。
- **真实影响**
  - 操作者以为拿到了线上全量备份，实际得到的是本地 `wrangler dev` 库（通常为空或过期）。一旦迁移失败，唯一“备份”不可用。
  - 该文件是未脱敏全量 D1 dump（memories/messages 正文），放在仓库根目录有被 `git add` / push 到 GitHub 的风险。
- **可复现路径**
  1. 在 `Aelios/` 执行不带 `--remote` 的 `wrangler d1 export ...`；观察日志明确写 “Exporting local database”。
  2. `git status` 会显示 `backup-pre-p8.sql` 为未跟踪文件；`git check-ignore` 不命中。
- **最小修复建议**
  - 备份命令改为 `npx wrangler d1 export companion_memory_proxy --remote --output backups/pre-p8-<UTC时间>.sql`。
  - 备份后校验：文件非空、含 `d1_migrations` 与 21 张旧表、行数/大小合理；记录 sha256。
  - 只允许写到 `backups/` 或 `.migration-work/`，迁移完成后安全保存/删除；确认 `.gitignore` 覆盖。

#### B2. 没有写入冻结；用户“不聊天”远不足以覆盖后台写入

- **证据（旧线上 Worker，`feat/memory-dimensions`）**
  - 旧 cron 为每 4 小时 + 每日 19:00 UTC：`git show feat/memory-dimensions:wrangler.toml:23-25`；旧 `scheduled` 分派：`git show feat/memory-dimensions:src/index.ts:258-288`。
  - 旧 Worker 每次抓取会写 memories/lifecycle 等，并跑 retention：`git show feat/memory-dimensions:src/index.ts:265-274`。
  - 旧 retention 会**物理删除**旧 messages（3 天）、usage_logs（30 天）、memory_events（30 天）、idempotency_keys（7 天），并 expire 180 天未活跃 memories：`git show feat/memory-dimensions:src/memory/retention.ts:19-24,80-92` 与 `git show feat/memory-dimensions:src/db/retention.ts:19-66`。
  - 旧 Worker 仍写旧格式 `client_message_hash = conversationId:role:content`：`git show feat/memory-dimensions:src/db/messages.ts:41-49`；新 0010 在该列上建了唯一部分索引，重复文本会撞约束。
  - 旧 Worker 的 daily_log / memories 查询硬编码 `role_scope`：`git show feat/memory-dimensions:src/db/v2.ts:637,1051-1063,1078-1079`；0021/0022 后旧 Worker 的读/写会落空或写回旧 namespace。
  - 队列消费者仍在：`git show feat/memory-dimensions:wrangler.toml:84-91`；新 Worker 同样有 consumer：`wrangler.toml:88-95`、`src/queue/consumer.ts:5-15`。
  - 新 Worker 的 cron（20:10 UTC）会跑 Dream/日记/retention/FTS/vector/rollup：`wrangler.toml:25-27`、`src/index.ts:323-461`。
- **真实影响**
  - 迁移窗口内若有旧 cron/queue 运行：可能删掉 582 条 usage_logs 中的旧行、删 messages、改变 memories.status；P8 的“582 原样 / 947 原样 / 6 孤儿”会被在线写入改写。
  - 0021 之后旧 Worker 写入的新 memories 会以旧 namespace 落库，0025 删除 `role_scope` 后这些行不会被重新映射，形成静默错归属。
  - 0022/0023 之后旧 Worker 的 daily_log / baseline 查询直接因缺列失败；旧 Worker 可能从“部分可用”变成 500。
  - 0025 之后旧 Worker 彻底不可用，旧代码没有任何回退价值。
- **可复现路径**
  - 读旧分支 cron/retention 文件与 0021/0022/0025 SQL；或在迁移副本上模拟旧版 SQL：
    `INSERT INTO memories (... namespace, role_scope ...)` → 再执行 0025 → 该行 namespace 仍是旧值、role_scope 已消失。
  - 在 0022 后执行旧版 `SELECT ... FROM daily_log WHERE namespace=? AND role_scope=?` → `no such column: role_scope`。
- **最小修复建议**
  - 维护窗口开始前：禁用旧 Worker 的 cron triggers（Dashboard/Triggers 或临时部署移除 `[triggers]`）、暂停 queue consumer、阻断所有 ingress（gateway/MCP/REST/admin）。
  - 等 in-flight 调用与队列排空（看 invocation logs；确认无 running 的 dream run）后再导出。
  - 用户不发消息是必要但不充分；必须显式覆盖 cron、queue、admin、MCP/REST、其他客户端/自动化。
  - 最小代码/配置改动：临时维护版 Worker（fetch 全 503、`crons=[]`、无 consumer）或 Dashboard 关闭 triggers + pause consumer；不要只靠“我不用”。

#### B3. 没有可执行的远端恢复机制；“从备份恢复”在当前文档里不是一条能跑的命令

- **证据**
  - 交接文档只写“从备份导出评估”（`doc/handovers/2026-10-24-opencode-aelios-p8.md:105`）和“重新 export 复核”（同文件 123），没有恢复命令、目标库、绑定切换或 bookmark。
  - P0 验收清单同样只写“线上回滚依赖迁移前 `wrangler d1 export` 备份，见报告 runbook”：`docs/p0-migration-acceptance.md:47`。
  - 当前 wrangler 没有 `d1 import` 子命令（`npx wrangler d1 --help` 仅 create/info/list/delete/execute/export/time-travel/migrations/insights）；export 出来的 SQL 直接对现有库再执行会撞已存在的表。
  - D1 实际可用的时间点恢复是 Time Travel：`npx wrangler d1 time-travel restore --bookmark <bookmark>`（本机 wrangler help 已确认，30 天窗口）。
- **真实影响**
  - 迁移失败时，操作者没有立即恢复线上 D1 的路径；尤其在 0025 之后旧 Worker 已不可用，唯一出路是“修好新 Worker”或“恢复 D1”，而文档两者都没有可执行步骤。
  - “从备份恢复”如果被理解成对现有库执行 dump，会失败并可能进一步破坏状态。
- **可复现路径**
  - `npx wrangler d1 --help | grep import` → 无输出。
  - `npx wrangler d1 time-travel restore --help` → 有 `--bookmark`/`--timestamp`。
- **最小修复建议**
  - 迁移前捕获 bookmark：`npx wrangler d1 time-travel info companion_memory_proxy --timestamp <ISO> --json`，保存到 runbook 记录。
  - 失败恢复首选：`npx wrangler d1 time-travel restore companion_memory_proxy --bookmark <bookmark>`；恢复后重新 export + inspect 验证。
  - 备份兜底：export 到 `backups/`；如需从 dump 恢复，创建新 D1（`wrangler d1 create`）→ `wrangler d1 execute <new> --remote --file <dump>` → 切换 Worker binding；不要对原库直接重放 dump。
  - 在维护窗口前用 scratch D1 实际演练一次 time-travel 或“新库导入 + 切绑定”，确认可执行。

### HIGH

#### H1. 账本终态“30 条”只在 orchestrator 副本里成立；线上 runbook 实际是 25 条

- **证据**
  - orchestrator 在副本里为每个 P8 文件执行 `insertLedger.run(file)`：`scripts/migration/p8.ts:1195`，并据此期望账本含 P8 五个名字：`scripts/migration/p8.ts:861-873`。
  - 但线上 runbook 只执行 `wrangler d1 execute --file migrations-p8/...`：`doc/handovers/2026-10-24-opencode-aelios-p8.md:118-122`，**没有任何 d1_migrations INSERT**。
  - `grep d1_migrations migrations-p8/*.sql` → 无命中；P8 SQL 自己也不记账。
  - 测试把 30 条钉死：`tests/migration-p8.test.ts:219-221`；交接表写 `d1_migrations 10 → 30`：`doc/handovers/2026-10-24-opencode-aelios-p8.md:75`。
- **真实影响**
  - 线上实际账本为 10（旧）+3（引导）+12（新 0006–0017）= **25**，不是 30。报告/测试的“账本 30 条”验收节与线上不一致。
  - P8 是否执行过没有任何持久记录；未来若把 `migrations-p8/` 的内容移入 `migrations/`，或需要审计/重放判断，账本无法提供依据。
  - 这是“演练结果 ≠ 线上执行路径”的典型假阳性，不能把 30 条当作上线验收条件。
- **可复现路径**
  - 在真实导出副本上按 runbook 路径执行（bootstrap → 0006–0017 → 五个 `--file`，不额外 INSERT），随后 `SELECT COUNT(*) FROM d1_migrations` → 25。
  - 对比 orchestrator 报告：同一副本因 `insertLedger` 为 30。
- **最小修复建议**
  - 在每个 `002N_p8_*.sql` 末尾加 `INSERT INTO d1_migrations(name) VALUES ('002N_...sql');`，让“文件导入 + 记账”在同一原子 import 内完成；orchestrator 改为 `INSERT OR IGNORE` 或删除重复插入；测试改为按真实路径验证 30。
  - 若不改 SQL，则在 runbook 每个文件成功后显式 INSERT，并在文档中把 25 作为线上期望；但审计链仍弱，推荐前者。

#### H2. 账本引导没有执行时的 schema 门禁，可能把“未实际具备的结构”标成已应用

- **证据**
  - 引导逻辑只按名字插入：`scripts/migration/p8.ts:54-60`；runbook 是无条件 INSERT：`doc/handovers/2026-10-24-opencode-aelios-p8.md:112-114`。
  - orchestrator 的预检只针对 **导出副本**（`scripts/migration/p8.ts:1017-1090` 的 preflight 段），不会在线上执行前重新读线上 schema。
  - d1_migrations 的真实结构是 `id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL`（真实导出的 `sqlite_schema` 已核对），INSERT 只写 name 在结构上可行，但这也意味着“写名字”不需要结构真的存在。
- **真实影响**
  - 如果线上与导出之间发生漂移（例如旧 0008 的 status 列/索引缺失、或人工改过表），引导会把 0018/0019/0020 永久标为已应用；`migrations apply` 会跳过它们，后续 P8 可能继续执行或在别处才失败。
  - 最坏情况：0018 四维列缺失 → P8 不报错地少列；0020 索引缺失 → 永久少索引；这类状态不会被线上 runbook 的 `inspect` 捕获（见 H3）。
- **可复现路径**
  - 在一个缺少 `memories.weight` 的库上执行引导 INSERT，再跑 `migrations apply`：0018 被跳过，后续不会补列。
- **最小修复建议**
  - 引导前对**冻结后的线上**做结构断言：`PRAGMA table_info(memories)` 含四维列、`PRAGMA table_info(daily_log)` 含 affect_chord、`PRAGMA table_info(precious)` 含 status 且 `sqlite_schema` 含 `idx_precious_namespace_status`；任一不满足即中止。
  - 最好把引导改成 `INSERT ... SELECT ... WHERE <结构条件>`，或用一个受检脚本；不要凭历史导出直接写账本。
  - 引导后立刻重读账本与结构，记录结果，再进入 0006–0017。

#### H3. 上线后“重跑 migration:inspect 复核”是错误工具：它按旧 schema 判定，必然报失败

- **证据**
  - runbook 第 4 步：`doc/handovers/2026-10-24-opencode-aelios-p8.md:123` 与 `scripts/migration/p8.ts:1011` 都写“重跑 migration:inspect 复核（从新的 d1 export）”。
  - `inspect` 的形状核对只认旧分支 21 表/旧列：`scripts/migration/inspect.ts:123-147`；账本只认旧 0001–0010：同文件 149-166。
  - 形状不符时退出码为 1：`scripts/migration-rehearsal.ts:186`。
  - 本轮实测：对已迁移副本执行 `migration:inspect`，输出“形状偏离”，列出一堆预期内的新表/新列/新账本，退出码 1（`.migration-work/p8/post-inspect.report.json`）。
- **真实影响**
  - 操作者会在迁移成功后看到“形状偏离/失败”，误以为迁移坏了；也可能反过来忽略真正的事故信号。
  - 它不能验证 P8 后的目标形状、行数、namespace、回填列；这些应由 orchestrator 的 verify 逻辑或显式 SQL 完成。
- **可复现路径**
  - `npm run migration:inspect -- --source .migration-work/p8/audit.sqlite --report .migration-work/p8/post-inspect.report.json` → `形状核对: !! 形状偏离`，exit 1。
- **最小修复建议**
  - 把第 4 步改为：`migration:inspect` 只用于**迁移前**的旧导出；迁移后使用显式只读校验（行数、账本、role 列、memory_changelog、索引、integrity_check），或新增 `migration:p8 verify --source <post-export>` 子命令。
  - 不要用“inspect 通过/失败”作为上线后验收。

#### H4. 旧 Worker 与五步迁移的兼容窗口被低估；0022 起旧 Worker 就可能整体不可用

- **证据**
  - 旧 Worker 的 daily_log 查询/写入硬编码 `role_scope`：`git show feat/memory-dimensions:src/db/v2.ts:1051-1063,1078-1079`；0022 重建后该列不存在。
  - 旧 Worker 的 memories/baseline 也大量依赖 `role_scope`：同文件 637、826-836 等；0021/0025 后旧 Worker 的 role 记忆查询会落空或写错 namespace。
  - 旧 Worker cron 会继续运行（见 B2），且 0022/0023 后没有“旧 Worker 仍可服务”的保证。
  - 当前 runbook 的顺序是“迁移全部完成 → 再部署新 Worker”（`doc/handovers/...:107-123`），没有维护页/停机说明，也没有“0025 后没有旧代码回退”的警告。
- **真实影响**
  - 0022 成功后、0025 完成前，旧 Worker 的聊天背景注入/Dream/日记路径可能 500；0025 后旧 Worker 100% 不可用。
  - 若新 Worker 部署失败或配置缺失，`wrangler rollback` 只能回代码，不能把 D1 形状回退；此时唯一恢复是 Time Travel/新库切换。
- **可复现路径**
  - 在迁移副本上执行 0022，然后用旧版 SQL `SELECT ... role_scope ... FROM daily_log` → `no such column`。
- **最小修复建议**
  - 把整个窗口定义为**计划内停机**：先上维护页/503，再迁移；不要假设旧 Worker 能在 0022–0025 间继续服务。
  - 新 Worker 必须在等价迁移副本上完成构建/冒烟；0025 前准备好一键部署。
  - 0025 之后明确写“唯一回退 = Time Travel 或新库切换，不是 Worker rollback”。

#### H5. `readNamespaces` / identity 配置没有落到可执行步骤；迁移后大量记忆可能不可见

- **证据**
  - 真实导出映射后 memories 只有 2 个 namespace（shared + 一个 role）；其中 shared 行占多数（本轮只统计数量，不输出值）。daily_log 同样是 2 个 namespace。
  - 新 Worker 的 `identityReadNamespaces` 在未配置时只返回写入 namespace：`src/gateway/config.ts:133-135`；`readNamespaces` 最多 8 个、非空、唯一：同文件 77-81。
  - 配置来源是 D1 `gateway_config` 或 `GATEWAY_CONFIG`：`src/gateway/config.ts:108-119`；旧线上没有 gateway_config 数据（新表迁移后为 0 行）。
  - runbook 只有一句“按 identity 清单核 readNamespaces”（`doc/handovers/...:123`），没有具体命令/值/校验。
- **真实影响**
  - 若 identity 只读自己的写入 namespace，迁移到 `shared` 的大量记忆（本轮 790 条 memories、2 条 daily_log 等）会在部署后不可见；role namespace 若不在配置里也同样不可见。
  - 这不是迁移 SQL 错，是上线配置缺失；但用户会直接感知“记忆丢了”。
- **可复现路径**
  - 用迁移后的副本统计 namespace 数；对照 `identityReadNamespaces` 的默认行为。
- **最小修复建议**
  - 部署前在 `/admin` 或 `GATEWAY_CONFIG` 中为每个 identity 显式设置 `readNamespaces`，至少包含 `shared` 与迁移报告中的 role namespace；注意最多 8 个。
  - 把“读取 shared + role 的 canary 记忆”加入最小读写验证；不要只验证写入 namespace。

#### H6. FTS 与向量在迁移后是空的；P8 完成不等于检索可用

- **证据**
  - 新 0014 只建空 FTS 表；迁移后副本 `message_fts`/`memory_fts` 行数为 0（本轮探针）。
  - FTS 回填只在每日 scheduled 里跑，且每次 limit 400：`src/index.ts:403-407`、`src/memory/fts.ts:233-250`；947 条 memories 在单 namespace 下需要多轮每日任务。
  - 向量旧 metadata/namespace 未迁移，P9 才重建（plan P9）；runbook 未写“检索降级”。
- **真实影响**
  - 部署后引用/原文检索（quote/FTS）可能数日为空；向量召回对迁移到新 namespace 的记忆可能完全召回不到，直到 P9。
  - 若把“能聊天/能写”当作最小验证，会遗漏检索面。
- **可复现路径**
  - 迁移副本：`SELECT COUNT(*) FROM message_fts; SELECT COUNT(*) FROM memory_fts;` → 0。
- **最小修复建议**
  - runbook 明确写出“FTS/向量在 P9/回填前降级”；最小验证加入“FTS 预期为空”的说明，避免误判。
  - 部署后手动连续触发/执行 FTS 回填（或临时提高 limit / 增加一次性入口），不要等数日 cron。
  - P9 前不要承诺完整召回。

### MEDIUM

#### M1. 引导 INSERT 不幂等；失败重试会因 UNIQUE 直接卡住

- **证据**：`doc/handovers/...:112-114` 的 INSERT 没有 `OR IGNORE`/存在性检查；d1_migrations 的 `name` 是 UNIQUE（真实导出已核对）。
- **真实影响**：引导成功但后续步骤失败后重跑，会因重复 name 失败；操作者可能误以为结构有问题。
- **复现**：同一命令执行两次。
- **最小修复**：先查 `SELECT name FROM d1_migrations WHERE name IN (...)`，或 `INSERT OR IGNORE`；仍保留 H2 的结构门禁。

#### M2. 测试没有覆盖真实远端执行路径、CHECK/唯一约束 parity、旧 Worker 并发写入

- **证据**
  - 成功/失败/重复测试都跑本地 `node:sqlite`：`tests/migration-p8.test.ts`；`execFileInTransaction` 是本地显式事务：`scripts/migration/p8.ts:308-322`。
  - 远端 `--file` 走 D1 import、`migrations apply` 走 query batch；没有在真实/预发 D1 上做过“故意失败”的原子性测试。
  - `verifyShape` 只比 `PRAGMA table_info`（name/type/notnull/default/pk）和索引名：`scripts/migration/p8.ts:783-855`；不比较 CHECK 约束和 `sqlite_autoindex_*`。本轮静态比对 0023 的 CHECK 与 0017 一致，但自动化验收没有覆盖。
  - 没有测试旧 Worker 在 0021–0025 之间并发写入的后果（B2）。
- **真实影响**：测试能证明“本地 SQL 逻辑对”，不能证明“线上 D1 命令路径/形状/并发安全”。
- **复现**：删除 0024 的 CHECK 约束但保留列，`verifyShape` 仍可能通过（列属性不变）。
- **最小修复**：增加预发 D1 的端到端演练（含一次失败/重试）；`verifyShape` 比较 `sqlite_schema.sql` 规范化文本或 `PRAGMA index_xinfo` + CHECK；增加“旧 Worker 写入后再迁移”的负向用例。

#### M3. 新/旧 retention 会在恢复写入后改变“原样”计数

- **证据**
  - 新 retention：messages 默认 7 天、usage_logs 30 天、memory_events 30 天、active memories 180 天 expire：`src/memory/retention.ts:18-28,83-99`。
  - 旧 retention：messages 3 天、usage 30 天、expire 180 天：`git show feat/memory-dimensions:src/memory/retention.ts:19-24,80-92`。
- **真实影响**：迁移完成时的 582 usage_logs / 46 messages / 943 active 只是“当时”状态；恢复 cron 后按策略会减少/改变。验收若在 cron 后做，会误判 P8 丢数据。
- **复现**：在迁移副本上模拟 retention SQL（按 created_at 截止）即可看到行数变化。
- **最小修复**：runbook 明确“先验收、后恢复 cron”；验收记录带时间戳；把 retention 预期变化写进结果，不与 P8 保真混淆。

#### M4. 部署配置与 DEV 规则不一致：`CANDIDATE_JUDGE_ENABLED=true`，`ENABLE_DIARY_WRITER` 默认开启

- **证据**：`wrangler.toml:73` 为 `CANDIDATE_JUDGE_ENABLED = "true"`；`DEV.md:32` 要求部署时设 false；`src/memory/diaryWriter.ts:45-48` 未配置时默认启用日记。
- **真实影响**：迁移后验证窗口内 Dream/cron 可能自动审核候选、写日记，产生额外写入，干扰“只读验证”和计数。
- **复现**：不设这两个变量部署，观察 cron 后 memory_candidates/daily_log 变化。
- **最小修复**：维护窗口内显式 `ENABLE_DIARY_WRITER=false`、`CANDIDATE_JUDGE_ENABLED=false`；验证完再按产品决定恢复。

#### M5. `--force` 可以删除任意 `--copy` 路径

- **证据**：`scripts/migration/p8.ts:908-919` 在 `opts.force` 时 `rmSync(copyAbs)` 和 `.meta.json`，只检查 source != copy；不限制在 `.migration-work/`。
- **真实影响**：误传 `--copy` 指向另一个真实导出/数据库文件时，会被删除；与 `/tmp/aelios-latest.sql` 只读要求冲突的操作风险。
- **复现**：`--source a.sql --copy b.sql --force` → 删除 b.sql。
- **最小修复**：`--force` 只允许删除 `.migration-work/` 下的路径，或要求显式 `--yes-delete-copy`；默认路径已安全。

#### M6. D1 的 `ALTER TABLE DROP COLUMN` 与迁移批原子性未在真实 D1 验证

- **证据**：0025 使用 `ALTER TABLE ... DROP COLUMN`（`migrations-p8/0025:21-33`）；本地 SQLite 3.35+ 支持，测试通过；但没有对真实 D1 执行过。`migrations apply` 的远端路径是多语句 query batch（wrangler `executeSql` 的 `query`），D1 文档称按 batch 执行；`--file` 的 import 明确“失败回到原状态”（wrangler 源码 183255-183259）。
- **真实影响**：如果 D1 对该 DDL 有限制，0025 会失败（原子回滚到 0024 状态），需要表重建方案；如果 query batch 非原子，0006–0017 的失败可能留下半迁移。
- **复现**：在 scratch D1 上执行 0025 + 故意失败的 0007。
- **最小修复**：上线前在 scratch D1 演练这两点；准备 0025 失败时的重建版 SQL；不要把本地 SQLite 通过当作 D1 通过。

### LOW

#### L1. 引导后账本 `id` 顺序不再对应编号顺序

- **证据**：引导 INSERT 先于 0006–0017，账本 id 顺序为旧 10 → 0018–0020 → 0006–0017 → P8（若修 H1）。
- **真实影响**：`wrangler d1 migrations list` 的显示顺序会奇怪；wrangler 只按 name 判断是否已应用，不影响正确性。
- **最小修复**：文档说明；或在引导前先应用 0006–0017（但会撞 0018 duplicate column，不可行）。保持现状即可，只需不依赖 id 顺序。

#### L2. `role_id` 为空串/非法 namespace 字符没有校验

- **证据**：0024 用 `role_id IS NOT NULL` 直接赋 namespace：`migrations-p8/0024:36-37`；preflight 只检查 role_scope，不检查 role_id 空串/长度。
- **真实影响**：本轮真实数据 role_id 全非空且与 memories 映射一致（探针 0 例外）；未来数据可能产生空 namespace。
- **最小修复**：预检增加 `role_id=''`/超长/不可见字符计数；有则拒绝。

## 3. 不确定项（缺什么证据才能关闭）

1. **D1 真实 DDL/事务行为**：需要在 scratch D1 上跑一遍完整序列，并在 0007/0022/0025 各注入一次失败，确认 `migrations apply` 的 query batch 和 `--file` import 都按文件原子回滚。当前只有本地 SQLite + wrangler 源码/文档证据。
2. **`ALTER TABLE DROP COLUMN` 在 D1 的可用性**：本地通过，真实 D1 未跑。
3. **Time Travel 可用性与保留窗口**：需要账号实际 `time-travel info` 成功，并确认 30 天窗口/权限；未在线上验证。
4. **identity 配置真值**：需要部署前读取实际 `GATEWAY_CONFIG`/`gateway_config`，确认 `readNamespaces` 覆盖 shared + role namespace；当前只有代码默认行为和迁移后的 namespace 数量。
5. **旧 Worker 的 in-flight 排空**：需要 Cloudflare invocation/queue 面板证据，确认维护窗口开始时没有正在跑的 Dream/retention/consumer。
6. **冻结后的最新线上导出**：本轮用的是 2026-10-24 15:04 的 `/tmp/aelios-latest.sql`；上线前必须重新 export 并重跑 inspect/orchestrator，确认账本/行数/形状未漂移。
7. **FTS 回填耗时**：需要实际部署后观察 400/轮的进度；当前只能从 limit 推算。
8. **retention 对迁移数据的实际影响**：需要恢复 cron 后观察一次；当前只能从窗口常量推算。

## 4. 线上写入来源清单（迁移期间必须逐项处置）

> 迁移窗口内线上仍是旧 Worker；下表同时覆盖旧/新 Worker。**“用户不聊天”只覆盖第 1 行的用户主动请求，不覆盖其余任何一行。**

| # | 来源/入口 | 主要写入 | 触发/证据 | 迁移期间处置 |
|---|---|---|---|---|
| 1 | Gateway 聊天 `/v1/...` | messages、conversations、usage_logs、gateway_exchanges；记忆抽取/候选；Vectorize | `src/gateway/handler.ts`、`src/gateway/record.ts`、`src/db/messages.ts` | 阻断 ingress/维护页；不要只靠用户不发消息 |
| 2 | MCP `/mcp`、`/mcp/:identity` | memories、memory_lifecycle、memory_events、daily_log、precious、glossary、longtail、memory_candidates、baseline_changelog | `src/api/mcp.ts` | 阻断 MCP 路由/客户端 |
| 3 | REST `/v1/memories`、`/v1/diary`、`/v1/precious`、`/v1/glossary`、`/v1/longtail`、`/v1/candidates`、`/v1/ingest/messages` | 同上 | `src/index.ts:194-238` | 阻断路由/客户端 |
| 4 | Admin `/admin/*`、`/api/gateway/config` | gateway_config/settings、weekly/monthly rollup、diary rewrite、weekly approve（删 daily_log）、vector reindex/backfill、dream run | `src/index.ts:132-178,245-270` | 维护窗口内禁止操作；最好阻断 |
| 5 | Cron（旧 `0 */4 * * *`、`0 19 * * *`；新 `10 20 * * *`） | Dream/抽取、baseline merge、candidate judge、diary writer、retention（删 messages/usage/events、expire/hard delete memories）、FTS backfill、vector backfill、weekly/monthly、GitHub daily | 旧 `wrangler.toml:23-25`、`src/index.ts:258-288`；新 `wrangler.toml:25-27`、`src/index.ts:323-461` | **必须禁用 cron triggers**；等待 in-flight 结束 |
| 6 | Queue consumer `companion-memory` | gateway_exchange、retention | 旧 `wrangler.toml:88-91`；新 `wrangler.toml:92-95`、`src/queue/consumer.ts` | **必须暂停 consumer**；排空 backlog |
| 7 | GitHub daily trigger（cron 内） | daily_log/weekly 相关 | `src/index.ts:394-401`、`runGithubDailyTrigger` | 随 cron 一起禁用 |
| 8 | 前端/Memoria/其他自动化 | 通过 Gateway/MCP/REST 间接触发上述写入 | 外部客户端 | 维护页/防火墙/停客户端；不能假设“没人用” |
| 9 | Workers Builds 自动部署 | 不是 D1 写入，但会把新 Worker 提前推上线 | `.github/workflows`、`DEV.md:30-32` | 迁移完成前不要 push；手动控制部署时点 |
| 10 | P8 迁移工具本身 | 0021–0025 的 D1 写入 | `scripts/migration-p8.ts`（本地副本）；线上 `wrangler d1 execute --file` | 串行执行；每步成功再下一步 |

## 5. 各迁移边界的失败状态表

> 前提：已按 B2 冻结写入；`wrangler d1 execute --file` 走 D1 import，wrangler 明示失败会回到执行前状态（`node_modules/wrangler/wrangler-dist/cli.js:183255-183259`）；`migrations apply` 的 query batch 原子性见“不确定项 1”。
> “旧 W”= 旧 Worker（`feat/memory-dimensions`）；“新 W”= 新 Worker（`integration/upstream-v2`）。✅=结构兼容；⚠️=部分可用/有静默错写风险；❌=不可用。

| 边界 | 线上 D1 状态 | 旧 W | 新 W | 可执行恢复 |
|---|---|---|---|---|
| S0 迁移前 | 旧形状；账本 10 | ✅ | ❌（baseline/daily_log 旧形状、role 列、role-less 未归 shared） | 不适用 |
| 引导 0018–0020 后 | 形状未变；账本 13 | ✅ | ❌ | 删除 3 条账本或保留（无数据变化）；重试前先做 H2 结构门禁 |
| 0006–0017 后 | 新表/新列加入；baseline 仍是旧形状；账本 25 | ⚠️（messages 唯一 hash 可能撞旧格式；seq 默认 0；role 语义未变） | ❌ | 停；可重试失败迁移；要完全回退用 Time Travel；不要在这时部署新 W |
| 0021 后 | memories/lifecycle/events namespace 已重写；账本 25（P8 未记账） | ⚠️（role 记忆查询按旧 namespace+role_scope 会落空；新写入可能落旧 namespace） | ❌（daily_log/baseline 仍旧） | 停；重试 0021（UPDATE 幂等）或 Time Travel；禁止旧 W 写 |
| 0022 后 | daily_log 新形状；账本 25 | ❌（daily_log 查询/写入缺 role_scope；背景注入/日记可能 500） | ⚠️（daily_log 可用；baseline 仍旧、role-less 未 shared、messages 未映射） | 停；重试 0022（失败时未建表可重试；已成功不要重跑）或 Time Travel；可考虑临时维护页 |
| 0023 后 | baseline 三表新形状；memory_changelog 删除；账本 25 | ❌（daily_log + baseline 均缺 role_scope） | ⚠️（baseline 可用；role-less/messages 仍旧；role 列多余但新代码不读） | 停；重试 0023 或继续 0024/0025 + 部署新 W；Time Travel 兜底 |
| 0024 后 | role-less+summaries→shared；messages/conversations 映射；cursors 清空；账本 25 | ❌（daily_log/baseline 坏；memories role 查询错；messages 仍可因 role 列存在而部分工作） | ✅ 结构上基本可用（多余 role 列无害；FTS 空） | 停；重试 0024（幂等）或继续 0025；可应急部署新 W，但需接受 FTS/配置未完成 |
| 0025 后 | role 列清除；与 fresh 列集合/PK/索引一致；账本 25（若修 H1 则 30） | ❌ **无回退价值** | ✅ 结构上完整（FTS/向量/配置另说） | **不能靠 Worker rollback**；修好并部署新 W，或 Time Travel 恢复 + 回滚旧 W；保持冻结直到验证通过 |
| 新 W 部署后 | 迁移完成 | ❌（schema 不兼容） | ✅（需 identity/FTS/向量验证） | 验证失败：先停写入；数据问题用 Time Travel；配置/代码问题修新 W；不要回滚旧 W |

补充：
- 0022/0023/0025 的成功与否是“文件级”的；失败文件本身回滚，但**之前成功的文件不会回滚**。因此“停在上一个边界”是现实状态，不要假设能自动回到 S0。
- 若引导/0006–0017 阶段失败且未动 P8 数据，旧 W 仍可服务（除 hash/seq 小风险）；这是唯一相对安全的回退区。
- 0025 后旧 W 已无 schema 兼容性；`wrangler rollback` 只回代码，必须同时恢复 D1 才能回到旧 W。

## 6. 修订后的最小上线 runbook

> 目标：**写入冻结 → 冻结后备份 → 原库原地迁移 → 部署新 Worker → 最小读写验证 → 恢复写入**。所有命令在 `Aelios/` 下、Node 22 环境执行；不要用 Dashboard/console 逐条手跑 0022/0023/0025。

### 6.0 前置（不满足不要开始）

- [ ] 新 Worker 已在等价迁移副本/预发 D1 上构建并冒烟；`npm run verify` 全绿。
- [ ] `GATEWAY_CONFIG`/identity 已准备：每个 identity 的 `readNamespaces` 覆盖 `shared` + 迁移报告中的 role namespace（最多 8 个）。
- [ ] `ENABLE_DIARY_WRITER=false`、`CANDIDATE_JUDGE_ENABLED=false`、`MEMORY_AUTO_DELETE` 不设/`false`（按产品最终决定）。
- [ ] 维护窗口避开旧 cron（19:00 UTC）与新 cron（20:10 UTC）；确认无 running dream。
- [ ] 维护页/503 或入口阻断方案已就绪。
- [ ] 在 scratch D1 演练过 Time Travel 或“新库导入 + 切绑定”。

### 6.1 写入冻结

1. 禁用旧 Worker cron triggers（Dashboard → Triggers，或临时维护版 `crons=[]`）。
2. 暂停 `companion-memory` queue consumer。
3. 阻断 Gateway/MCP/REST/admin ingress（维护页/503/WAF/停客户端）。
4. 等待 in-flight 调用、queue backlog、dream run 排空；看 invocation logs 确认无写入。
5. **确认“用户不发消息”只是其中一项；cron/queue/admin/MCP/REST 全部已停。**

### 6.2 冻结后备份 + 恢复点

```bash
export NVM_DIR=/home/agent/projects/.nvm
source "$NVM_DIR/nvm.sh" && nvm use 22

# 1) 恢复点（30 天窗口）
npx wrangler d1 time-travel info companion_memory_proxy \
  --timestamp "$(date -u +%FT%TZ)" --json
# 记录输出中的 bookmark

# 2) 真正的线上备份（必须 --remote）
mkdir -p backups
npx wrangler d1 export companion_memory_proxy --remote \
  --output "backups/pre-p8-$(date -u +%Y%m%dT%H%M%SZ).sql"
```

备份后检查：文件非空、含 `d1_migrations` 和 21 张旧表、sha256 记录；确认 `backups/` 已被 gitignore；不要把备份放仓库根目录。

### 6.3 迁移前最后门禁

```bash
# 旧形状/账本/冲突/未知 scope（正确用法：迁移前）
npm run migration:inspect -- --source backups/pre-p8-<ts>.sql

# 用同一份冻结后备份做最后一次完整演练
npm run migration:p8 -- \
  --source backups/pre-p8-<ts>.sql \
  --copy .migration-work/p8/final.sqlite \
  --report .migration-work/p8/final.report.json
```

期望：`shape_ok=true`、账本 10、daily/baseline 冲突 0、未知 scope 0、digest 单 namespace、changelog 值域 0、orchestrator `findings=0`。任一不符：停止，不进入线上。

### 6.4 原库原地迁移

```bash
# (a) 结构门禁：确认 0018–0020 的列/索引真实存在（按实际输出判断）
npx wrangler d1 execute companion_memory_proxy --remote --command \
  "SELECT name FROM pragma_table_info('memories') WHERE name IN ('emotional','recurrence','unresolved','weight');"
npx wrangler d1 execute companion_memory_proxy --remote --command \
  "SELECT name FROM pragma_table_info('daily_log') WHERE name='affect_chord';"
npx wrangler d1 execute companion_memory_proxy --remote --command \
  "SELECT name FROM pragma_table_info('precious') WHERE name='status';"
npx wrangler d1 execute companion_memory_proxy --remote --command \
  "SELECT name FROM sqlite_schema WHERE type='index' AND name='idx_precious_namespace_status';"
# 四项齐全才继续；否则停止

# (b) 账本引导（仅在上一步通过后）
npx wrangler d1 execute companion_memory_proxy --remote --command \
  "INSERT INTO d1_migrations (name) VALUES
   ('0018_memory_weight_dimensions.sql'),
   ('0019_daily_log_affect_chord.sql'),
   ('0020_precious_status.sql');"

# (c) 应用新名 0006–0017
npm run db:migrate:remote
# 期望：只应用 12 个新名；0018–0020 不再出现；账本 25

# (d) P8 五文件逐个执行；每步成功再下一步
npx wrangler d1 execute companion_memory_proxy --remote --file migrations-p8/0021_p8_memories_and_sidecars.sql
npx wrangler d1 execute companion_memory_proxy --remote --file migrations-p8/0022_p8_daily_log_rebuild.sql
npx wrangler d1 execute companion_memory_proxy --remote --file migrations-p8/0023_p8_baselines_rebuild.sql
npx wrangler d1 execute companion_memory_proxy --remote --file migrations-p8/0024_p8_roleless_messages_shared.sql
npx wrangler d1 execute companion_memory_proxy --remote --file migrations-p8/0025_p8_role_columns_cleanup.sql
```

**账本修正（二选一）：**
- 推荐：把 `INSERT INTO d1_migrations(name) VALUES ('002N_...sql');` 追加到每个 P8 SQL 文件末尾，使文件 import 与记账原子；同步改 orchestrator/测试。
- 临时：每个文件成功后单独 INSERT 并核对；文档明确线上终态是 30 而不是 25。

### 6.5 部署新 Worker

- 手动部署（不要用 push 触发 Workers Builds 自动部署），确认部署版本/commit。
- 确认环境变量：`ENABLE_DIARY_WRITER=false`、`CANDIDATE_JUDGE_ENABLED=false`、`MEMORY_AUTO_DELETE` 不设/`false`、`GATEWAY_CONFIG`/identity/readNamespaces 已生效。
- 记录新版本 ID；保留回滚版本信息，但明确旧版本与 0025 后 schema 不兼容。

### 6.6 最小读写验证（只读为主）

用只读 SQL 对线上做一次（在恢复写入前）：

```sql
SELECT COUNT(*) FROM memories;                       -- 947
SELECT COUNT(*) FROM daily_log;                      -- 55
SELECT COUNT(*) FROM daily_log WHERE affect_chord IS NOT NULL; -- 35
SELECT COUNT(*) FROM memory_lifecycle;               -- 775
SELECT COUNT(*) FROM memory_lifecycle l
  WHERE NOT EXISTS (SELECT 1 FROM memories m WHERE m.id=l.memory_id); -- 0
SELECT COUNT(*) FROM usage_logs;                     -- 582（retention 前）
SELECT COUNT(*) FROM processing_cursors;             -- 0
SELECT COUNT(*) FROM messages WHERE client_message_hash IS NOT NULL; -- 0
SELECT seq, COUNT(*) FROM messages GROUP BY seq ORDER BY seq; -- 24/22
SELECT COUNT(*) FROM memories WHERE authored_by IS NOT NULL
  OR response_tendency IS NOT NULL;                  -- 0
SELECT COUNT(*) FROM memories WHERE importance < 0 OR importance > 1; -- 2
SELECT COUNT(*) FROM sqlite_schema WHERE name='memory_changelog'; -- 0
SELECT COUNT(*) FROM d1_migrations;                  -- 25（未修 H1）/30（修 H1）
PRAGMA integrity_check;                              -- ok
PRAGMA foreign_key_check;                            -- 0 行
```

再用实际 API 做：
- `/health`；
- 读一条 `shared` 记忆 + 一条 role namespace 记忆（验证 readNamespaces）；
- 读一个历史 daily_log 与 baseline；
- MCP `memory_get`/`daily_log_read` 的只读调用；
- 如允许写入：在临时 namespace 写一条 canary，再软删，确认新代码写路径正常；不要写生产 namespace。
- FTS/向量：明确“当前为空/降级”，不要把召回为空当 P8 失败；按 H6 回填。

### 6.7 恢复写入

1. 移除维护页/入口阻断。
2. 重新启用 cron/queue consumer。
3. 观察第一次 cron（Dream/retention/FTS）与第一次聊天；记录 retention 造成的 messages/usage/status 变化（M3）。
4. 决定 `ENABLE_DIARY_WRITER`/`CANDIDATE_JUDGE_ENABLED` 的最终值；DEV 要求 false。
5. 保留备份与 bookmark 至少到验证稳定；清理 `.migration-work/` 本地敏感副本。

### 6.8 失败时的最短路径

- 引导/0006–0017 失败：停；旧 W 仍可服务（⚠️ hash/seq 风险）；查失败迁移；可重试/Time Travel。
- 0021–0024 失败：停；失败文件已原子回滚；旧 W 可能已部分不可用；优先修 SQL 后续跑，或 Time Travel 回 S0。
- 0025 失败：DB 停在 0024；旧 W 不可用；修 0025/表重建后重跑，或 Time Travel。
- 新 W 部署/验证失败：停；数据问题用 bookmark 恢复；配置/代码问题修新 W；不要只 rollback 旧 W。

## 7. 测试与本地探针结果

### 7.1 已运行

| 命令/探针 | 结果 |
|---|---|
| `node --import tsx --test tests/migration-p8.test.ts` | 7/7 pass |
| `npm run verify` | 343/343 pass；typecheck + 4 个 verify 脚本全过 |
| `npm run migration:p8 -- --source /tmp/aelios-latest.sql --copy .migration-work/p8/audit.sqlite --report .migration-work/p8/audit.report.json --force` | `status=upgraded`，`findings=0`，P8 五文件全应用 |
| 源文件只读校验 | sha256 前后一致（`d503b480…`），size 2,487,343，mtime/权限未变 |
| `migration:inspect` on migrated copy | 形状偏离、exit 1（证明 runbook 第 4 步用错） |
| 真实导出形状探针 | 21 张旧表列集/23 个索引与 fixture 完全一致；账本 10 个名字与期望一致；`shape_ok=true` |

### 7.2 真实导出复现（独立于实现者报告）

- 导出：`/tmp/aelios-latest.sql`，kind=`sql-dump`，2,487,343 bytes，sha256 `d503b480…`。
- 账本：10 条，名字与 `EXPECTED_OLD_MIGRATIONS` 全匹配，无重复；表结构 `id/name/applied_at`，`name UNIQUE`。
- 形状：`shape_ok=true`；21 张旧表 + d1_migrations。
- 预检：daily_log 冲突 0、baseline 冲突 0、未知 scope 0、digest 1 个 namespace、changelog 值域外 0。
- 数据：memories 947、daily_log 55、memory_lifecycle 781、usage_logs 582、processing_cursors 224、messages 46、conversations 2、summaries 1、digest 1、precious 1、glossary 37、baseline 1/1/7、memory_changelog 0。
- 专项：importance 超界 2；weight 与公式不一致 498（原样，不重算）；affect_chord 35 非空；lifecycle 孤儿 6；messages role_id 非空 46；conversations role_id 非空 1；memory_events 0。
- 迁移后（副本）：memories 947、daily_log 55/35 chord、lifecycle 775/孤儿 0、usage_logs 582、cursors 0、messages 46（hash 0、seq 24/22）、precious active 1、role-less+summaries 全 shared、fact_key 195、superseded_by 0、E 轴 0、version_status 全 current、role 列 0、memory_changelog 0、FTS 0 行、integrity/fk ok。
- DDL：daily_log / baseline 三表的列、PK、CHECK 与全新部署 0017 逐字一致；索引集合一致；列顺序差异属预期。
- 账本：orchestrator 副本 30 条（因为 `insertLedger` 写入了 P8 名字）；按 runbook **不写 P8 账本**则为 25 条（见 H1）。

### 7.3 测试覆盖的真实缺口

- 没有在真实/预发 D1 上执行 `wrangler d1 migrations apply --remote` 和 `wrangler d1 execute --file`；本地 `execFileInTransaction` 不能替代远端 import/query batch 行为。
- 没有验证旧 Worker 在 0021–0025 之间并发写入（B2/H4）。
- `verifyShape` 不比较 CHECK/自动唯一索引（本轮静态比对通过，但自动化断言不足以证明“约束 parity”）。
- 没有验证迁移后新 Worker 的真实读写（只验证了形状和数据）；H5/H6 的可见性/检索缺口不在测试内。
- 没有恢复演练（Time Travel / 新库导入 + 切绑定）。

## 8. 为什么 SQL 与数据处置本身仍可判“通过”

即使 runbook 不通过，以下逐项有代码/探针证据：

### 8.1 账本引导与“旧 0010 → 引导 0018–0020 → 新 0006–0017 → 0021–0025”在结构上为何成立

- 真实导出的 `d1_migrations` 恰为 10 条，名字与 `EXPECTED_OLD_MIGRATIONS` 全匹配；旧 0001–0005 的 DDL 与新 `migrations/0001–0005` 逐行一致（本轮 fixture 与真实导出的 21 张旧表列集、23 个索引逐表比对，0 差异；d1_migrations 单独核对）。
- wrangler 的 `getUnappliedMigrations` 按 **name** 过滤、按数字前缀排序（本机 `node_modules/wrangler/wrangler-dist/cli.js:184239-184287`）：同名 0001–0005 跳过，新名 0006–0017 应用；引导 INSERT 后 0018–0020 也跳过，不会撞 duplicate column。
- 0017 对已存在的旧 baseline 三表是 `CREATE TABLE IF NOT EXISTS` 静默 no-op；0023 随后整表重建为 0017 目标形状，并补回索引。0025 再清除旧 role 列，使列集合与全新部署一致。
- 该序列**机械上可行**；前提是 B2 的冻结、H2 的线上结构门禁、H1 的 P8 记账、H4/H5 的新 Worker/配置就绪。缺少任一前提，“可行”会变成“能跑完但不可验收/不可恢复”。

### 8.2 0021–0025 逐文件检查结论

| 文件 | 关键检查 | 结论 |
|---|---|---|
| 0021 | namespace 仅由已知 role_scope 映射；未知 scope 预检拒绝；`superseded_by` 从侧车回填；6 条孤儿先记录再删除；lifecycle/events 跟随 memories | 无静默丢列/覆盖；孤儿有报告；真实 post 孤儿 0 |
| 0022 | 显式列名重建；PK(namespace,date) 冲突预检 0；title/summary/updated_at/affect_chord 逐字；source_message_ids NULL；旧表 DROP 前先 INSERT 新表 | 无 chord/正文丢失；冲突 fail-loud；真实 55/35 保持 |
| 0023 | baseline 三表按 0017 目标 DDL 重建；op/status CHECK；值域外预检拒绝；补回两个索引；memory_changelog 0 行删除 | DDL/CHECK/索引与 fresh 一致；无静默合并；真实 1/1/7 保持 |
| 0024 | role-less 五表 + summaries → shared；messages/conversations 有 role_id 用 role_id、无则保留；processing_cursors 清空；usage_logs/users/cache_entries/idempotency_keys 不触碰 | 真实 role-less 全 shared；messages 46 全随 role_id；cursors 224→0；usage 582 未动 |
| 0025 | 先 DROP 三个旧 role 索引，再 DROP role 列；daily_log/baseline 已在 0022/0023 重建，无残留 | role 列 0；表/列/PK/索引与 fresh 一致；按 `--file` import 语义为文件级原子（真实 D1 待验，见 M6） |


- **memories 947 → 947**：0021 只重写已知 `role_scope` 的 namespace；未知 scope 预检拒绝；其余列全表逐行哈希一致（orchestrator 报告 `carried_maps_equal` 全 true）。`importance` 2 条超界、weight 498 条公式不一致原样（哈希包含这些列）。
- **daily_log 55 → 55**：0022 显式列名重建；PK(namespace,date) 冲突预检 0；35 条 chord 逐字；source_message_ids 全 NULL。
- **summaries 1 → shared**：0024 单表 UPDATE；真实 1 行。
- **role-less 五表 → shared**：0024 显式 UPDATE；digest 多 namespace 预检拒绝；其余表无 PK 冲突。
- **messages/conversations**：0024 有 role_id 用 role_id、无 role_id 保留旧值；真实 46 条 messages 全部有 role_id，角色 namespace 与 memories 映射一致（探针 0 例外）；conversations 1 随角色、1 保留旧值。
- **usage_logs 582 原样**：0021–0025 不触碰；orchestrator 全列哈希一致。
- **processing_cursors 224 → 0**：0024 DELETE；数量由报告记录。
- **6 条 lifecycle 孤儿**：0021 删除前记录 ID；post 孤儿 0；不迁入目标侧车。
- **软删除/版本链**：memories.status（active/deleted）原样；precious.status 原样；fact_key 195、superseded_by 0、version_status 全 current；E 轴 NULL；无静默覆盖。
- **结构 parity**：与全新部署 0001–0020 的表集合、列属性、PK、索引集合一致；0023 的 CHECK 文本与 0017 一致（本轮静态比对）；0025 先 DROP INDEX 再 DROP COLUMN，真实旧索引齐全。

因此，**P8 的数据迁移实现可以保留**；需要修的是“线上执行包/验收/冻结/恢复”，不是 0021–0025 的数据转换逻辑。

## 9. 状态确认

- **未修改业务代码、迁移 SQL、现有文档**：本轮只新增了本审查报告、交接与 `.migration-work/` 下的本地审计产物。
- **未提交、未推送、未部署**：HEAD 仍为 `f019aed`，分支仍为 `integration/upstream-v2`；没有 commit/push/deploy。
- **未执行任何 `--remote` 命令**：没有访问线上 D1/Worker。
- **`/tmp/aelios-latest.sql` 只读**：sha256、大小、mtime、权限均未变。
- **本轮写入产物**：`.migration-work/p8/audit.sqlite`、`audit.report.json`、`audit.sqlite.meta.json`、`post-inspect.report.json`、`post-inspect2.json`；均在本目录、已 gitignore、未脱敏本地敏感文件，处置完可删除。
- 既有 P0–P8 工作树改动保持原样，未纳入提交。

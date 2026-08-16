# Aelios 开发指南

## 分支

- 当前开发分支：`feat/memory-dimensions`
- 上游：`https://github.com/wusaki0723/Aelios.git`（remote `upstream`）

## 本地运行

```bash
nvm use 22          # wrangler 需要 Node >= 20
npm install
npx wrangler dev    # 本地开发服务器
```

## 测试

改代码后跑测试（目前 285 个测试，45 个文件）：

```bash
npx vitest run                    # 全量测试
npx vitest run test/multirole/    # 多角色相关
npx vitest run test/assembler/    # prompt 拼装
npx tsc --noEmit                  # 类型检查
```

验证脚本（缓存策略、assembler、提取管线）：

```bash
node scripts/verify-cache-strategy.mjs
node scripts/verify-assembler.mjs
node scripts/verify-extract-pipeline.mjs
```

## 部署

- **自动部署**：push 到 GitHub 触发 Workers Builds
- **手动部署**：`npm run deploy:cloudflare`（会自动建 D1 + Vectorize + Queue）
- **不要用** `npm run deploy` 或 `wrangler deploy`，它们不会创建基础设施

## 注意事项

- `wrangler.toml` 的 `[vars]` 每次部署会覆盖 Dashboard 上的同名环境变量，敏感值只放 Dashboard secrets
- `CHAT_MODEL` 已从 `[vars]` 移除，由 Worker 现有配置持有（`keep_vars = true` 保留）；改模型直接改 Dashboard 变量，不要写回 wrangler.toml
- `workers_dev = false` 已显式写入，防止部署时自动启用 `*.workers.dev` 子域名
- `DREAM_WRITE_DAILY_LOG` 默认 true，设 false 可阻止 dream 覆盖手写日志
- D1 的 ALTER TABLE 不支持 IF NOT EXISTS，迁移只能跑一次
- 迁移 0009（daily_log.affect_chord）和 0010（memories 四维权重）部署后需回填旧数据 weight：
  ```sql
  UPDATE memories SET weight = importance * 0.35 WHERE weight = 0 AND importance > 0;
  ```
- 架构细节见 `docs/DEV_MAP.md`，API 接口见 `docs/API_REFERENCE.md`

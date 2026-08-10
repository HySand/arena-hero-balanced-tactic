# Cloudflare Worker 部署

本目录是与上游 Python 项目隔离的 Cloudflare Workers/Durable Objects 版本。上游同步只合并仓库历史，不会覆盖 `worker/`；同步后会先执行 Worker 稳定检查，检查失败时不会推送。普通上游变更会在自动合并和稳定检查通过后重新部署，但不需要人工修改 `worker/` 代码。

## 本地验证

```sh
cd worker
npm ci
npm run check
# 可选：运行耗时较长的 140 局历史仿真基线
npm run test:simulation
npm run deploy:dry-run
```

本地开发时复制 `.dev.vars.example` 为 `.dev.vars` 并填写测试凭据：

```sh
npm run dev
```

## 首次部署

```sh
cd worker
npm ci
npm run secrets
npm run deploy
```

需要设置两个 Worker secret：

- `ARENA_HERO_API_KEY`：Arena Hero API key。
- `ADMIN_CONTROL_SECRET`：控制接口 Bearer token。

控制接口：

```sh
curl -X POST https://<worker>.workers.dev/control \
  -H "Authorization: Bearer <ADMIN_CONTROL_SECRET>" \
  -H "Content-Type: application/json" \
  -d '{"action":"start"}'
```

停止时将 `action` 改为 `stop`。

## GitHub Actions

仓库需要配置：

- `UPSTREAM_SYNC_TOKEN`：可推送本仓库 `main` 的细粒度 PAT；同步 Action 使用它写入上游更新

`.github/workflows/sync-upstream.yml` 定时合并 `jinlingyuan123/arena-hero-balanced-tactic:main`。它使用 merge 而不是强制重置，因此保留本仓库的 Worker 目录；出现冲突或 Worker 检查失败时直接停止，线上现有部署不受影响。

Cloudflare Worker 已通过 Git 集成连接本仓库。Cloudflare 构建设置应使用生产分支 `main`、根目录 `worker`，部署命令保持默认的 `npx wrangler deploy`。同步工作流只负责合并、运行 Worker 稳定检查并推送 `main`；Cloudflare 检测到仓库更新后自动构建部署。只有上游直接触碰 Worker 专属路径、产生合并冲突或破坏 Worker 检查时才停止并等待人工处理。

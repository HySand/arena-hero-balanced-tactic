# Cloudflare Worker 部署

本目录是与上游 Python 项目隔离的 Cloudflare Workers/Durable Objects 版本。上游同步只合并仓库历史，不会覆盖 `worker/`；同步后会先执行 Worker 稳定检查，检查失败时不会推送。普通上游变更会在自动合并和稳定检查通过后重新部署，但不需要人工修改 `worker/` 代码。

## 管理控制台

部署完成后直接打开 Worker URL，即可使用随 Worker Assets 一起发布的管理控制台。控制台支持：

- 查看 Agent 连接状态、当前 Tick 和策略姿态。
- 启动或停止 Agent。
- 读取、编辑和恢复策略配置默认值。

策略配置和前端状态存储在主 `ArenaHeroState` Durable Object 中，命令结果日志存储在另一个独立实例；日志存储异常不会中断 Tick。`ArenaHeroAgent` 只负责游戏 WebSocket、策略计算和策略记忆，其运行轨迹写入 Cloudflare 结构化日志。WebSocket 消息链注册到 Durable Object 事件生命周期，增长过大的地图记忆会围绕当前单位、敌人和资源自动裁剪到固定预算。每个 Tick 的命令通过无状态 `ArenaCommandDispatcher` Worker entrypoint 在后台提交，Arena HTTP 不在 Durable Object 内执行，单次请求异常或超时不会重置 Agent 或阻塞后续 Tick、前端接口。配置保存成功后从下一 Tick 起使用新值。

读取配置、配置 schema 和状态无需管理员 Token。保存配置、启动或停止 Agent 时需要 `ADMIN_CONTROL_SECRET`。前端只把该 Token 写入当前标签页的 `sessionStorage`，不会把 Token 存入 Durable Object。

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
- `ADMIN_CONTROL_SECRET`：管理控制台写操作和控制接口使用的 Bearer token。

`wrangler.jsonc` 启用了 `keep_vars`，Git 自动部署会保留已经在 Cloudflare 中设置的 Secrets，不会再次清空。

公开上游仓库不需要 Token。`ARENA_HERO_API_KEY` 是 Worker 登录 Arena Hero 服务使用的账号凭据，与 GitHub 上游同步无关。

控制接口：

```sh
curl -X POST https://<worker>.workers.dev/api/control \
  -H "Authorization: Bearer <ADMIN_CONTROL_SECRET>" \
  -H "Content-Type: application/json" \
  -d '{"action":"start"}'
```

停止时将 `action` 改为 `stop`。旧路径 `/control` 继续兼容。

## Cloudflare Git 部署

Cloudflare Worker 已通过 Git 集成连接本仓库。Cloudflare 构建设置使用：

- 生产分支：`main`
- 根目录：`worker`
- 部署命令：默认的 `npx wrangler deploy`

仓库根目录的 `.wrangler/deploy/config.json` 会把 Wrangler 强制重定向到 `worker/wrangler.jsonc`。即使 Cloudflare 构建根目录被设置成仓库根目录，也不会退化成只上传静态 Assets 的部署。

根目录 `dashboard/` 中的控制台会通过 Workers Assets 与 Worker 一起部署，不需要额外的部署 Action。Cloudflare 检测到仓库更新后自动构建；普通上游代码变化不会要求人工调整 Worker，只有上游直接修改 Worker 专属路径、产生合并冲突或破坏 Worker 检查时才需要处理。

## 上游同步

公开上游的拉取和向当前仓库推送都使用 GitHub Actions 内置的 `GITHUB_TOKEN`，无需配置额外的同步 Token。工作流已声明 `contents: write`；若 `main` 分支保护禁止 Actions 推送，需要在分支规则中放行。

`.github/workflows/sync-upstream.yml` 定时合并 `jinlingyuan123/arena-hero-balanced-tactic:main`。它使用 merge 而不是强制重置，因此保留本仓库的 Worker 目录；出现冲突或 Worker 检查失败时直接停止，线上现有部署不受影响。

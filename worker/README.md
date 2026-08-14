# Cloudflare 免费双 Worker 部署

Cloudflare 版本由两个脚本组成：

- `worker/`：TypeScript 兼容层，负责 Arena Hero WebSocket、状态、控制、严格校验和命令提交。
- `python-worker/`：SQLite-backed Python Durable Object，执行仓库唯一维护的 `arena_hero_tactic/strategy_core/` 策略核。

Python Worker 部署前由 `python-worker/sync_shared_core.py` 生成构建副本。生成目录不进入 Git，因此策略源码仍只有根包一份。部署顺序必须是 **Python Worker → TypeScript Worker**，因为 TypeScript Worker 的 `PYTHON_STRATEGY` 外部 Durable Object binding 指向 Python Worker。

## 管理控制台

部署完成后打开 TypeScript Worker URL。控制台支持：

- 查看 Agent 连接状态、当前 Tick 和策略姿态。
- 查看策略后端、实际提交来源、版本、延迟、最近成功 Tick、连续失败和 Shadow 差异。
- 启动或停止 Agent。
- 读取、编辑和恢复 TypeScript 回滚策略的配置默认值。

`ArenaHeroState` Durable Object 保存控制状态、后端模式和前端状态；`ArenaHeroAgent` 保存 TypeScript/Python 两套独立策略记忆，并负责后端编排。命令结果日志使用独立存储，Arena HTTP 命令通过无状态 `ArenaCommandDispatcher` 提交，日志或单次提交异常不会阻塞后续 Tick。

控制台中的旧策略参数只属于 `typescript_primary` 回滚路径。`python_shadow` 和 `python_primary` 使用 TypeScript Worker 从仓库 `config/strategy_config.json` 打包并随每个请求发送的共享 Python 配置。

读取状态和配置无需管理员 Token。保存配置、切换后端、启动或停止 Agent 需要 `ADMIN_CONTROL_SECRET`。前端只把该 Token 写入当前标签页的 `sessionStorage`。

## 本地验证

需要 Node.js 24、Python 3.13+ 和 `uv`。

```sh
cd python-worker
uv sync
uv run python sync_shared_core.py
uv run python sync_shared_core.py --check
uv run pywrangler sync
uv run pywrangler deploy --dry-run --config wrangler.jsonc

cd ../worker
npm ci
npm run check
npm run test:simulation
npm run deploy:dry-run
```

TypeScript Worker 本地开发时复制 `worker/.dev.vars.example` 为 `worker/.dev.vars`，再运行 `npm run dev`。

## 首次部署

先设置 TypeScript Worker 使用的两个 secret：

```sh
cd worker
npm ci
npm run secrets
```

- `ARENA_HERO_API_KEY`：Arena Hero API key。
- `ADMIN_CONTROL_SECRET`：管理控制台写操作和控制接口使用的 Bearer token。

`worker/wrangler.jsonc` 启用了 `keep_vars`，后续部署会保留 Cloudflare 中已设置的值。

然后从仓库根目录执行统一部署脚本。脚本先完成两个项目的检查和 dry-run，全部通过后才依次部署 Python Worker 和 TypeScript Worker：

```powershell
./scripts/deploy-worker.ps1 -DryRun
./scripts/deploy-worker.ps1
```

macOS/Linux：

```sh
./scripts/deploy-worker.sh --dry-run
./scripts/deploy-worker.sh
```

## 控制接口

启动 Agent：

```sh
curl -X POST https://<worker>.workers.dev/api/control \
  -H "Authorization: Bearer <ADMIN_CONTROL_SECRET>" \
  -H "Content-Type: application/json" \
  -d '{"action":"start"}'
```

停止时将 `action` 改为 `stop`。旧路径 `/control` 继续兼容。

## Shadow、切换与回滚

安全默认是 `typescript_primary`。首次部署 Python Worker 后按以下顺序切换：

1. 切到 `python_shadow`：继续提交 TypeScript 计划，同时执行并比较 Python 计划。
2. 观察 `/api/status`：确认 `strategy.lastError` 为空、`strategy.consecutiveFailures` 为 `0`，并检查 `strategy.shadow` 与 `strategy.latencyMs`。
3. 只有无未解释差异且延迟稳定时，才显式切到 `python_primary`。
4. 出现异常时立即切回 `typescript_primary`。

```sh
curl -X PUT https://<worker>.workers.dev/api/backend \
  -H "Authorization: Bearer <ADMIN_CONTROL_SECRET>" \
  -H "Content-Type: application/json" \
  -d '{"backend":"python_shadow","failureThreshold":3}'

curl -X PUT https://<worker>.workers.dev/api/backend \
  -H "Authorization: Bearer <ADMIN_CONTROL_SECRET>" \
  -H "Content-Type: application/json" \
  -d '{"backend":"python_primary","failureThreshold":3}'

curl -X PUT https://<worker>.workers.dev/api/backend \
  -H "Authorization: Bearer <ADMIN_CONTROL_SECRET>" \
  -H "Content-Type: application/json" \
  -d '{"backend":"typescript_primary"}'
```

`python_primary` 的超时、服务错误、契约错误或计划校验失败只会触发最小 `safeFallbackPlan`，不会静默调用完整 TypeScript planner。`strategy.blocked` 是达到连续失败阈值后的告警状态，不会自动停止 WebSocket、Python 重试或切换后端。

## 免费层观测

截至 2026-08-12，Workers Free 的动态请求额度为每日 100,000 次，单次 CPU 上限为 10 ms；SQLite-backed Durable Objects 可在免费层使用，额度分别按请求、执行时长、行读写和存储计算。生产观察期至少监控：

- TypeScript Worker 和 Python Durable Object 的请求量、CPU 时间与错误率。
- Python `latencyMs`、`consecutiveFailures`、`blocked` 和 `lastSuccessTick`。
- Durable Object 行写入量；每个成功的新 Tick 会原子更新排序与缓存状态。
- 两个 Worker 的压缩后 bundle 大小；免费层单 Worker 上限为 3 MB。

官方参考：[Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)、[Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)、[Python packages](https://developers.cloudflare.com/workers/languages/python/packages/)。

## Cloudflare Git 部署

双脚本架构不能只配置一个 `worker/` Git 构建。若使用 Cloudflare Git 集成，创建两个 Worker 构建并保证首次部署顺序：

- Python 构建：根目录 `python-worker`，部署命令 `uv sync && uv run python sync_shared_core.py && uv run pywrangler deploy`。
- TypeScript 构建：根目录 `worker`，部署命令 `npx wrangler deploy`。

仓库根目录的 `.wrangler/deploy/config.json` 只服务 TypeScript Worker 的 Wrangler 根目录兼容，不会部署 Python Worker。

## 上游同步

`.github/workflows/sync-upstream.yml` 使用 merge 同步上游，并保护 `worker/`、`python-worker/`、共享策略核和部署脚本。合并后同时验证 Python Worker 构建与 TypeScript Worker 检查；任一失败都不会推送同步结果。

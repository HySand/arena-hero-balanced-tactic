# Arena Hero 平衡战术

一个面向 Arena Hero 的可持续运行 Python 战术，使用官方 `arena-hero` SDK，并提供本地中文控制台。项目会根据每个 Tick 的真实状态在经济、警戒和生存姿态之间切换。

> 这是社区项目，不是 Arena Hero 官方客户端。项目不包含任何 API key、账号信息或个人游戏状态。

## 运行要求

- Windows 10/11。
- Python 3.11 或更高版本。
- Arena Hero 官方 Python SDK `0.2.6` 或同一 `0.2.x` 兼容系列的更高版本。
- Node.js 仅用于开发阶段的 JavaScript 语法检查，正常运行不需要。

## 主要功能

- 工人自动采集、返航交付、资源目标去重和危险规避。
- 采矿半径按真实可行路径计算，并用“去矿 + 回 Core”的完整循环过滤低效率目标。
- 前期近距离采矿，中期逐步扩大探索，后期满足资源与兵力门槛后再进攻。
- 先锋近战巡逻、游侠远程守卫、公共 Beacon 独立控制。
- Core 遇险时寻找障碍掩护位置，先锋和游侠掩护，工人撤离。
- 中文网页控制台，可调整生产、探索、进攻、守卫、迁移和主题配色。
- 配置热加载，保存后通常从下一个 Tick 开始生效。

## 快速开始

### Windows 一键启动

1. 安装 Python 3.11 或更高版本，并勾选 `Add python.exe to PATH`。
2. 下载或克隆本项目。
3. 双击 `run_all.cmd`。
4. 首次运行会创建 `.venv`、安装依赖并弹出 API key 输入窗口。
5. 保持策略窗口和控制台窗口开启。

控制台默认地址为 `http://127.0.0.1:8765/`。

以后可以直接双击 `run_all.cmd`。只运行战术时使用 `run_tactic.cmd`，只打开控制台时使用 `run_dashboard.cmd`。

### 手动启动

```powershell
Set-Location -LiteralPath '你解压或克隆后的项目目录'
./setup.cmd
./.venv/Scripts/python.exe -u tactic_dashboard.py
```

另开一个 PowerShell 窗口：

```powershell
Set-Location -LiteralPath '你解压或克隆后的项目目录'
./.venv/Scripts/python.exe -u balanced_tactic.py
```

## API Key 安全

API key 只应保存在本机 `.env` 文件中。`.env`、策略记忆、控制台状态和虚拟环境都已加入 `.gitignore`。

```text
ARENA_HERO_API_KEY=你的_API_KEY
```

不要把 `.env`、终端输出截图或包含凭据的压缩包提交到 GitHub。更完整的处理方式见 [SECURITY.md](SECURITY.md)。

## 控制台

网页顶部显示连接状态、Tick、资源、人口、Core 和当前阶段。页面内可以修改：

- 生产顺序、最低数量、资源保留值和人口上限。
- 威胁警戒阈值与全面回防阈值。
- 工人采矿范围、探索范围和外出人数。
- 前期、中期、后期的扩张节奏。
- 先锋活动距离、游侠守卫比例和 Beacon 条件。
- Core 危险迁移、掩护兵力和工人撤离范围。
- 深色、浅色、夜蓝主题以及自定义页面、面板、卡片和主色。

所有“半径”和“距离”单位都是地图格子数。采矿半径是 Core 到矿点绕开已知障碍后的最大返航路径，不再只是坐标差；工人的去程与返航总路程还必须控制在两倍半径内。`Tick` 是游戏回合，不是现实时间。

控制台状态中的“有效半径 / 配置上限”表示本回合真正分配到的最远矿路程。例如 `6/10` 代表允许最多 10 格，但当前近矿已足够，最远只派到 6 格。无法可靠返航、绕墙后超出上限或完整循环过长的矿点会被跳过，空闲工人转为分区寻矿。

## 默认策略

仓库默认使用冻结的和平经济模型：`17 工人 / 1 先锋 / 1 游侠 = 19`，不进入人口维护费档位。默认关闭 Core 迁移和主动进攻，游侠留守 Core，空闲工人负责采矿与分区探索。

默认经济参数来自 2026 年 8 月 3 日的 243 Tick 实战遥测，包含 26 个采集或存入结果，训练置信度为 `high`。基础侦察工人数为 12，动态加成上限为 2，资源搜索半径为 24-44。原始 `.arena_hero_state.json` 含本地游戏状态，已被 `.gitignore` 排除，不随仓库发布；可发布的训练摘要保存在 `strategy_config.json` 的 `extensions.peace_economy_training` 中。

本次发布冻结时已保留最近 256 Tick，包含 13 次采集和 13 次存入。最新 256 Tick 候选偶然选中只有 1 个样本的 15 名侦察组，置信度降为 `low`，因此没有覆盖已经实时验证的 `high` 默认模型。去除个人游戏状态后的完整对比摘要保存在 `peace_economy_training_snapshot.json`。

积累新的本地遥测后，可重新训练并应用参数：

```powershell
./.venv/Scripts/python.exe peace_economy_training.py --apply
```

训练器默认拒绝用低置信度结果覆盖现有中高置信度模型。只有明确需要降级覆盖时才使用 `--force`。

## 项目结构

- `balanced_tactic.py`：战术决策与 Arena Hero 连接入口。
- `strategy_config.py`：配置模型、默认值和校验。
- `strategy_config.json`：控制台当前配置。
- `tactic_dashboard.py`：本地 HTTP 控制台服务。
- `dashboard/`：网页界面。
- `dashboard_state.py`：写入不含凭据的实时状态快照。
- `peace_economy_training.py`：从本地遥测训练和平经济默认参数。
- `peace_economy_training_snapshot.json`：当前发布所用模型与最新冻结候选的匿名汇总。
- `test_balanced_tactic.py`：战术行为测试。
- `test_strategy_config.py`：配置和控制台 API 测试。
- `verify.cmd`：本地完整验收入口。
- `.github/workflows/ci.yml`：GitHub Actions 自动测试。

## 开发与验证

```powershell
./verify.cmd
```

该脚本会自动准备环境，然后运行隐私与凭据扫描、完整单元测试、Python 编译检查、依赖一致性检查、Git 空白错误检查，并在本机安装 Node.js 时检查控制台 JavaScript。安全扫描只报告文件、行号和规则名称，不会打印疑似秘密值。GitHub Actions 会在每次 Push 和 Pull Request 时使用 Python 3.11 与 3.13 自动复验。参与开发前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 兼容性与更新

项目使用官方 `arena-hero` PyPI 包，不自行实现 WebSocket、重连、状态模型或命令提交协议。`requirements.txt` 将 SDK 限制在兼容的 `0.2.x` 系列；Dependabot 会定期检查 Python 依赖和 GitHub Actions 更新。

如果连接成功但在第一个 Turn 前停止，或出现协议字段校验错误，应先运行 `setup.cmd` 同步依赖，再重新启动战术。不要通过关闭 SDK 校验或修改虚拟环境中的包来绕过协议不兼容。

## 停止和重置

- 在策略窗口或控制台窗口按 `Ctrl+C` 停止。
- 如需重置策略记忆，先停止程序，再删除 `.arena_hero_state.json`。
- 不要删除 `.env`，否则下次启动会重新要求输入 API key。

## 常见问题

- `Python was not found`：安装 Python 3.11+ 后重新打开终端并再次运行 `setup.cmd`。
- `HTTP 401`：检查本机 `.env` 中的 key 是否完整、有效且没有多余引号或空格。
- 浏览器打不开：确认 `run_dashboard.cmd` 窗口仍在运行，再访问 `http://127.0.0.1:8765/`。
- 工人没有采集：查看控制台中的可见资源、工人目标和威胁等级；进入生存姿态时会暂停远距离探索。

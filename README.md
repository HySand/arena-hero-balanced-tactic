# Arena Hero 平衡战术

一个基于 Arena Hero 官方 `arena-hero` Python SDK 的持续运行战术。项目包含可测试的战术引擎、本地中文控制台、匿名训练数据采集、长期参数实验和 GitHub CI。

> 这是社区项目，不是 Arena Hero 官方客户端。仓库不包含 API key、账号信息、个人游戏状态或原始本地训练记录。

## 功能分区

- **战术**：经济、警戒、生存三种姿态，工人采集与探索，先锋和游侠防守，Core 安全控制。
- **配置**：经过校验的策略配置、热加载和公开默认值。
- **训练**：匿名 Tick 数据、和平经济遥测、数据包导出/合并和重复训练。
- **控制台**：本地 HTTP 服务、实时状态快照和静态网页。
- **运行保障**：集中路径、单实例锁、官方契约版本检查和兼容性保护。

实现代码位于 `arena_hero_tactic/` 的对应子目录；根目录六个 `.py` 入口只保留旧命令和旧导入兼容性，新代码统一使用规范子包。

## 运行要求

- Python 3.11 或更高版本。
- Arena Hero 官方 SDK `arena-hero>=0.2.9,<0.3`。
- Windows 10/11 可使用一键启动；Linux/macOS 可使用模块或 Shell 入口。
- Node.js 只用于开发阶段检查控制台 JavaScript，正常运行不需要。

## 快速开始

### Windows 一键启动

1. 安装 Python 3.11+，并勾选 `Add python.exe to PATH`。
2. 下载或克隆项目。
3. 双击 `启动控制台.vbs`，也可以双击 `run_all.cmd`。
4. 首次运行会创建 `.venv`、安装依赖，并提示输入 API key 与网页右上角的账号名。
5. 浏览器会打开 `http://127.0.0.1:8765/`。

单独启动：

```powershell
./scripts/setup.cmd
./scripts/run_dashboard.cmd
./scripts/run_tactic.cmd
```

手动使用规范模块：

```powershell
./.venv/Scripts/python.exe -u -m arena_hero_tactic.dashboard.server --open
./.venv/Scripts/python.exe -u -m arena_hero_tactic.tactic.engine
```

### Linux / macOS

```sh
python3 -m pip install -r requirements.txt
./scripts/run_tactic.sh
```

API key 写入项目根目录的 `.env`：

```text
ARENA_HERO_API_KEY=YOUR_API_KEY
ARENA_HERO_EXPECTED_USERNAME=YOUR_ARENA_USERNAME
```

`.env` 已被 Git 忽略。账号校验可防止 Key 控制到另一个 Arena 账号；不匹配时战术会在提交前停止。更换 Key 请双击 `scripts/enter_api_key.cmd`，脚本会保存本地配置并自动重启战术。不要把真实 Key、终端截图或含凭据的压缩包提交到 GitHub。

## 配置

- `config/strategy_config.json`：可提交的公开默认配置，新克隆在没有本地配置时读取它。
- `data/runtime/strategy_config.json`：控制台保存的本地运行配置，不上传 GitHub。
- `.env.example`：环境变量模板，不含真实凭据。

控制台保存配置后，战术通常会从下一个 Tick 热加载。配置包括生产顺序、资源保留、威胁阈值、采矿与探索范围、进攻门槛、守卫比例、Core 迁移和界面主题。

## 数据与重复训练

所有可变数据统一放在 `data/`：

| 路径 | 内容 | GitHub |
|---|---|---|
| `data/runtime/` | 地图记忆、控制台快照、锁、日志、实验状态、本地配置 | 忽略 |
| `data/training/turns.jsonl` | 通用匿名 Tick 训练记录 | 忽略 |
| `data/training/peace_economy_telemetry.jsonl` | 和平经济长期遥测 | 忽略 |
| `data/training/source.json` | 本机匿名来源标识 | 忽略 |
| `data/training/exports/` | 可交换训练包 | 忽略 |
| `data/models/` | 可公开的聚合模型与训练摘要 | 提交 |

程序会自动把旧根目录数据和上一版隐藏文件迁移到这些位置。原始 JSONL 保留在本机，可重复导出、合并和训练。

查看与导出通用数据：

```powershell
./.venv/Scripts/python.exe -m arena_hero_tactic.training.dataset status
./.venv/Scripts/python.exe -m arena_hero_tactic.training.dataset export `
  --output data/training/exports/my-run.zip
```

合并多个标准数据包：

```powershell
./.venv/Scripts/python.exe -m arena_hero_tactic.training.dataset merge `
  data/training/exports/my-run.zip other-player.zip `
  --output data/training/exports/merged.zip
```

从集中遥测重复训练和平经济参数：

```powershell
./.venv/Scripts/python.exe -m arena_hero_tactic.training.peace_economy --telemetry
```

可用 `--candidate-id radius-96` 和 `--measurements-only` 限定实验样本；确认结果后才添加 `--apply`。不同 `contract.rules_version` 的数据不能直接混合训练。

训练包格式为 `arena-hero-portable-training-dataset/v1`，包含 `manifest.json`、`schema.json` 和 `records.jsonl`。实体 ID 会按本机来源稳定匿名化，坐标转换为相对 Core 坐标，凭据与账号身份不会写入。

更多说明见 [data/README.md](data/README.md)。

## 长期实验

固定 `17 Worker / 1 Vanguard / 1 Ranger` 的实验计划在 `config/peace_economy_17_1_1.json`。开始或续跑：

```powershell
./scripts/run_peace_economy_experiment.cmd
```

查看、发布匿名汇总或停止实验：

```powershell
./.venv/Scripts/python.exe -m arena_hero_tactic.training.experiment status
./.venv/Scripts/python.exe -m arena_hero_tactic.training.experiment publish
./.venv/Scripts/python.exe -m arena_hero_tactic.training.experiment stop
```

实验不会把最后一个候选直接发布为生产默认值；候选必须满足样本量、结果事件和有效利用率门槛。

## 项目结构

```text
arena_hero_tactic/
  tactic/             战术决策和官方 SDK 循环
  configuration/      配置模型、默认值和校验
  training/           数据集、实验和训练
  dashboard/          状态投影与 HTTP 服务
  runtime/            路径、进程锁和版本保护
config/                可提交配置与实验计划
dashboard/             控制台 HTML/CSS/JavaScript
data/                  本地数据和可公开模型
scripts/               安装、运行、验证与安全脚本
tests/                 单元与契约测试
deploy/                Docker/systemd 长期运行资料
.github/               CI 与 Dependabot
```

完整依赖边界见 [docs/PROJECT_STRUCTURE.md](docs/PROJECT_STRUCTURE.md)。
当前战术的决策顺序、算法依据和未采用方案见 [docs/TACTIC_ALGORITHM.md](docs/TACTIC_ALGORITHM.md)。

## 开发与验证

```powershell
./scripts/verify.cmd
```

验证会运行：上传候选隐私扫描、完整单元测试、Python 编译、依赖一致性、Git 空白错误，以及可用时的 JavaScript 语法检查。GitHub Actions 会在 Python 3.11 和 3.13 上重复核心检查。

准备上传前按 [docs/GITHUB_UPLOAD.md](docs/GITHUB_UPLOAD.md) 检查。参与开发前阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 部署

Docker Compose：

```sh
docker compose up --build -d
```

容器把运行状态和训练数据统一写入 `/data` 命名卷。Linux systemd 说明见 [deploy/README.md](deploy/README.md)。

## 安全与兼容性

项目只使用官方 SDK，不自行实现 WebSocket、重连、状态模型或命令提交协议。启动时和默认每 240 Tick 检查官方 API、规则、SDK 与已审计版本；漂移或检查失败会在 `data/runtime/state/` 写入保护报告并停止继续提交 Turn。

安全报告和漏洞提交方式见 [SECURITY.md](SECURITY.md)。

# 贡献指南

## 开发环境

项目要求 Python 3.11 或更高版本。Windows：

```powershell
./scripts/setup.cmd
```

其他系统可创建自己的虚拟环境后执行 `python -m pip install -r requirements.txt`。

不要提交 `.env`、API key、`data/runtime/`、原始训练 JSONL、`data/training/source.json`、日志、虚拟环境或包含个人游戏数据的文件。

## 提交前验证

```powershell
./scripts/verify.cmd
```

脚本会先扫描实际 Git 上传候选且不显示匹配值，再运行单元测试、Python 编译、依赖检查、Git 空白错误检查，并在已安装 Node.js 时检查控制台 JavaScript。GitHub Actions 会在 Python 3.11 和 3.13 上重复核心检查。

## 修改代码

- 战术实现放在 `arena_hero_tactic/tactic/`；每个 Tick 只根据当前 `Turn` 的权威状态决策。
- 配置字段先加入 `configuration/strategy.py` 的模型、默认值和校验。
- 原始样本只写入 `data/training/`，可提交结果必须是匿名聚合模型。
- 规则数值与 SDK 接口必须以当前官方契约和官方 Python SDK 为准。
- 修改资源、战斗、迁移、生产、数据格式或安全行为时，补充对应回归测试。
- 新代码使用规范子包导入；项目根目录的六个旧入口只用于兼容，包根目录不再增加代理模块。

依赖边界见 `docs/PROJECT_STRUCTURE.md`。

## Pull Request

Pull Request 应说明用户可见行为、数据格式影响、主要实现取舍和验证结果。避免混入无关重构、生成文件、本地配置或运行数据。
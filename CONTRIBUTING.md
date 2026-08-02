# 贡献指南

## 开发环境

项目要求 Windows 和 Python 3.11 或更高版本。运行 `setup.cmd` 创建本地虚拟环境并安装依赖：

```powershell
./setup.cmd
```

不要提交 `.env`、API key、运行状态、日志、虚拟环境或包含个人游戏数据的文件。

## 提交前验证

运行统一验收脚本：

```powershell
./verify.cmd
```

该脚本会先运行不显示匹配值的隐私与凭据扫描，再运行单元测试、Python 编译检查、依赖检查、Git 空白错误检查，并在已安装 Node.js 时检查控制台 JavaScript 语法。GitHub Actions 会在 Python 3.11 和 3.13 上重复核心检查。

## 修改战术

- 每个 Tick 只能根据当前 `Turn` 的权威状态决策，不要复用旧的 Unit 或 Core 控制对象。
- 规则相关数值与 SDK 接口必须以 Arena Hero 当前官方文档和官方 Python SDK 为准。
- 修改资源、战斗、迁移、生产或安全行为时，应补充对应的回归测试。
- 保持决策逻辑与网络连接入口分离，确保测试不需要真实 API key 或在线游戏。

## Pull Request

Pull Request 应说明用户可见行为、主要实现取舍和验证结果。避免混入无关重构、生成文件或本地配置变化。

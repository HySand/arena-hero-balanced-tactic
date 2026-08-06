# GitHub 上传清单

## 上传前验证

在项目根目录运行：

```powershell
./scripts/verify.cmd
```

该命令会扫描实际上传候选，不显示疑似密钥值，并运行测试、编译和依赖检查。必须看到 `All available checks passed.`。

确认以下内容不会进入提交：

```text
.env
.venv/
__pycache__/
data/runtime/
data/training/*.jsonl
data/training/source.json
data/training/exports/
*.log
*.zip
```

`data/models/`、`config/`、代码、测试和文档应进入提交。

## 首次建仓

项目当前没有 Git 元数据时，可以执行：

```powershell
git init
git add .
git status --short
git diff --cached --check
git commit -m "Organize tactic, training data, and runtime layout"
```

先在 GitHub 创建一个空仓库，不要额外生成 README 或 `.gitignore`，然后按 GitHub 给出的地址连接并推送：

```powershell
git branch -M main
git remote add origin YOUR_REPOSITORY_URL
git push -u origin main
```

## 人工复核

1. `git status --short` 中不能出现 `.env`、运行状态、原始训练 JSONL、日志或本地导出包。
2. 仓库中不应有超过 5MB 的意外文件；安全扫描会阻止这类上传候选。
3. 公开仓库需要根据你的授权意图选择并添加 `LICENSE`；不要随意套用不理解的许可证。
4. 检查 Git 提交姓名和邮箱。需要隐藏邮箱时使用 GitHub noreply 地址。
5. 推送后确认 GitHub Actions 的 Python 3.11 与 3.13 任务都通过。

原始训练数据如需共享，优先使用 `training.dataset export` 生成匿名包并通过单独的数据发布渠道传递，不要直接塞进主代码仓库。
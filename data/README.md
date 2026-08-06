# 数据目录

`data/` 是项目唯一的可变数据根目录。代码、脚本和容器都通过 `arena_hero_tactic.runtime.paths` 读取这些位置；需要部署到其他磁盘时使用对应的 `ARENA_HERO_*_FILE` 环境变量覆盖。

## 目录职责

```text
data/
  runtime/
    strategy_config.json       本地热加载配置
    state/                     地图、控制台、实验与版本状态
    locks/                     单实例锁
    logs/                      tactic/dashboard 日志
  training/
    turns.jsonl                通用匿名 Tick 数据
    peace_economy_telemetry.jsonl
    source.json                本机匿名来源 ID
    exports/                   标准 ZIP 数据包
  models/
    peace_economy_training_snapshot.json
```

`runtime/`、原始 JSONL、`source.json` 和导出包均被 `.gitignore` 与 `.dockerignore` 排除。`models/` 只存放可公开的聚合结果，可以提交 GitHub。

## 备份与复用

停止战术后备份整个 `data/training/` 即可保留训练材料。恢复时放回同一路径；不要手工合并 JSONL，使用数据集命令去重：

```powershell
python -m arena_hero_tactic.training.dataset export --output data/training/exports/run.zip
python -m arena_hero_tactic.training.dataset merge run-a.zip run-b.zip --output data/training/exports/merged.zip
```

和平经济遥测可直接重复训练：

```powershell
python -m arena_hero_tactic.training.peace_economy --telemetry
```

长期实验比较候选时，建议同时使用 `--candidate-id` 与 `--measurements-only`，避免把预热、准备阶段或不同候选混为同一训练组。

## 隐私边界

通用训练记录不写 API key、用户名、邮箱或原始实体 UUID。安装级 `source_id` 仍属于本地标识，因此 `source.json` 不提交。导出 ZIP 适合主动交换匿名数据，但发布前仍应运行 `scripts/security_check.ps1`。
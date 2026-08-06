# 长期运行

## Docker Compose

1. 在项目根目录创建 `.env`，写入 `ARENA_HERO_API_KEY=...`。
2. 执行 `docker compose up --build -d`。
3. 查看 `docker compose logs -f tactic`。
4. 打开 `http://127.0.0.1:8765/`。

运行配置、地图状态、实验状态和训练 JSONL 都写入 `arena-hero-data` 命名卷的 `/data` 目录。兼容性不通过时，tactic 会在 `/data/runtime/state/` 生成保护标记并停止提交。

备份命名卷前先停止服务：

```sh
docker compose down
docker run --rm -v arena-hero-balanced-tactic-main_arena-hero-data:/data -v "$PWD":/backup alpine tar czf /backup/arena-hero-data.tar.gz -C /data .
```

实际卷名前缀可能随 Compose 项目名变化，可先运行 `docker volume ls` 确认。

## Linux systemd

把 `arenahero-tactic.service` 复制到 `~/.config/systemd/user/`，将其中项目路径改成实际位置，然后执行：

```sh
systemctl --user daemon-reload
systemctl --user enable --now arenahero-tactic.service
systemctl --user status arenahero-tactic.service
```

若需要在无人登录时持续运行：

```sh
loginctl enable-linger "$USER"
```

## Windows / macOS / Linux 本地

Windows 使用 `scripts/run_tactic.cmd` 或根目录 `run_all.cmd`；macOS/Linux 使用 `./scripts/run_tactic.sh`。首次运行前安装 Python 3.11+，并在项目根目录 `.env` 提供 API key。
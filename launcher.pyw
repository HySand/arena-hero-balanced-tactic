"""One-click Windows launcher for the Arena Hero tactic and dashboard."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import webbrowser
from pathlib import Path
from urllib.error import URLError
from urllib.request import Request, urlopen

from arena_hero_tactic.runtime.process_lock import _process_exists


ROOT = Path(__file__).resolve().parent
PYTHONW = ROOT / ".venv" / "Scripts" / "pythonw.exe"
PYTHON = ROOT / ".venv" / "Scripts" / "python.exe"
DASHBOARD_URL = "http://127.0.0.1:8765/"
OFFICIAL_ARENA_URL = "https://app.arenahero.io/arena"
DASHBOARD_HEALTH_URL = f"{DASHBOARD_URL}api/health"
TACTIC_LOCK = ROOT / "data" / "runtime" / "locks" / "tactic.lock"
DASHBOARD_LOCK = ROOT / "data" / "runtime" / "locks" / "dashboard.lock"
API_KEY_FILE = ROOT / ".env"
API_KEY_PROMPT = ROOT / "scripts" / "enter_api_key.ps1"
CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
SERVICE_READY_CHECKS = 4


def _message(title: str, message: str, *, error: bool = False) -> None:
    try:
        import ctypes

        flags = 0x10 if error else 0x40
        ctypes.windll.user32.MessageBoxW(0, message, title, flags)
    except Exception:
        pass


def _dotenv_values() -> dict[str, str]:
    if not API_KEY_FILE.is_file():
        return {}
    values: dict[str, str] = {}
    try:
        for raw_line in API_KEY_FILE.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue
            name, separator, value = line.partition("=")
            if separator:
                values[name.strip()] = value.strip().strip('"').strip("'")
    except OSError:
        return {}
    return values


def _lock_active(path: Path) -> bool:
    try:
        owner_pid = int(path.read_text(encoding="ascii").strip())
    except (FileNotFoundError, OSError, TypeError, ValueError):
        return False
    return _process_exists(owner_pid)


def _dashboard_online() -> bool:
    try:
        request = Request(DASHBOARD_HEALTH_URL, headers={"Cache-Control": "no-cache"})
        with urlopen(request, timeout=1.5) as response:  # nosec B310: fixed localhost URL
            payload = json.load(response)
        return bool(isinstance(payload, dict) and payload.get("ok"))
    except (OSError, URLError, ValueError, json.JSONDecodeError):
        return False


def _run_hidden(command: list[str], *, capture: bool = False) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        cwd=ROOT,
        env=os.environ.copy(),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
        stderr=subprocess.PIPE if capture else subprocess.DEVNULL,
        text=True,
        creationflags=CREATE_NO_WINDOW,
        check=False,
    )


def _ensure_environment() -> bool:
    if PYTHONW.is_file() and PYTHON.is_file():
        return True
    _message("Arena Hero", "正在准备运行环境，请稍候……")
    result = _run_hidden(["cmd.exe", "/d", "/c", str(ROOT / "scripts" / "setup.cmd")], capture=True)
    if result.returncode == 0 and PYTHONW.is_file() and PYTHON.is_file():
        return True
    detail = (result.stderr or result.stdout or "setup.cmd failed").strip()
    _message("Arena Hero", f"运行环境准备失败：\n\n{detail[-1200:]}", error=True)
    return False


def _ensure_api_key() -> str | None:
    key = _dotenv_values().get("ARENA_HERO_API_KEY", "").strip()
    if key:
        return key
    if not API_KEY_PROMPT.is_file():
        _message("Arena Hero", "找不到 API key 输入脚本。", error=True)
        return None
    result = _run_hidden(
        [
            "powershell.exe",
            "-NoLogo",
            "-NoProfile",
            "-STA",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            str(API_KEY_PROMPT),
        ],
        capture=True,
    )
    if result.returncode != 0:
        _message("Arena Hero", "没有保存 API key，启动已取消。", error=True)
        return None
    key = _dotenv_values().get("ARENA_HERO_API_KEY", "").strip()
    if not key:
        _message("Arena Hero", "API key 为空，启动已取消。", error=True)
        return None
    return key


def _background_environment(api_key: str | None = None) -> dict[str, str]:
    environment = os.environ.copy()
    environment.pop("ARENA_HERO_API_KEY", None)
    if api_key:
        environment["ARENA_HERO_API_KEY"] = api_key
    environment["PYTHONUNBUFFERED"] = "1"
    return environment


def _start_background(
    module_name: str,
    log_name: str,
    error_name: str,
    *,
    api_key: str | None = None,
) -> None:
    log_dir = ROOT / "data" / "runtime" / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    output_path = log_dir / log_name
    error_path = log_dir / error_name
    output = output_path.open("a", encoding="utf-8")
    errors = error_path.open("a", encoding="utf-8")
    try:
        subprocess.Popen(
            [str(PYTHON), "-u", "-m", module_name],
            cwd=ROOT,
            env=_background_environment(api_key),
            stdin=subprocess.DEVNULL,
            stdout=output,
            stderr=errors,
            creationflags=CREATE_NO_WINDOW,
            close_fds=True,
        )
    finally:
        output.close()
        errors.close()


def _ensure_services(api_key: str) -> bool:
    if not _dashboard_online() and not _lock_active(DASHBOARD_LOCK):
        _start_background(
            "arena_hero_tactic.dashboard.server",
            "dashboard.log",
            "dashboard.error.log",
        )
    if not _lock_active(TACTIC_LOCK):
        _start_background(
            "arena_hero_tactic.tactic.engine",
            "tactic.log",
            "tactic.error.log",
            api_key=api_key,
        )
    deadline = time.monotonic() + 30.0
    ready_checks = 0
    while time.monotonic() < deadline:
        if _dashboard_online() and _lock_active(TACTIC_LOCK):
            ready_checks += 1
            if ready_checks >= SERVICE_READY_CHECKS:
                return True
        else:
            ready_checks = 0
        time.sleep(0.5)
    return _dashboard_online() and _lock_active(TACTIC_LOCK)


def _open_control_pages() -> None:
    """Open both local strategy controls and the official manual arena view."""

    webbrowser.open(DASHBOARD_URL)
    time.sleep(0.2)
    webbrowser.open(OFFICIAL_ARENA_URL)


def _check() -> int:
    document = {
        "environment": PYTHONW.is_file() and PYTHON.is_file(),
        "dashboard_online": _dashboard_online(),
        "tactic_lock_active": _lock_active(TACTIC_LOCK),
        "dashboard_lock_active": _lock_active(DASHBOARD_LOCK),
        "api_key_configured": bool(_dotenv_values().get("ARENA_HERO_API_KEY", "").strip()),
    }
    print(json.dumps(document, ensure_ascii=False))
    return 0 if document["environment"] else 1


def main() -> int:
    if "--check" in sys.argv:
        return _check()
    if not _ensure_environment():
        return 1
    dashboard_running = _dashboard_online()
    tactic_running = _lock_active(TACTIC_LOCK)
    api_key = _dotenv_values().get("ARENA_HERO_API_KEY", "").strip()
    if not (dashboard_running and tactic_running):
        api_key = _ensure_api_key()
        if not api_key:
            return 1
        if not _ensure_services(api_key):
            _message(
                "Arena Hero",
                "后台服务未能在 30 秒内就绪。请查看 data\\runtime\\logs 目录中的运行日志。",
                error=True,
            )
            return 1
    _open_control_pages()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

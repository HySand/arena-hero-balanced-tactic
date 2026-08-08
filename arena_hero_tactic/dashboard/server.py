"""Local, dependency-free Arena Hero tactic dashboard and configuration API."""

from __future__ import annotations

import argparse
import json
import ipaddress
import mimetypes
import time
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from .state import STATUS_FILE
from .control import (
    ControlCommandError,
    clear_control_commands,
    load_control_receipt,
    pending_control_commands,
    queue_control_command,
)
from ..runtime.process_lock import InstanceAlreadyRunning, SingleInstanceLock
from ..configuration.strategy import (
    CONFIG_FILE,
    CONFIG_SCHEMA,
    StrategyConfigError,
    default_config_dict,
    load_strategy_config,
    save_strategy_config,
)


from ..runtime.paths import (
    CONTROL_DIR,
    CONTROL_RECEIPT_FILE,
    DASHBOARD_LOCK_FILE,
    STATIC_DIR,
)
MAX_REQUEST_BYTES = 64 * 1024
ONLINE_GRACE_SECONDS = 90


def _report_os_error(operation: str, error: OSError) -> None:
    errno = error.errno if error.errno is not None else "unknown"
    print(
        f"dashboard_internal_error operation={operation} errno={errno}",
        flush=True,
    )


class TacticDashboardServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(
        self,
        server_address: tuple[str, int],
        *,
        config_path: Path = CONFIG_FILE,
        status_path: Path = STATUS_FILE,
        control_dir: Path = CONTROL_DIR,
        control_receipt_path: Path = CONTROL_RECEIPT_FILE,
        static_dir: Path = STATIC_DIR,
    ) -> None:
        self.config_path = config_path
        self.status_path = status_path
        self.control_dir = control_dir
        self.control_receipt_path = control_receipt_path
        self.static_dir = static_dir
        super().__init__(server_address, TacticDashboardHandler)


class TacticDashboardHandler(BaseHTTPRequestHandler):
    server: TacticDashboardServer
    protocol_version = "HTTP/1.1"

    def log_message(self, format_string: str, *args: Any) -> None:
        print(
            f"dashboard {self.client_address[0]} "
            f"{format_string % args}",
            flush=True,
        )

    def _send_bytes(
        self,
        status: HTTPStatus,
        body: bytes,
        content_type: str,
        *,
        no_store: bool = False,
    ) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; style-src 'self'; script-src 'self'; "
            "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
        )
        self.send_header("Cache-Control", "no-store" if no_store else "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def _send_json(self, status: HTTPStatus, document: Any) -> None:
        body = json.dumps(document, ensure_ascii=False, separators=(",", ":")).encode(
            "utf-8"
        )
        self._send_bytes(
            status,
            body,
            "application/json; charset=utf-8",
            no_store=True,
        )

    def _send_error_json(self, status: HTTPStatus, message: str) -> None:
        self._send_json(status, {"ok": False, "error": message})

    def _path(self) -> str:
        return urlsplit(self.path).path

    def do_OPTIONS(self) -> None:  # noqa: N802 - stdlib handler contract
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Allow", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802 - stdlib handler contract
        path = self._path()
        if path == "/api/health":
            self._send_json(HTTPStatus.OK, {"ok": True, "service": "arena-hero-ui"})
            return
        if path == "/api/schema":
            self._send_json(HTTPStatus.OK, CONFIG_SCHEMA)
            return
        if path == "/api/config":
            try:
                config = load_strategy_config(self.server.config_path, strict=True)
            except StrategyConfigError as error:
                self._send_error_json(HTTPStatus.UNPROCESSABLE_ENTITY, str(error))
                return
            self._send_json(HTTPStatus.OK, config.to_dict())
            return
        if path == "/api/status":
            self._send_status()
            return
        if path == "/api/control":
            self._send_control_queue()
            return
        self._send_static(path)

    def _loopback_only(self) -> bool:
        try:
            return ipaddress.ip_address(self.client_address[0]).is_loopback
        except ValueError:
            return False

    def _send_control_queue(self) -> None:
        if not self._loopback_only():
            self._send_error_json(HTTPStatus.FORBIDDEN, "control is local-only")
            return
        self._send_json(
            HTTPStatus.OK,
            {
                "ok": True,
                "pending": pending_control_commands(self.server.control_dir),
                "last_receipt": load_control_receipt(self.server.control_receipt_path),
            },
        )

    def _read_json_body(self) -> dict[str, Any]:
        if self.headers.get_content_type() != "application/json":
            raise ControlCommandError("Content-Type must be application/json")
        raw_length = self.headers.get("Content-Length")
        try:
            length = int(raw_length or "0")
        except ValueError as error:
            raise ControlCommandError("invalid Content-Length") from error
        if not 0 < length <= MAX_REQUEST_BYTES:
            raise ControlCommandError("request body must be between 1 byte and 64 KiB")
        try:
            document = json.loads(self.rfile.read(length).decode("utf-8"))
        except UnicodeDecodeError as error:
            raise ControlCommandError("body must be UTF-8") from error
        except json.JSONDecodeError as error:
            raise ControlCommandError(
                f"invalid JSON at line {error.lineno} column {error.colno}"
            ) from error
        if not isinstance(document, dict):
            raise ControlCommandError("body must be a JSON object")
        return document

    def do_POST(self) -> None:  # noqa: N802 - stdlib handler contract
        if self._path() != "/api/control":
            self._send_error_json(HTTPStatus.NOT_FOUND, "endpoint not found")
            return
        if not self._loopback_only():
            self._send_error_json(HTTPStatus.FORBIDDEN, "control is local-only")
            return
        try:
            command = queue_control_command(
                self._read_json_body(),
                self.server.control_dir,
            )
        except ControlCommandError as error:
            self._send_error_json(HTTPStatus.UNPROCESSABLE_ENTITY, str(error))
            return
        self._send_json(
            HTTPStatus.ACCEPTED,
            {"ok": True, "message": "指令已排队，将在下一个可用 Tick 覆盖目标动作", "command": command},
        )

    def do_DELETE(self) -> None:  # noqa: N802 - stdlib handler contract
        if self._path() != "/api/control":
            self._send_error_json(HTTPStatus.NOT_FOUND, "endpoint not found")
            return
        if not self._loopback_only():
            self._send_error_json(HTTPStatus.FORBIDDEN, "control is local-only")
            return
        removed = clear_control_commands(self.server.control_dir)
        self._send_json(HTTPStatus.OK, {"ok": True, "removed": removed})

    def do_PUT(self) -> None:  # noqa: N802 - stdlib handler contract
        if self._path() != "/api/config":
            self._send_error_json(HTTPStatus.NOT_FOUND, "endpoint not found")
            return
        raw_length = self.headers.get("Content-Length")
        try:
            length = int(raw_length or "0")
        except ValueError:
            self._send_error_json(HTTPStatus.BAD_REQUEST, "invalid Content-Length")
            return
        if not 0 < length <= MAX_REQUEST_BYTES:
            self._send_error_json(
                HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
                "configuration body must be between 1 byte and 64 KiB",
            )
            return
        try:
            document = json.loads(self.rfile.read(length).decode("utf-8"))
            config = save_strategy_config(document, self.server.config_path)
        except UnicodeDecodeError:
            self._send_error_json(HTTPStatus.BAD_REQUEST, "body must be UTF-8")
            return
        except json.JSONDecodeError as error:
            self._send_error_json(
                HTTPStatus.BAD_REQUEST,
                f"invalid JSON at line {error.lineno} column {error.colno}",
            )
            return
        except StrategyConfigError as error:
            self._send_error_json(HTTPStatus.UNPROCESSABLE_ENTITY, str(error))
            return
        except OSError as error:
            _report_os_error("config_save", error)
            self._send_error_json(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                "cannot save configuration",
            )
            return
        self._send_json(
            HTTPStatus.OK,
            {
                "ok": True,
                "message": "配置已保存，将在下一个 Turn 自动生效",
                "config": config.to_dict(),
            },
        )

    def _send_status(self) -> None:
        try:
            if not self.server.status_path.is_file():
                self._send_json(
                    HTTPStatus.OK,
                    {
                        "online": False,
                        "stale": True,
                        "message": "战术尚未写入运行状态，请先启动 balanced_tactic.py",
                    },
                )
                return
            document = json.loads(self.server.status_path.read_text(encoding="utf-8"))
            updated_at = float(document.get("updated_at", 0))
            age = max(0.0, time.time() - updated_at)
            document["age_seconds"] = round(age, 1)
            document["stale"] = age > ONLINE_GRACE_SECONDS
            document["online"] = not document["stale"]
            self._send_json(HTTPStatus.OK, document)
        except (OSError, ValueError, TypeError, json.JSONDecodeError) as error:
            if isinstance(error, OSError):
                _report_os_error("status_read", error)
            self._send_error_json(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                "cannot read tactic status",
            )

    def _send_static(self, path: str) -> None:
        files = {
            "/": "index.html",
            "/index.html": "index.html",
            "/app.js": "app.js",
            "/styles.css": "styles.css",
        }
        filename = files.get(path)
        if filename is None:
            self._send_error_json(HTTPStatus.NOT_FOUND, "not found")
            return
        target = self.server.static_dir / filename
        try:
            body = target.read_bytes()
        except OSError:
            self._send_error_json(HTTPStatus.NOT_FOUND, "static asset not found")
            return
        content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if content_type.startswith("text/") or content_type in {
            "application/javascript",
            "application/json",
        }:
            content_type += "; charset=utf-8"
        self._send_bytes(HTTPStatus.OK, body, content_type)


def create_server(
    host: str = "127.0.0.1",
    port: int = 8765,
    *,
    config_path: Path = CONFIG_FILE,
    status_path: Path = STATUS_FILE,
    control_dir: Path = CONTROL_DIR,
    control_receipt_path: Path = CONTROL_RECEIPT_FILE,
    static_dir: Path = STATIC_DIR,
) -> TacticDashboardServer:
    return TacticDashboardServer(
        (host, port),
        config_path=config_path,
        status_path=status_path,
        control_dir=control_dir,
        control_receipt_path=control_receipt_path,
        static_dir=static_dir,
    )


def _main_locked() -> None:
    parser = argparse.ArgumentParser(description="Arena Hero local tactic dashboard")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument(
        "--open",
        action="store_true",
        help="open the dashboard in the default browser after startup",
    )
    args = parser.parse_args()
    if not CONFIG_FILE.exists():
        save_strategy_config(default_config_dict(), CONFIG_FILE)
    server = create_server(args.host, args.port)
    url = f"http://{args.host}:{server.server_port}/"
    if args.host not in {"127.0.0.1", "localhost", "::1"}:
        print("Warning: dashboard has no login; bind only on a trusted network.")
    print(f"Arena Hero dashboard: {url}", flush=True)
    print("Press Ctrl-C to stop the dashboard.", flush=True)
    if args.open:
        webbrowser.open(url)
    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        print("Dashboard stopped.")
    finally:
        server.server_close()


def main() -> None:
    try:
        with SingleInstanceLock(DASHBOARD_LOCK_FILE):
            _main_locked()
    except InstanceAlreadyRunning as error:
        print(f"dashboard_not_started={error}", flush=True)


if __name__ == "__main__":
    main()

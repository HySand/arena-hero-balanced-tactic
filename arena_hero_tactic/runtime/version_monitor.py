"""Fail-closed Arena Hero API/rules/SDK compatibility checks.

The tactic is intentionally deterministic during a Turn.  Compatibility work
therefore lives outside the decision functions and only writes a small JSON
report plus a hold marker.  A marker means that unattended play must stop
until the operator has reviewed the changed contract and released a compatible
configuration.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import tempfile
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from html.parser import HTMLParser
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from typing import Any, Mapping
from urllib.request import Request, urlopen

SOURCE_VERSION_URL = "https://doc.arenahero.io/reference/source-and-version"
PYPI_URL = "https://pypi.org/pypi/arena-hero/json"

REVIEWED_API_VERSION = "v0.1"
REVIEWED_GAMEPLAY_VERSION = "v0.14"
REVIEWED_SDK_VERSION = "0.2.9"
REVIEWED_SERVER_COMMIT = "b24cfcd22b82c0af0f3993397d2696629762e7e5"
REVIEWED_SDK_COMMIT = "423d252adcca439669adb3e7b04252e53b4430bd"

VERSION_RE = re.compile(r"^[0-9]+(?:\.[0-9]+){1,2}(?:[A-Za-z0-9.+-]*)$")
COMMIT_RE = re.compile(r"^[0-9a-f]{40}$")

from .paths import (
    COMPATIBILITY_HOLD_FILE as DEFAULT_MARKER_PATH,
    VERSION_REPORT_FILE as DEFAULT_REPORT_PATH,
)


class VersionCheckError(RuntimeError):
    """Raised when a remote contract is missing or malformed."""


class _PageText(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.parts: list[str] = []

    def handle_data(self, data: str) -> None:
        stripped = data.strip()
        if stripped:
            self.parts.append(stripped)

    @property
    def text(self) -> str:
        return "\n".join(self.parts)


@dataclass(frozen=True, slots=True)
class ContractVersion:
    api: str
    gameplay: str
    server_commit: str
    sdk: str
    sdk_commit: str


def _required_match(pattern: str, text: str, field: str) -> str:
    match = re.search(pattern, text, flags=re.IGNORECASE | re.DOTALL)
    if match is None:
        raise VersionCheckError(f"contract_{field}_missing")
    return match.group(1)


def parse_contract_page(page: str) -> ContractVersion:
    """Parse the public source/version page without trusting arbitrary HTML."""
    parser = _PageText()
    parser.feed(page)
    text = parser.text
    api = _required_match(
        r"HTTP and WebSocket API\s+(v[0-9]+\.[0-9]+)", text, "api"
    )
    gameplay = _required_match(
        r"Gameplay rules\s+(v[0-9]+\.[0-9]+)", text, "gameplay"
    )
    server_commit = _required_match(
        r"Reviewed server commit\s+([0-9a-f]{40})", text, "server_commit"
    ).lower()
    sdk_section = _required_match(
        r"Python SDK\s+(.*?)\s+Reviewed SDK commit", text, "sdk_section"
    )
    sdk = _required_match(
        r"(?:^|[^0-9])v?([0-9]+\.[0-9]+\.[0-9]+)(?:[^0-9]|$)",
        sdk_section,
        "sdk",
    )
    sdk_commit = _required_match(
        r"Reviewed SDK commit\s+([0-9a-f]{40})", text, "sdk_commit"
    ).lower()
    if not VERSION_RE.fullmatch(api.removeprefix("v")):
        raise VersionCheckError("contract_api_invalid")
    if not VERSION_RE.fullmatch(gameplay.removeprefix("v")):
        raise VersionCheckError("contract_gameplay_invalid")
    if not VERSION_RE.fullmatch(sdk):
        raise VersionCheckError("contract_sdk_invalid")
    if not COMMIT_RE.fullmatch(server_commit) or not COMMIT_RE.fullmatch(sdk_commit):
        raise VersionCheckError("contract_commit_invalid")
    return ContractVersion(api, gameplay, server_commit, sdk, sdk_commit)


def parse_pypi_version(payload: Mapping[str, Any]) -> str:
    info = payload.get("info")
    latest = info.get("version") if isinstance(info, Mapping) else None
    if not isinstance(latest, str) or not VERSION_RE.fullmatch(latest):
        raise VersionCheckError("pypi_version_invalid")
    return latest


def _timestamp(now: datetime | None = None) -> str:
    return (now or datetime.now(UTC)).astimezone(UTC).isoformat().replace(
        "+00:00", "Z"
    )


def atomic_write_json(path: Path, value: Mapping[str, Any]) -> None:
    """Write reports atomically so supervisors never see half a marker."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=path.parent,
            prefix=f".{path.name}.", delete=False
        ) as handle:
            temporary = Path(handle.name)
            json.dump(value, handle, ensure_ascii=False, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        temporary = None
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def evaluate_versions(
    *,
    installed_sdk: str,
    pypi_sdk: str,
    contract: ContractVersion,
    marker_path: Path = DEFAULT_MARKER_PATH,
    report_path: Path = DEFAULT_REPORT_PATH,
    now: datetime | None = None,
) -> dict[str, Any]:
    if not VERSION_RE.fullmatch(installed_sdk):
        raise VersionCheckError("installed_sdk_invalid")
    if not VERSION_RE.fullmatch(pypi_sdk):
        raise VersionCheckError("pypi_version_invalid")
    observed = {"installed_sdk": installed_sdk, "pypi_sdk": pypi_sdk, **asdict(contract)}
    reviewed = {
        "api": REVIEWED_API_VERSION,
        "gameplay": REVIEWED_GAMEPLAY_VERSION,
        "server_commit": REVIEWED_SERVER_COMMIT,
        "sdk": REVIEWED_SDK_VERSION,
        "sdk_commit": REVIEWED_SDK_COMMIT,
    }
    reasons: list[str] = []
    if installed_sdk != REVIEWED_SDK_VERSION:
        reasons.append("installed_sdk_changed")
    if pypi_sdk != REVIEWED_SDK_VERSION:
        reasons.append("pypi_sdk_changed")
    if installed_sdk != pypi_sdk:
        reasons.append("installed_sdk_not_latest")
    for field in ("api", "gameplay", "server_commit", "sdk", "sdk_commit"):
        if observed[field] != reviewed[field]:
            reasons.append(f"contract_{field}_changed")
    report: dict[str, Any] = {
        "schema_version": 1,
        "checked_at": _timestamp(now),
        "status": "incompatible" if reasons else "compatible",
        "hold": bool(reasons),
        "reasons": reasons,
        "observed": observed,
        "reviewed": reviewed,
    }
    atomic_write_json(report_path, report)
    if reasons:
        atomic_write_json(marker_path, report)
    else:
        marker_path.unlink(missing_ok=True)
    return report


def record_check_failure(
    *,
    marker_path: Path = DEFAULT_MARKER_PATH,
    report_path: Path = DEFAULT_REPORT_PATH,
    error: Exception,
    now: datetime | None = None,
) -> dict[str, Any]:
    report: dict[str, Any] = {
        "schema_version": 1,
        "checked_at": _timestamp(now),
        "status": "check_failed",
        "hold": True,
        "reasons": [f"check_failed:{type(error).__name__}"],
    }
    atomic_write_json(report_path, report)
    atomic_write_json(marker_path, report)
    return report


def _fetch_json(url: str, timeout: float) -> Mapping[str, Any]:
    request = Request(url, headers={"User-Agent": "balanced-tactic-version-monitor/1.0"})
    with urlopen(request, timeout=timeout) as response:  # nosec B310: fixed HTTPS URLs
        payload = json.load(response)
    if not isinstance(payload, Mapping):
        raise VersionCheckError("remote_json_invalid")
    return payload


def _fetch_text(url: str, timeout: float) -> str:
    request = Request(url, headers={"User-Agent": "balanced-tactic-version-monitor/1.0"})
    with urlopen(request, timeout=timeout) as response:  # nosec B310: fixed HTTPS URLs
        return response.read().decode("utf-8")


def run_check(
    *,
    marker_path: Path = DEFAULT_MARKER_PATH,
    report_path: Path = DEFAULT_REPORT_PATH,
    timeout: float = 8.0,
    installed_sdk: str | None = None,
) -> dict[str, Any]:
    try:
        installed = installed_sdk or version("arena-hero")
        pypi_sdk = parse_pypi_version(_fetch_json(PYPI_URL, timeout))
        contract = parse_contract_page(_fetch_text(SOURCE_VERSION_URL, timeout))
        return evaluate_versions(
            installed_sdk=installed,
            pypi_sdk=pypi_sdk,
            contract=contract,
            marker_path=marker_path,
            report_path=report_path,
        )
    except (PackageNotFoundError, OSError, ValueError, VersionCheckError) as error:
        return record_check_failure(
            marker_path=marker_path, report_path=report_path, error=error
        )


def compatibility_hold_active(marker_path: Path = DEFAULT_MARKER_PATH) -> bool:
    try:
        payload = json.loads(marker_path.read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, json.JSONDecodeError):
        return False
    return bool(isinstance(payload, Mapping) and payload.get("hold"))


def _path_from_env(name: str, default: Path) -> Path:
    raw = os.environ.get(name)
    return Path(raw).expanduser() if raw else default


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Check Arena Hero compatibility.")
    parser.add_argument("--marker", type=Path, default=_path_from_env("ARENA_HERO_COMPAT_MARKER", DEFAULT_MARKER_PATH))
    parser.add_argument("--report", type=Path, default=_path_from_env("ARENA_HERO_COMPAT_REPORT", DEFAULT_REPORT_PATH))
    args = parser.parse_args(argv)
    report = run_check(marker_path=args.marker, report_path=args.report)
    print(f"version_check status={report['status']} hold={int(report['hold'])}", flush=True)
    return 0 if report["status"] == "compatible" else 1


if __name__ == "__main__":
    raise SystemExit(main())

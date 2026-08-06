from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from arena_hero_tactic.runtime.version_monitor import (
    ContractVersion,
    REVIEWED_API_VERSION,
    REVIEWED_GAMEPLAY_VERSION,
    REVIEWED_SDK_COMMIT,
    REVIEWED_SDK_VERSION,
    REVIEWED_SERVER_COMMIT,
    compatibility_hold_active,
    evaluate_versions,
    parse_contract_page,
    record_check_failure,
)


CONTRACT_PAGE = f"""
<html><body>
HTTP and WebSocket API {REVIEWED_API_VERSION}
Gameplay rules {REVIEWED_GAMEPLAY_VERSION}
Reviewed server commit {REVIEWED_SERVER_COMMIT}
Python SDK {REVIEWED_SDK_VERSION} Reviewed SDK commit {REVIEWED_SDK_COMMIT}
</body></html>
"""


class VersionMonitorTests(unittest.TestCase):
    def test_parse_contract_page_extracts_reviewed_values(self) -> None:
        contract = parse_contract_page(CONTRACT_PAGE)
        self.assertEqual(contract.api, REVIEWED_API_VERSION)
        self.assertEqual(contract.gameplay, REVIEWED_GAMEPLAY_VERSION)
        self.assertEqual(contract.sdk, REVIEWED_SDK_VERSION)

    def test_compatible_report_removes_stale_marker(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            marker = root / "hold.json"
            report = root / "report.json"
            marker.write_text('{"hold": true}\n', encoding="utf-8")
            result = evaluate_versions(
                installed_sdk=REVIEWED_SDK_VERSION,
                pypi_sdk=REVIEWED_SDK_VERSION,
                contract=ContractVersion(
                    REVIEWED_API_VERSION,
                    REVIEWED_GAMEPLAY_VERSION,
                    REVIEWED_SERVER_COMMIT,
                    REVIEWED_SDK_VERSION,
                    REVIEWED_SDK_COMMIT,
                ),
                marker_path=marker,
                report_path=report,
            )
            self.assertEqual(result["status"], "compatible")
            self.assertFalse(marker.exists())
            self.assertFalse(compatibility_hold_active(marker))

    def test_sdk_drift_writes_fail_closed_marker(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            marker = root / "hold.json"
            report = root / "report.json"
            result = evaluate_versions(
                installed_sdk="0.2.8",
                pypi_sdk="0.2.8",
                contract=ContractVersion(
                    REVIEWED_API_VERSION,
                    REVIEWED_GAMEPLAY_VERSION,
                    REVIEWED_SERVER_COMMIT,
                    REVIEWED_SDK_VERSION,
                    REVIEWED_SDK_COMMIT,
                ),
                marker_path=marker,
                report_path=report,
            )
            self.assertTrue(result["hold"])
            self.assertTrue(compatibility_hold_active(marker))
            self.assertEqual(json.loads(report.read_text(encoding="utf-8"))["status"], "incompatible")

    def test_network_failure_is_recorded_without_raising(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            result = record_check_failure(
                marker_path=root / "hold.json",
                report_path=root / "report.json",
                error=TimeoutError("offline"),
            )
            self.assertTrue(result["hold"])
            self.assertTrue(compatibility_hold_active(root / "hold.json"))


if __name__ == "__main__":
    unittest.main()

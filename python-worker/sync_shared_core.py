from __future__ import annotations

import argparse
import hashlib
import shutil
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
SOURCE_PACKAGE = PROJECT_ROOT / "arena_hero_tactic"
WORKER_SRC = Path(__file__).resolve().parent / "src"
TARGET_PACKAGE = WORKER_SRC / "arena_hero_tactic"
STALE_METADATA = WORKER_SRC / "arena_hero_python_strategy_worker.egg-info"
SOURCE_FILES = (
    SOURCE_PACKAGE / "__init__.py",
    *sorted((SOURCE_PACKAGE / "strategy_core").glob("*.py")),
)


def relative_path(source: Path) -> Path:
    return source.relative_to(SOURCE_PACKAGE)


def source_digest() -> str:
    digest = hashlib.sha256()
    for source in SOURCE_FILES:
        digest.update(relative_path(source).as_posix().encode("utf-8"))
        digest.update(b"\0")
        digest.update(source.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def files_match() -> bool:
    if STALE_METADATA.exists():
        return False
    expected = {relative_path(source) for source in SOURCE_FILES}
    actual = {
        path.relative_to(TARGET_PACKAGE)
        for path in TARGET_PACKAGE.rglob("*.py")
    } if TARGET_PACKAGE.is_dir() else set()
    if actual != expected:
        return False
    return all(
        source.read_bytes() == (TARGET_PACKAGE / relative_path(source)).read_bytes()
        for source in SOURCE_FILES
    )


def remove_generated(path: Path) -> None:
    resolved = path.resolve()
    worker_src = WORKER_SRC.resolve()
    if resolved == worker_src or not resolved.is_relative_to(worker_src):
        raise RuntimeError(f"refusing to remove unsafe generated path: {resolved}")
    if path.is_dir():
        shutil.rmtree(path)
    elif path.exists():
        path.unlink()


def sync() -> None:
    target_root = TARGET_PACKAGE.resolve()
    source_root = SOURCE_PACKAGE.resolve()
    worker_src = WORKER_SRC.resolve()
    if source_root == target_root or not target_root.is_relative_to(worker_src):
        raise RuntimeError("refusing to replace an unsafe shared-core target")
    remove_generated(STALE_METADATA)
    remove_generated(TARGET_PACKAGE)
    for source in SOURCE_FILES:
        target = TARGET_PACKAGE / relative_path(source)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Synchronize the shared Python strategy into the Worker bundle."
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="fail instead of updating when the generated copy is stale",
    )
    arguments = parser.parse_args()
    if arguments.check:
        if not files_match():
            raise SystemExit("generated shared strategy is missing or stale")
    else:
        sync()
        if not files_match():
            raise RuntimeError("shared strategy synchronization failed")
    print(f"shared strategy digest: {source_digest()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

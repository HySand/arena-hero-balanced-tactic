#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_ROOT=$(dirname "$SCRIPT_DIR")
PYTHON_WORKER_DIR=$PROJECT_ROOT/python-worker
WORKER_DIR=$PROJECT_ROOT/worker
DRY_RUN=${1:-}

cd "$PYTHON_WORKER_DIR"
uv sync
uv run python sync_shared_core.py
uv run python sync_shared_core.py --check
uv run pywrangler sync
uv run pywrangler deploy --dry-run --config wrangler.jsonc

cd "$WORKER_DIR"
npm ci
npm run check
npm run deploy:dry-run

if [ "$DRY_RUN" = "--dry-run" ]; then
  exit 0
fi

cd "$PYTHON_WORKER_DIR"
uv run python sync_shared_core.py --check
uv run pywrangler deploy --config wrangler.jsonc

cd "$WORKER_DIR"
npm run deploy

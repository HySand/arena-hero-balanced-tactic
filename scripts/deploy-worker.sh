#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_ROOT=$(dirname "$SCRIPT_DIR")
WORKER_DIR=$PROJECT_ROOT/worker
DRY_RUN=${1:-}

cd "$WORKER_DIR"
npm ci
npm run check
npm run deploy:dry-run

if [ "$DRY_RUN" = "--dry-run" ]; then
  exit 0
fi
npm run deploy

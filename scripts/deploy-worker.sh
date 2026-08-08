#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
WORKER_DIR=$(dirname "$SCRIPT_DIR")/worker

cd "$WORKER_DIR"
npm ci
npm run check
npm run deploy

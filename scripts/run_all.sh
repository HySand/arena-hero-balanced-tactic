#!/usr/bin/env sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_ROOT=$(dirname "$SCRIPT_DIR")
cd "$PROJECT_ROOT"

if docker compose version >/dev/null 2>&1; then
    exec docker compose up --build
fi
if command -v docker-compose >/dev/null 2>&1; then
    exec docker-compose up --build
fi
printf '%s\n' 'Docker Compose is required for the containerized runner.' >&2
exit 1
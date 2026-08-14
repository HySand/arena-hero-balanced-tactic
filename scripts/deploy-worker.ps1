param(
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$PythonWorkerRoot = Join-Path $ProjectRoot 'python-worker'
$WorkerRoot = Join-Path $ProjectRoot 'worker'
$env:PYTHONUTF8 = '1'

Push-Location $PythonWorkerRoot
try {
  uv sync
  uv run python sync_shared_core.py
  uv run python sync_shared_core.py --check
  uv run pywrangler sync
  uv run pywrangler deploy --dry-run --config wrangler.jsonc
} finally {
  Pop-Location
}

Push-Location $WorkerRoot
try {
  npm ci
  npm run check
  npm run deploy:dry-run
} finally {
  Pop-Location
}

if ($DryRun) {
  exit 0
}

Push-Location $PythonWorkerRoot
try {
  uv run python sync_shared_core.py --check
  uv run pywrangler deploy --config wrangler.jsonc
} finally {
  Pop-Location
}

Push-Location $WorkerRoot
try {
  npm run deploy
} finally {
  Pop-Location
}

param(
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$PythonWorkerRoot = Join-Path $ProjectRoot 'python-worker'
$WorkerRoot = Join-Path $ProjectRoot 'worker'
$env:PYTHONUTF8 = '1'

function Invoke-NativeCommand {
  param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$FilePath,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Arguments
  )

  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed with exit code ${LASTEXITCODE}: $FilePath $($Arguments -join ' ')"
  }
}

Push-Location $PythonWorkerRoot
try {
  Invoke-NativeCommand uv sync
  Invoke-NativeCommand uv run python sync_shared_core.py
  Invoke-NativeCommand uv run python sync_shared_core.py --check
  Invoke-NativeCommand uv run pywrangler sync
  Invoke-NativeCommand uv run pywrangler deploy --dry-run --config wrangler.jsonc
} finally {
  Pop-Location
}

Push-Location $WorkerRoot
try {
  Invoke-NativeCommand npm ci
  Invoke-NativeCommand npm run check
  Invoke-NativeCommand npm run deploy:dry-run
} finally {
  Pop-Location
}

if ($DryRun) {
  exit 0
}

Push-Location $PythonWorkerRoot
try {
  Invoke-NativeCommand uv run python sync_shared_core.py --check
  Invoke-NativeCommand uv run pywrangler deploy --config wrangler.jsonc
} finally {
  Pop-Location
}

Push-Location $WorkerRoot
try {
  Invoke-NativeCommand npm run deploy
} finally {
  Pop-Location
}

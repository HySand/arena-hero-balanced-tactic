param(
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$WorkerRoot = Join-Path $ProjectRoot 'worker'

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

Push-Location $WorkerRoot
try {
  npm run deploy
} finally {
  Pop-Location
}

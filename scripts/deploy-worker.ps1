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
  if ($DryRun) {
    npm run deploy:dry-run
  } else {
    npm run deploy
  }
} finally {
  Pop-Location
}

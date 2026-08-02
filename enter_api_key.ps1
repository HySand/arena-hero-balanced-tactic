Add-Type -AssemblyName Microsoft.VisualBasic

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$envPath = Join-Path $projectRoot '.env'
$examplePath = Join-Path $projectRoot '.env.example'

$key = [Microsoft.VisualBasic.Interaction]::InputBox('Paste your Arena Hero API key. Do not include quotes or labels.', 'Arena Hero API Key', '')

$key = ($key -replace '\s', '').Trim()
if ([string]::IsNullOrWhiteSpace($key)) {
    Write-Host 'No API key was entered.'
    exit 2
}

if ($key -match '[^\x21-\x7E]') {
    $buttons = [Microsoft.VisualBasic.MsgBoxStyle]::OkOnly -bor [Microsoft.VisualBasic.MsgBoxStyle]::Exclamation
    [Microsoft.VisualBasic.Interaction]::MsgBox('The API key must contain visible ASCII characters.', $buttons, 'Arena Hero') | Out-Null
    exit 3
}

if ((-not (Test-Path -LiteralPath $envPath)) -or ((Get-Item -LiteralPath $envPath).Length -eq 0)) {
    if (Test-Path -LiteralPath $examplePath) {
        $content = Get-Content -LiteralPath $examplePath -Raw -Encoding UTF8
    } else {
        $content = ''
    }
} else {
    $content = Get-Content -LiteralPath $envPath -Raw -Encoding UTF8
}

$found = $false
$lines = foreach ($line in ($content -split "`r?`n")) {
    if ($line -match '^\s*ARENA_HERO_API_KEY=') {
        $found = $true
        "ARENA_HERO_API_KEY=$key"
    } else {
        $line
    }
}
if (-not $found) {
    $lines = @("ARENA_HERO_API_KEY=$key") + $lines
}

$output = (($lines -join "`r`n").TrimEnd() + "`r`n")
$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($envPath, $output, $utf8)
Write-Host 'API key saved to .env.'
exit 0

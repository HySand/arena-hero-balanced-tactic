param(
    [switch]$RestartTactic
)

Add-Type -AssemblyName Microsoft.VisualBasic

$projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$envPath = Join-Path $projectRoot '.env'
$examplePath = Join-Path $projectRoot '.env.example'
$lockPath = Join-Path $projectRoot 'data\runtime\locks\tactic.lock'
$launcherPath = Join-Path $projectRoot '启动控制台.vbs'

if ((-not (Test-Path -LiteralPath $envPath)) -or ((Get-Item -LiteralPath $envPath).Length -eq 0)) {
    if (Test-Path -LiteralPath $examplePath) {
        $content = Get-Content -LiteralPath $examplePath -Raw -Encoding UTF8
    } else {
        $content = ''
    }
} else {
    $content = Get-Content -LiteralPath $envPath -Raw -Encoding UTF8
}

$existingUsername = ''
foreach ($line in ($content -split "`r?`n")) {
    if ($line -match '^\s*ARENA_HERO_EXPECTED_USERNAME=(.*)$') {
        $existingUsername = $Matches[1].Trim().Trim('"').Trim("'")
        break
    }
}

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

$expectedUsername = [Microsoft.VisualBasic.Interaction]::InputBox(
    'Enter the Arena Hero username shown in the upper-right account menu. It stays only in local .env and prevents a key from controlling the wrong account.',
    'Arena Hero Account Check',
    $existingUsername
)
$expectedUsername = ($expectedUsername -replace '[\r\n]', '').Trim()
if ([string]::IsNullOrWhiteSpace($expectedUsername)) {
    Write-Host 'No Arena Hero username was entered.'
    exit 4
}
if ($expectedUsername -match '[\x00-\x1F\x7F]') {
    Write-Host 'The Arena Hero username contains unsupported control characters.'
    exit 5
}
if (($expectedUsername -ceq $key) -or ($expectedUsername -match '^ah_(?:live|test|dev)_')) {
    $buttons = [Microsoft.VisualBasic.MsgBoxStyle]::OkOnly -bor [Microsoft.VisualBasic.MsgBoxStyle]::Exclamation
    [Microsoft.VisualBasic.Interaction]::MsgBox(
        'That value looks like an API key. Enter the Arena Hero username shown in the account menu instead.',
        $buttons,
        'Arena Hero Account Check'
    ) | Out-Null
    exit 9
}

$foundKey = $false
$foundUsername = $false
$lines = foreach ($line in ($content -split "`r?`n")) {
    if ($line -match '^\s*ARENA_HERO_API_KEY=') {
        $foundKey = $true
        "ARENA_HERO_API_KEY=$key"
    } elseif ($line -match '^\s*ARENA_HERO_EXPECTED_USERNAME=') {
        $foundUsername = $true
        "ARENA_HERO_EXPECTED_USERNAME=$expectedUsername"
    } else {
        $line
    }
}
$prepend = @()
if (-not $foundKey) {
    $prepend += "ARENA_HERO_API_KEY=$key"
}
if (-not $foundUsername) {
    $prepend += "ARENA_HERO_EXPECTED_USERNAME=$expectedUsername"
}
$lines = $prepend + $lines

$output = (($lines -join "`r`n").TrimEnd() + "`r`n")
$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($envPath, $output, $utf8)
Write-Host 'API key and expected account saved to local .env.'

if ($RestartTactic) {
    $deadline = (Get-Date).AddSeconds(35)
    do {
        $active = $false
        if (Test-Path -LiteralPath $lockPath) {
            $ownerPid = [string](Get-Content -LiteralPath $lockPath -Raw -ErrorAction SilentlyContinue)
            $ownerPid = $ownerPid.Trim()
            if ($ownerPid -match '^\d+$') {
                $active = [bool](Get-Process -Id ([int]$ownerPid) -ErrorAction SilentlyContinue)
            }
        }
        if ($active) {
            Start-Sleep -Seconds 1
        }
    } while ($active -and (Get-Date) -lt $deadline)

    if ($active) {
        Write-Host 'The old tactic did not stop within 35 seconds. Run run_all.cmd after it exits.'
        exit 6
    }
    if (-not (Test-Path -LiteralPath $launcherPath)) {
        Write-Host 'The Arena Hero launcher was not found.'
        exit 7
    }
    & "$env:SystemRoot\System32\wscript.exe" $launcherPath
    Write-Host 'Restart requested with the new local credential.'
}
exit 0

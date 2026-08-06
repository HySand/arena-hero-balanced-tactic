[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

Push-Location -LiteralPath $projectRoot
try {
    $hasGit = (Test-Path -LiteralPath (Join-Path $projectRoot '.git')) -and $null -ne (Get-Command git -ErrorAction SilentlyContinue)
    if ($hasGit) {
        $files = @(git -c core.quotepath=false ls-files --cached --others --exclude-standard)
        if ($LASTEXITCODE -ne 0) {
            Write-Host 'Git could not enumerate upload candidates.'
            exit 2
        }
    } else {
        $excludedDirectories = @('.git', '.venv', '__pycache__', 'training_exports', 'data[\\/]runtime', 'data[\\/]training[\\/]exports')
        $excludedGeneratedFiles = @(
            '.arena_hero_dashboard_state.json',
            '.arena_hero_state.json',
            '.arena_hero_training.jsonl',
            '.arena_hero_training_source.json',
            '.arena_hero_version_report.json',
            '.peace_economy_experiment_state.json',
            '.peace_economy_telemetry.jsonl'
        )
        $files = @(
            Get-ChildItem -LiteralPath $projectRoot -Recurse -File -Force |
                Where-Object {
                    $relative = $_.FullName.Substring($projectRoot.Length + 1)
                    $parts = $relative -split '[\\/]'
                    $relative -notmatch '(^|[\\/])(?:\.git|\.venv|__pycache__|training_exports|data[\\/]runtime|data[\\/]training[\\/]exports)([\\/]|$)' -and
                    $relative -notmatch '^data[\\/]training[\\/](?:turns\.jsonl|peace_economy_telemetry\.jsonl|source\.json)(?:\.lock|\.tmp)?$' -and
                    $_.Name -ne '.env' -and
                    $_.Name -notin $excludedGeneratedFiles -and
                    $_.Extension.ToLowerInvariant() -notin @('.log', '.zip', '.7z', '.rar')
                } |
                ForEach-Object { $_.FullName.Substring($projectRoot.Length + 1) }
        )
        Write-Host 'Git metadata not present; scanning release files in the project folder.'
    }

    $findings = [System.Collections.Generic.List[object]]::new()
    $warnings = [System.Collections.Generic.List[string]]::new()

    function Add-Finding {
        param(
            [string]$File,
            [int]$Line,
            [string]$Rule
        )

        $findings.Add([PSCustomObject]@{
            File = $File
            Line = $Line
            Rule = $Rule
        })
    }

    $regexOptions = [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
    $rules = @(
        @{ Name = 'private-key'; Pattern = '-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----' },
        @{ Name = 'github-token'; Pattern = '(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})' },
        @{ Name = 'openai-token'; Pattern = 'sk-[A-Za-z0-9_-]{20,}' },
        @{ Name = 'aws-access-key'; Pattern = '(?:AKIA|ASIA)[A-Z0-9]{16}' },
        @{ Name = 'google-api-key'; Pattern = 'AIza[0-9A-Za-z_-]{30,}' },
        @{ Name = 'slack-token'; Pattern = 'xox[baprs]-[A-Za-z0-9-]{10,}' },
        @{ Name = 'bearer-token'; Pattern = 'Authorization\s*[:=]\s*["'']?Bearer\s+[A-Za-z0-9._~+/-]{12,}' },
        @{ Name = 'hardcoded-credential'; Pattern = '\b(?:api[_-]?key|access[_-]?token|secret|password)\b\s*[:=]\s*["''][^"''$<>{}\s][^"'']{7,}["'']' },
        @{ Name = 'windows-user-path'; Pattern = '[A-Z]:\\Users\\[^\\\s"'']+' },
        @{ Name = 'unix-home-path'; Pattern = '/(?:Users|home)/[^/\s"'']+' },
        @{ Name = 'unc-path'; Pattern = '\\\\[A-Za-z0-9][A-Za-z0-9._-]*\\[A-Za-z0-9$._-]+' },
        @{ Name = 'email-address'; Pattern = '\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b' },
        @{ Name = 'private-ip'; Pattern = '\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|169\.254(?:\.\d{1,3}){2})\b' },
        @{ Name = 'absolute-windows-path'; Pattern = '(?<![A-Z0-9_])[A-Z]:\\[^\r\n]+' }
    ) | ForEach-Object {
        [PSCustomObject]@{
            Name = $_.Name
            Regex = [regex]::new($_.Pattern, $regexOptions)
        }
    }

    foreach ($identity in @(
        @{ Name = 'local-username'; Value = $env:USERNAME },
        @{ Name = 'local-computer-name'; Value = $env:COMPUTERNAME },
        @{ Name = 'local-user-profile'; Value = $env:USERPROFILE },
        @{ Name = 'repository-absolute-path'; Value = $projectRoot }
    )) {
        if (-not [string]::IsNullOrWhiteSpace($identity.Value)) {
            $rules += [PSCustomObject]@{
                Name = $identity.Name
                Regex = [regex]::new([regex]::Escape($identity.Value), $regexOptions)
            }
        }
    }

    $sensitiveExtensions = @(
        '.pem', '.key', '.p12', '.pfx', '.har', '.pcap', '.pcapng',
        '.sqlite', '.sqlite3', '.db', '.dmp', '.stackdump', '.log',
        '.zip', '.7z', '.rar'
    )

    foreach ($relativePath in $files) {
        if (-not (Test-Path -LiteralPath $relativePath -PathType Leaf)) {
            continue
        }

        $fileName = [System.IO.Path]::GetFileName($relativePath)
        $extension = [System.IO.Path]::GetExtension($relativePath).ToLowerInvariant()
        if ($fileName -ne '.env.example' -and $fileName -like '.env*') {
            Add-Finding -File $relativePath -Line 0 -Rule 'tracked-env-file'
        }
        if ($sensitiveExtensions -contains $extension) {
            Add-Finding -File $relativePath -Line 0 -Rule 'sensitive-file-type'
        }
        if ($relativePath -match '(^|[\\/])(backups?|screenshots?|recordings?)([\\/]|$)') {
            Add-Finding -File $relativePath -Line 0 -Rule 'sensitive-export-directory'
        }

        $fullPath = Join-Path $projectRoot $relativePath
        $fileInfo = Get-Item -LiteralPath $fullPath
        if ($fileInfo.Length -gt 5MB) {
            Add-Finding -File $relativePath -Line 0 -Rule 'large-file-over-5mb'
        }

        $bytes = [System.IO.File]::ReadAllBytes($fullPath)
        if ($bytes -contains 0) {
            continue
        }

        $lines = [System.IO.File]::ReadAllLines($fullPath)
        for ($index = 0; $index -lt $lines.Length; $index++) {
            $line = $lines[$index]
            foreach ($rule in $rules) {
                if ($rule.Regex.IsMatch($line)) {
                    Add-Finding -File $relativePath -Line ($index + 1) -Rule $rule.Name
                }
            }

            if ($line -match '^\s*ARENA_HERO_API_KEY\s*=\s*(?<value>\S+)\s*$') {
                $value = $Matches.value.Trim('"', "'")
                $isPlaceholder = $value -match '^(?:YOUR_API_KEY|<YOUR_API_KEY>)$' -or (
                    $relativePath -eq 'README.md' -and $value.EndsWith('_API_KEY')
                )
                if (-not $isPlaceholder) {
                    Add-Finding -File $relativePath -Line ($index + 1) -Rule 'arena-hero-api-key'
                }
            }
        }
    }

    if ($hasGit) {
    $symlinks = @(git ls-files -s | Where-Object { $_ -match '^120000 ' })
    foreach ($symlink in $symlinks) {
        Add-Finding -File '<git-index>' -Line 0 -Rule 'tracked-symlink'
    }

    foreach ($remote in @(git remote)) {
        $remoteUrl = git remote get-url $remote
        if ($remoteUrl -match '^https?://[^/@\s]+@') {
            Add-Finding -File '<git-config>' -Line 0 -Rule 'remote-url-user-info'
        }
    }

    $gitName = git config user.name
    $gitEmail = git config user.email
    if ([string]::IsNullOrWhiteSpace($gitName) -or [string]::IsNullOrWhiteSpace($gitEmail)) {
        $warnings.Add('Git commit identity is not configured. Choose privacy-safe values before committing.')
    } else {
        $warnings.Add('Git commit name and email are configured and will be embedded in commits.')
    }

    $historyEmails = @()
    foreach ($commit in @(git rev-list --all)) {
        $historyEmails += git show -s --format=%ae $commit
    }
    if ($historyEmails | Where-Object { $_ -and $_ -notmatch '@users\.noreply\.github\.com$' }) {
        $warnings.Add('Existing Git history contains at least one non-noreply author email.')
    }

    }

    $uniqueFindings = @($findings | Sort-Object File, Line, Rule -Unique)
    foreach ($finding in $uniqueFindings) {
        Write-Host ("{0}:{1} [{2}]" -f $finding.File, $finding.Line, $finding.Rule)
    }
    foreach ($warning in $warnings) {
        Write-Host ("WARNING: {0}" -f $warning)
    }

    if ($uniqueFindings.Count -gt 0) {
        Write-Host ("Security scan failed with {0} finding(s). Values were not displayed." -f $uniqueFindings.Count)
        exit 1
    }

    Write-Host ("Security scan passed for {0} upload candidate file(s). Values were not displayed." -f $files.Count)
    exit 0
} finally {
    Pop-Location
}

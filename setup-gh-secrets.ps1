# Reads credentials from .env and pushes them as GitHub Actions secrets.
# Usage: .\setup-gh-secrets.ps1

$GH = "C:\Program Files\GitHub CLI\gh.exe"
$ROOT = $PSScriptRoot
$ENV_FILE = Join-Path $ROOT ".env"

if (-not (Test-Path $ENV_FILE)) {
    Write-Error ".env not found at $ENV_FILE"
    exit 1
}

# Parse .env
$env_vars = @{}
foreach ($line in (Get-Content $ENV_FILE)) {
    $line = $line.Trim()
    if (-not $line -or $line.StartsWith('#')) { continue }
    $idx = $line.IndexOf('=')
    if ($idx -lt 1) { continue }
    $key = $line.Substring(0, $idx).Trim()
    $val = $line.Substring($idx + 1).Trim().Trim('"').Trim("'")
    $env_vars[$key] = $val
}

$REPO = "Aditya-Srivastava-01/REFERAL"
$SECRETS = @("GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN", "GEMINI_API_KEY", "YOUR_NAME")

Write-Host "Setting $($SECRETS.Count) secrets on $REPO ..." -ForegroundColor Cyan

foreach ($name in $SECRETS) {
    $val = $env_vars[$name]
    if (-not $val) {
        Write-Warning "  $name not found in .env, skipping"
        continue
    }
    $val | & $GH secret set $name --repo $REPO
    if ($?) {
        Write-Host "  OK $name" -ForegroundColor Green
    } else {
        Write-Host "  FAILED $name" -ForegroundColor Red
    }
}

Write-Host "Done." -ForegroundColor Cyan
Write-Host "Verify with: & '$GH' secret list --repo $REPO"

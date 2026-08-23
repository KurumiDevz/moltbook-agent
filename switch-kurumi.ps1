# Switch git config to KurumiDevz for this project
# Run from project root: .\switch-kurumi.ps1

$ErrorActionPreference = "Stop"

$token = $env:GITHUB_MCP_TOKEN
if (-not $token) {
    Write-Host "[ERROR] GITHUB_MCP_TOKEN env var not found!" -ForegroundColor Red
    exit 1
}

# Ensure we're in a git repo
if (-not (Test-Path ".git")) {
    Write-Host "[ERROR] Not a git repo. Run 'git init' first." -ForegroundColor Red
    exit 1
}

# Set project-local git config (stored in .git/config, not global)
git config user.name "KurumiDevz"
git config user.email "kurumichanpage@gmail.com"

# Write credentials file for this repo
$credContent = "https://KurumiDevz:${token}@github.com`n"
Set-Content -Path ".git/credentials" -Value $credContent -NoNewline -Force
git config credential.helper store

Write-Host ""
Write-Host "[OK] Switched to KurumiDevz" -ForegroundColor Green
Write-Host "  user.name:  $(git config user.name)"
Write-Host "  user.email: $(git config user.email)"
Write-Host "  cred file:  $(Resolve-Path .git/credentials)"

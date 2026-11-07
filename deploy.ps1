# agent-kit deploy: install/update skills into this machine's agent skill dirs.
# Default target: %USERPROFILE%\.agents\skills  (shared by ZCode and other agent CLIs)
# Usage:  pwsh -File deploy.ps1                -> .agents\skills only
#         pwsh -File deploy.ps1 -AlsoZCode     -> also .zcode\skills (only if some tool reads just that dir)
# NOTE: keep this file ASCII-only; Windows PowerShell 5.1 misreads BOM-less UTF-8.
param([switch]$AlsoZCode)
$ErrorActionPreference = "Stop"
$kit = Split-Path -Parent $MyInvocation.MyCommand.Path
$targets = @("$env:USERPROFILE\.agents\skills")
if ($AlsoZCode) { $targets += "$env:USERPROFILE\.zcode\skills" }
foreach ($t in $targets) {
    New-Item -ItemType Directory -Force -Path $t | Out-Null
    Copy-Item -Path (Join-Path $kit 'skills\*') -Destination $t -Recurse -Force
    Write-Host "[agent-kit] deployed -> $t"
}
Write-Host "[agent-kit] done (takes effect in new sessions)"

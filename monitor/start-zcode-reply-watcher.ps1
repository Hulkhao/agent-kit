param(
  [string]$ThreadId = $env:CODEX_THREAD_ID,
  [string]$Folder = 'D:\Downloads\zcode-codex交流',
  [int]$DelaySeconds = 120,
  [string]$CodexRemote = $env:CODEX_APP_REMOTE_ENDPOINT,
  [string]$CodexPath = $env:CODEX_APP_RUNTIME_CLI_PATH
)

$ErrorActionPreference = 'Stop'
if ($ThreadId -notmatch '^[a-fA-F0-9]{8}(-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$') {
  throw 'Specify the existing Codex session UUID with -ThreadId.'
}
if ($DelaySeconds -lt 0) { throw 'DelaySeconds must be non-negative.' }

$node = (Get-Command node.exe -ErrorAction Stop).Source
$codex = if ($CodexPath) { (Resolve-Path -LiteralPath $CodexPath -ErrorAction Stop).ProviderPath } else { (Get-Command codex.exe -ErrorAction Stop).Source }
$watcher = Join-Path $PSScriptRoot 'watch-zcode-replies.mjs'

Write-Output "Watching $Folder\replies for session $ThreadId; press Ctrl+C to stop."
$arguments = @($watcher, '--thread', $ThreadId, '--folder', $Folder, '--delay-ms', [string]($DelaySeconds * 1000), '--codex', $codex)
if ($CodexRemote) { $arguments += @('--codex-remote', $CodexRemote) }
& $node @arguments
exit $LASTEXITCODE

param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$GitArgs
)

$repoRoot = Split-Path -Parent $PSScriptRoot
$gitSafeDirectory = $repoRoot -replace "\\", "/"
$homeDir = Join-Path $repoRoot "tmp\\userprofile"
$xdgConfigHome = Join-Path $repoRoot "tmp\\xdg-config"

New-Item -ItemType Directory -Force $homeDir | Out-Null
New-Item -ItemType Directory -Force $xdgConfigHome | Out-Null

$env:HOME = $homeDir
$env:XDG_CONFIG_HOME = $xdgConfigHome

& git -c "safe.directory=$gitSafeDirectory" @GitArgs
exit $LASTEXITCODE

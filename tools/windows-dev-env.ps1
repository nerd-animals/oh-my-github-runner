param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$Command,

  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$CommandArgs
)

$repoRoot = Split-Path -Parent $PSScriptRoot
$appData = Join-Path $repoRoot "tmp\\appdata"
$localAppData = Join-Path $repoRoot "tmp\\localappdata"
$userProfile = Join-Path $repoRoot "tmp\\userprofile"
$npmCache = Join-Path $repoRoot "tmp\\npm-cache"
$npmPrefix = Join-Path $repoRoot "tmp\\npm-prefix"

$paths = @(
  $appData,
  $localAppData,
  $userProfile,
  $npmCache,
  $npmPrefix
)

foreach ($path in $paths) {
  New-Item -ItemType Directory -Force $path | Out-Null
}

$env:APPDATA = $appData
$env:LOCALAPPDATA = $localAppData
$env:USERPROFILE = $userProfile
$env:NPM_CONFIG_CACHE = $npmCache
$env:NPM_CONFIG_PREFIX = $npmPrefix

& $Command @CommandArgs
exit $LASTEXITCODE

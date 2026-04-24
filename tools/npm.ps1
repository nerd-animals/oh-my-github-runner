param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$NpmArgs
)

$wrapper = Join-Path $PSScriptRoot "windows-dev-env.ps1"

& $wrapper "npm.cmd" @NpmArgs
exit $LASTEXITCODE

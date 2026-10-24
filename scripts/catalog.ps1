[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]] $CatalogArguments
)

$ErrorActionPreference = 'Stop'
$catalogScript = Join-Path $PSScriptRoot 'catalog-discovery.py'
$bundledPython = Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe'
$pythonPrefix = @()

if (Test-Path -LiteralPath $bundledPython -PathType Leaf) {
    $catalogPython = $bundledPython
} else {
    $catalogCommand = Get-Command py -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($catalogCommand) {
        $catalogPython = $catalogCommand.Source
        $pythonPrefix = @('-3')
    } else {
        $catalogCommand = Get-Command python -CommandType Application -ErrorAction SilentlyContinue |
            Where-Object { $_.Source -notmatch '[\\/]WindowsApps[\\/]' } | Select-Object -First 1
        if (-not $catalogCommand) {
            throw 'Python 3.10+ is required. Install it or run catalog-discovery.py with an existing interpreter; this helper installs nothing.'
        }
        $catalogPython = $catalogCommand.Source
    }
}

if (-not $CatalogArguments -or $CatalogArguments.Count -eq 0) {
    $CatalogArguments = @('--help')
}

# Pass an argument array directly; query text is never evaluated as shell code.
& $catalogPython @pythonPrefix $catalogScript @CatalogArguments
exit $LASTEXITCODE

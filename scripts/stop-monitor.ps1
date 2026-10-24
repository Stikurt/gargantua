$runtimePath = Join-Path (Split-Path $PSScriptRoot -Parent) '.local/runtime'
$pidFile = Join-Path $runtimePath 'monitor.pid'
if (Test-Path -LiteralPath $pidFile) {
    $monitorId = [int](Get-Content -LiteralPath $pidFile -Raw).Trim()
    $monitorProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$monitorId" -ErrorAction SilentlyContinue
    $expectedScript = Join-Path $PSScriptRoot 'resource-monitor.ps1'
    if ($monitorProcess -and $monitorProcess.CommandLine.IndexOf($expectedScript, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
        Stop-Process -Id $monitorId -ErrorAction SilentlyContinue
    }
}

# Hold the same host lock as the derived-media executor. No process is killed.
# The caller must first stop the library publisher and keep this handle alive
# until all snapshot reads are finished. A stale JSON status is not proof.
function Enter-GargantuaInferenceSnapshot {
    $directory = Join-Path $script:GargantuaProjectRoot '.local/inference-runtime'
    Assert-GargantuaNoReparseAncestors -Path $directory
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
    $filename = Join-Path $directory 'execution.lock'
    Assert-GargantuaNoReparseAncestors -Path $filename
    $handle = $null
    try {
        # FileShare.None conflicts with both another snapshot and the executor's
        # open handle. Acquisition failure is an explicit retry, never a bypass.
        $handle = [IO.File]::Open($filename,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
        $raw = Invoke-GargantuaDocker -Operation 'find isolated inference containers for snapshot' -Arguments @('ps','-a','--filter','label=org.gargantua.inference=derived-v1','--format','{{.ID}}')
        foreach ($id in @($raw -split '\s+' | Where-Object { $_ })) {
            if ($id -notmatch '^[a-f0-9]{12,64}$') { throw 'Unknown inference container identity; snapshot refused.' }
            $state = Invoke-GargantuaDocker -Operation 'confirm inference stopped for snapshot' -Arguments @('inspect','--format','{{json .State}}',$id) | ConvertFrom-Json
            if ($null -eq $state -or $state.Running -isnot [bool] -or $state.Restarting -isnot [bool] -or $state.Paused -isnot [bool] -or $state.Running -or $state.Restarting -or $state.Paused -or $state.Status -notin @('created','exited','dead')) {
                throw 'Inference container is active or its stop state is unknown; snapshot refused.'
            }
        }
        return $handle
    } catch {
        if ($handle) { $handle.Dispose() }
        throw
    }
}

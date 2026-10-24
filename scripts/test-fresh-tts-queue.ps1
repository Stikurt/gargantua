[CmdletBinding()]
param(
    [switch]$Run,
    [string]$PythonExe,
    [string]$DockerExe,
    [string]$DockerContext='desktop-linux'
)
$ErrorActionPreference='Stop'
$workspace=(Resolve-Path -LiteralPath (Split-Path $PSScriptRoot -Parent)).Path
. (Join-Path $PSScriptRoot 'runtime-common.ps1')
if(-not $PythonExe){
    $runtime=Get-GargantuaPythonRuntime -ProjectRoot $workspace
    $PythonExe=$runtime.command
}
if(-not $DockerExe){
    $DockerExe=Get-GargantuaDockerExecutable -ProjectRoot $workspace
}
$PythonExe=(Resolve-Path -LiteralPath $PythonExe).Path
$DockerExe=(Resolve-Path -LiteralPath $DockerExe).Path
$harness=Join-Path $workspace 'scripts/fresh-tts-queue.py'
if(-not(Test-Path -LiteralPath $harness -PathType Leaf)){throw 'Fresh TTS fixture harness is missing'}
# Default invocation only inspects readiness. -Run creates GUID-owned fixtures;
# the existing host executor/resource monitor/config/env remain unchanged.
# No models/images are downloaded, and no second executor/GPU job is launched.
$arguments=@('-E','-s','-B',$harness,'--docker',$DockerExe,'--context',$DockerContext)
if($Run){$arguments+='--run'}
& $PythonExe @arguments
if($LASTEXITCODE -ne 0){throw ('Fresh TTS queue check failed with exit code '+$LASTEXITCODE)}

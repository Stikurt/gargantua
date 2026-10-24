[CmdletBinding()]
param([ValidateSet('run','status')][string]$Action='status')
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'startup-common.ps1')
$project=[IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
if($Action -eq 'status'){Get-GargantuaStartupStatus -ProjectRoot $project|ConvertTo-Json -Depth 16;return}
$result=Invoke-GargantuaStartup -ProjectRoot $project
$result|ConvertTo-Json -Depth 16
if($result.state -in @('failed','deferred')){exit 1}

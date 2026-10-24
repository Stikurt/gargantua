<# No service/task/model starts. Verifies product-owned runtimes using short-lived
children with a deliberately poisoned inherited PATH/Python configuration. #>
[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$project=[IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
. (Join-Path $project 'scripts/runtime-common.ps1')
$token=[Guid]::NewGuid().ToString('N');$root=Join-Path $project ('.local/test-results/runtime-dependency-'+$token)
$fixtures=Join-Path $root 'fixtures';[IO.Directory]::CreateDirectory($fixtures)|Out-Null
$cases=[Collections.Generic.List[object]]::new()
function Assert-RuntimeTest([bool]$Condition,[string]$Message){if(-not $Condition){throw $Message}}
function Test-RuntimeCase([string]$Name,[scriptblock]$Body){
    try{& $Body;$cases.Add(@{name=$Name;status='PASS'});Write-Host "PASS $Name"}
    catch{$cases.Add(@{name=$Name;status='FAIL';error=$_.Exception.Message});Write-Host "FAIL ${Name}: $($_.Exception.Message)"}
}
function Invoke-RuntimeChild([string]$Executable,[string[]]$Arguments,[hashtable]$Environment){
    $info=[Diagnostics.ProcessStartInfo]::new();$info.FileName=$Executable;$info.UseShellExecute=$false;$info.CreateNoWindow=$true
    $info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true;$info.WorkingDirectory=$fixtures
    foreach($argument in $Arguments){$info.ArgumentList.Add($argument)}
    foreach($name in $Environment.Keys){$info.Environment[$name]=$Environment[$name]}
    $process=[Diagnostics.Process]::new();$process.StartInfo=$info
    try{
        if(-not $process.Start()){throw 'Runtime child did not start.'}
        $stdout=$process.StandardOutput.ReadToEndAsync();$stderr=$process.StandardError.ReadToEndAsync()
        if(-not $process.WaitForExit(30000)){try{$process.Kill($true)}catch{};throw 'Runtime child timed out.'}
        if(-not [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($stdout,$stderr),2000)){throw 'Runtime child output did not close.'}
        $out=$stdout.GetAwaiter().GetResult();$null=$stderr.GetAwaiter().GetResult()
        if($process.ExitCode -ne 0){throw ('Runtime child failed (exit '+$process.ExitCode+'); private stderr suppressed.')}
        return $out
    }finally{$process.Dispose()}
}
try{
    $ps=Get-GargantuaPowerShell -ProjectRoot $project;$python=Get-GargantuaPythonRuntime -ProjectRoot $project
    $environment=Get-GargantuaManagedEnvironment -ProjectRoot $project
    Test-RuntimeCase 'runtimes resolve inside the product and Docker resolves to its installed location' {
        $prefix=(Join-Path $project '.local/tools/runtime')+[IO.Path]::DirectorySeparatorChar
        Assert-RuntimeTest ($ps.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase) -and $python.command.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)) 'Runtime resolver returned an external cache or PATH executable.'
        $docker=Get-GargantuaDockerExecutable -ProjectRoot $project
        Assert-RuntimeTest ($docker -notmatch '(?i)codex-runtimes|WindowsApps|sandbox\.' -and (Test-Path -LiteralPath $docker -PathType Leaf)) 'Docker resolver used a transient executable.'
    }
    Test-RuntimeCase 'missing product runtime fails closed instead of using Codex cache or PATH' {
        $message='';try{Get-GargantuaPowerShell -ProjectRoot $fixtures|Out-Null}catch{$message=$_.Exception.Message}
        Assert-RuntimeTest ($message.Contains('not prepared')) 'Missing runtime silently resolved an external shell.'
    }
    Test-RuntimeCase 'managed environment excludes Codex caches, WindowsApps and remote Docker' {
        Assert-RuntimeTest ($environment.PATH -notmatch '(?i)codex-runtimes|[\\/]WindowsApps(?:[\\/]|;|$)' -and $environment.PSModulePath -notmatch '(?i)codex-runtimes') 'Managed paths still depend on Codex or app execution aliases.'
        Assert-RuntimeTest ($environment.DOCKER_CONTEXT -eq 'desktop-linux' -and -not $environment.DOCKER_HOST -and -not $environment.PYTHONHOME -and -not $environment.PYTHONPATH) 'Managed environment retained remote Docker or external Python configuration.'
    }
    $oldPath=$env:PATH;$oldPythonHome=$env:PYTHONHOME;$oldPythonPath=$env:PYTHONPATH
    try{
        $env:PATH='C:\missing-codex-dependency';$env:PYTHONHOME='C:\missing-python';$env:PYTHONPATH=$fixtures
        Test-RuntimeCase 'portable PowerShell works with poisoned parent PATH and loads required Windows cmdlets' {
            $code='[pscustomobject]@{version=$PSVersionTable.PSVersion.ToString();home=$PSHOME;cim=(Get-Command Get-CimInstance -ErrorAction Stop).Name;tasks=(Get-Command Get-ScheduledTask -ErrorAction Stop).Name;path=$env:PATH;modules=$env:PSModulePath}|ConvertTo-Json -Compress'
            $result=(Invoke-RuntimeChild -Executable $ps -Arguments @('-NoProfile','-NonInteractive','-Command',$code) -Environment $environment)|ConvertFrom-Json
            Assert-RuntimeTest ($result.version -eq '7.6.5' -and $result.home -eq (Split-Path $ps -Parent) -and $result.cim -eq 'Get-CimInstance' -and $result.tasks -eq 'Get-ScheduledTask') 'Portable shell could not load the product Windows dependencies.'
            Assert-RuntimeTest ($result.path -notmatch '(?i)codex-runtimes' -and $result.modules -notmatch '(?i)codex-runtimes') 'Fresh shell restored a Codex path.'
        }
        Test-RuntimeCase 'private Python stdlib and trusted imports work without parent PATH or Python configuration' {
            $code='import sys,json,ssl,sqlite3,ctypes,hashlib,tarfile,zlib,subprocess,wave,protocol,importlib.util; print(json.dumps({"version":".".join(map(str,sys.version_info[:3])),"executable":sys.executable,"base":sys.base_prefix,"isolated":sys.flags.isolated,"noSite":sys.flags.no_site,"paths":sys.path,"requests":importlib.util.find_spec("requests") is not None}))'
            $result=(Invoke-RuntimeChild -Executable $python.command -Arguments (@($python.prefix)+@('-c',$code)) -Environment $environment)|ConvertFrom-Json
            Assert-RuntimeTest ($result.version -eq '3.12.14' -and $result.executable -eq $python.command -and $result.base -eq (Split-Path $python.command -Parent) -and $result.isolated -eq 1 -and $result.noSite -eq 1) 'Private Python used an external home or enabled site processing.'
            Assert-RuntimeTest (-not $result.requests -and ($result.paths -join ';') -notmatch '(?i)codex-runtimes|site-packages|WindowsApps|missing-python') 'Python imported external third-party packages or registry/environment paths.'
        }
        Test-RuntimeCase 'backup helper starts using only the private stdlib runtime' {
            $text=Invoke-RuntimeChild -Executable $python.command -Arguments (@($python.prefix)+@((Join-Path $project 'scripts/backup-artifacts.py'),'--help')) -Environment $environment
            Assert-RuntimeTest ($text.Contains('usage:') -and $text.Contains('backup')) 'Backup helper did not reach its read-only help entrypoint.'
        }
        Test-RuntimeCase 'inference host imports its protocol and reaches help without starting a daemon' {
            $text=Invoke-RuntimeChild -Executable $python.command -Arguments (@($python.prefix)+@((Join-Path $project 'inference/executor.py'),'--help')) -Environment $environment
            Assert-RuntimeTest ($text.Contains('usage:') -and $text.Contains('--spool')) 'Inference host did not reach its read-only help entrypoint.'
        }
    }finally{$env:PATH=$oldPath;$env:PYTHONHOME=$oldPythonHome;$env:PYTHONPATH=$oldPythonPath}
    Test-RuntimeCase 'executable corruption is detected before runtime resolution succeeds' {
        $runtime=Join-Path $fixtures '.local/tools/runtime';$exe=Join-Path $runtime 'powershell-7.6.5/pwsh.exe';[IO.Directory]::CreateDirectory((Split-Path $exe -Parent))|Out-Null
        [IO.File]::WriteAllText($exe,'benign non-executable fixture')
        $manifest=@{schemaVersion=1;status='complete';powershell=@{executable='powershell-7.6.5/pwsh.exe'};python=@{executable='python-3.12.14/python.exe'};files=@(@{path='powershell-7.6.5/pwsh.exe';bytes=(Get-Item -LiteralPath $exe).Length;sha256=('0'*64)})}
        [IO.File]::WriteAllText((Join-Path $runtime 'runtime-manifest.json'),($manifest|ConvertTo-Json -Depth 6))
        $message='';try{Get-GargantuaPowerShell -ProjectRoot $fixtures|Out-Null}catch{$message=$_.Exception.Message}
        Assert-RuntimeTest ($message.Contains('integrity')) 'A changed executable was returned as trusted runtime.'
    }
}catch{$cases.Add(@{name='harness';status='FAIL';error=$_.Exception.Message})}
finally{
    # Preserve the small owned fixtures as evidence. No recursive cleanup or
    # production process manipulation occurs in this acceptance test.
    $failed=@($cases.ToArray()|Where-Object status -eq 'FAIL')
    $report=@{status=$(if($failed.Count){'FAIL'}else{'PASS'});cases=$cases.ToArray();passed=$cases.Count-$failed.Count;failed=$failed.Count;servicesStarted=$false;tasksRegistered=$false;modelDaemonStarted=$false;parentEnvironmentRestored=$true}
    [IO.File]::WriteAllText((Join-Path $root 'report.json'),($report|ConvertTo-Json -Depth 10),[Text.UTF8Encoding]::new($false))
}
Write-Host ("Runtime dependency checks: {0} passed, {1} failed. Report: {2}" -f ($cases.Count-$failed.Count),$failed.Count,(Join-Path $root 'report.json'))
if($failed.Count){exit 1};exit 0

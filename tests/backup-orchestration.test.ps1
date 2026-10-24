<#
.SYNOPSIS
Offline checks of backup-common helpers. Does not invoke Docker or production scripts.
.DESCRIPTION
Uses one short-lived Python child for native process outcomes and an in-memory Docker
replacement for service-state restoration. Temporary files stay in an owned child of
tests/.backup-test-tmp. These are not PostgreSQL/backup end-to-end recovery tests.
#>
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$project = [IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
. (Join-Path $project 'scripts/backup-common.ps1')

$script:Cases = [Collections.Generic.List[object]]::new()
$script:DockerCalls = [Collections.Generic.List[object]]::new()
$script:DockerStates = @{}
$script:DockerServiceIds = @{}
$script:FailDockerOperation = ''
$script:IgnoreStartMutation = $false

function Assert-BackupTest {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

function Assert-BackupThrows {
    param([scriptblock]$Action, [string]$ExpectedFragment = '')
    $caught = $null
    try { & $Action | Out-Null } catch { $caught = $_.Exception.Message }
    if ($null -eq $caught) { throw 'Expected an exception, but the operation succeeded.' }
    if ($ExpectedFragment -and -not $caught.Contains($ExpectedFragment)) {
        throw "Exception did not contain the expected public diagnostic: $ExpectedFragment"
    }
    return $caught
}

function Invoke-BackupTest {
    param([string]$Name, [scriptblock]$Body)
    try {
        & $Body
        $script:Cases.Add([pscustomobject]@{name=$Name;status='PASS'})
        Write-Host "PASS $Name"
    } catch {
        $script:Cases.Add([pscustomobject]@{name=$Name;status='FAIL';error=$_.Exception.Message})
        Write-Host "FAIL $Name`: $($_.Exception.Message)"
    }
}

function Reset-BackupDockerMock {
    $script:DockerCalls.Clear()
    $script:DockerStates = @{}
    $script:DockerServiceIds = @{}
    $script:FailDockerOperation = ''
    $script:IgnoreStartMutation = $false
}

function New-BackupState {
    param([string]$Id, [bool]$Running, [bool]$Paused, [string]$Status = '')
    if (-not $Status) { $Status = if ($Paused) {'paused'} elseif ($Running) {'running'} else {'exited'} }
    $state = [pscustomobject]@{Running=$Running;Paused=$Paused;Status=$Status;Restarting=$false;Dead=$false}
    $script:DockerStates[$Id] = $state
    return $state
}

function New-BackupOriginal {
    param([string]$Service='worker', [string]$Id=('a'*64), [bool]$Running=$false, [bool]$Paused=$false, [bool]$Exists=$true)
    return [pscustomobject]@{service=$Service;id=$Id;exists=$Exists;running=$Running;paused=$Paused;status=$(if ($Paused) {'paused'} elseif ($Running) {'running'} else {'exited'})}
}

# This replaces the real helper in the test scope. Unknown commands throw; there is
# deliberately no fallback that could start a native Docker process.
function Invoke-GargantuaDocker {
    param([Parameter(Mandatory)][string]$Operation, [string[]]$Arguments, [AllowNull()][string]$InputText=$null)
    $script:DockerCalls.Add([pscustomobject]@{operation=$Operation;arguments=@($Arguments)})
    if ($Operation -eq $script:FailDockerOperation) { throw "Injected Docker failure: $Operation" }
    if (-not $Arguments.Count) { throw 'Mock requires a Docker command.' }
    $command = $Arguments[0]
    if ($command -eq 'compose') {
        $service = $Arguments[-1]
        if ($script:DockerServiceIds.ContainsKey($service)) { return $script:DockerServiceIds[$service] }
        return ''
    }
    $id = $Arguments[-1]
    if (-not $script:DockerStates.ContainsKey($id)) { throw 'Mock received an unknown container identifier.' }
    $state = $script:DockerStates[$id]
    switch ($command) {
        'inspect' { return ($state | ConvertTo-Json -Compress) }
        'start' {
            if (-not $script:IgnoreStartMutation) { $state.Running=$true; $state.Paused=$false; $state.Status='running' }
        }
        'pause' { $state.Running=$true; $state.Paused=$true; $state.Status='paused' }
        'unpause' { $state.Running=$true; $state.Paused=$false; $state.Status='running' }
        'stop' { $state.Running=$false; $state.Paused=$false; $state.Status='exited' }
        default { throw "Unimplemented Docker mock command: $command" }
    }
    return ''
}

function Get-BackupMutationCommands {
    return @($script:DockerCalls | Where-Object { $_.arguments[0] -in @('start','stop','pause','unpause') } | ForEach-Object { $_.arguments[0] })
}

$token = [Guid]::NewGuid().ToString('N')
$temporaryBase = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '.backup-test-tmp'))
$temporaryRoot = [IO.Path]::GetFullPath((Join-Path $temporaryBase ('run-'+$token)))
$ownerPath = Join-Path $temporaryRoot 'test-owner.json'
$createdRoot = $false
try {
    if (-not $temporaryBase.StartsWith($project+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'Temporary base escaped the workspace.' }
    if (Test-Path -LiteralPath $temporaryBase) {
        if ((Get-Item -LiteralPath $temporaryBase).Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)) { throw 'Temporary base cannot be a reparse point.' }
    } else { New-Item -ItemType Directory -Path $temporaryBase | Out-Null }
    if (Test-Path -LiteralPath $temporaryRoot) { throw 'Temporary run target already exists.' }
    New-Item -ItemType Directory -Path $temporaryRoot | Out-Null
    $createdRoot = $true
    Write-GargantuaJson -Path $ownerPath -Value @{token=$token;root=$temporaryRoot}
    $child = Join-Path $temporaryRoot 'native-child.py'
    [IO.File]::WriteAllText($child, @'
import json
import sys
if sys.argv[1] == "stdin":
    data = sys.stdin.buffer.read().decode("utf-8")
    print(json.dumps({"lines": data.split("\n")}))
    raise SystemExit(0)
print("benign child stdout")
print("PRIVATE_TEST_MARKER", file=sys.stderr)
raise SystemExit(int(sys.argv[1]))
'@, [Text.UTF8Encoding]::new($false))
    $runtime = Get-GargantuaPython

    Invoke-BackupTest 'native success records its own zero exit code' {
        $output = Invoke-GargantuaNative -Operation 'offline child success' -Command $runtime.command -Arguments (@($runtime.prefix)+@($child,'0'))
        Assert-BackupTest ($output.Contains('benign child stdout')) 'Successful stdout was not captured.'
        Assert-BackupTest ($script:GargantuaOperations[-1].exitCode -eq 0) 'Success did not record exit zero.'
    }
    Invoke-BackupTest 'native failure throws and does not disclose stderr' {
        $errorText = Assert-BackupThrows { Invoke-GargantuaNative -Operation 'offline child failure' -Command $runtime.command -Arguments (@($runtime.prefix)+@($child,'7')) } 'exit 7'
        Assert-BackupTest (-not $errorText.Contains('PRIVATE_TEST_MARKER')) 'Private child stderr escaped into the public error.'
        Assert-BackupTest ($script:GargantuaOperations[-1].exitCode -eq 7) 'Failure did not record its own exit code.'
    }
    Invoke-BackupTest 'hung native command releases its process within a finite timeout' {
        $timer=[Diagnostics.Stopwatch]::StartNew()
        $errorText=Assert-BackupThrows {Invoke-GargantuaNative -Operation 'offline native timeout' -Command $runtime.command -Arguments (@($runtime.prefix)+@('-c','import sys,time;print("PRIVATE_TIMEOUT_MARKER",file=sys.stderr);time.sleep(8)')) -TimeoutSeconds 1} 'timed out'
        Assert-BackupTest ($timer.Elapsed.TotalSeconds -lt 5) 'Command exceeded the bounded wait.'
        Assert-BackupTest ($script:GargantuaOperations[-1].exitCode -eq -2 -and -not $errorText.Contains('PRIVATE_TIMEOUT_MARKER')) 'Timeout was not recorded privately.'
    }
    Invoke-BackupTest 'blocked native stdin uses the same bounded deadline' {
        $timer=[Diagnostics.Stopwatch]::StartNew()
        Assert-BackupThrows {Invoke-GargantuaNative -Operation 'offline blocked input' -Command $runtime.command -Arguments (@($runtime.prefix)+@('-c','import time;time.sleep(8)')) -InputText ('x'*2MB) -TimeoutSeconds 1} 'timed out'|Out-Null
        Assert-BackupTest ($timer.Elapsed.TotalSeconds -lt 5 -and $script:GargantuaOperations[-1].exitCode -eq -2) 'Blocked stdin escaped its deadline.'
    }
    Invoke-BackupTest 'missing executable cannot reuse an earlier zero exit code' {
        Invoke-GargantuaNative -Operation 'reset native exit to zero' -Command $runtime.command -Arguments (@($runtime.prefix)+@($child,'0')) | Out-Null
        Assert-BackupTest ($global:LASTEXITCODE -eq 0) 'Test precondition requires an earlier native success.'
        Assert-BackupThrows { Invoke-GargantuaNative -Operation 'missing child' -Command (Join-Path $temporaryRoot 'does-not-exist.exe') } 'required executable is unavailable' | Out-Null
    }
    Invoke-BackupTest 'native stdin normalizes content CRLF before a Linux shell command line' {
        $inputText = "one`r`ntwo`r`n\! command /tmp/file`r`n"
        $output = Invoke-GargantuaNative -Operation 'offline stdin transport' -Command $runtime.command -Arguments (@($runtime.prefix)+@($child,'stdin')) -InputText $inputText
        $received = $output | ConvertFrom-Json
        $content = @($received.lines | Where-Object { $_.Trim("`r") -ne '' })
        Assert-BackupTest ($content.Count -eq 3) 'Native stdin changed the number of nonempty content lines.'
        foreach ($line in $content) {
            Assert-BackupTest (-not $line.Contains("`r")) 'A carriage return remained inside a transported content line.'
        }
        Assert-BackupTest (($content -join '|') -eq 'one|two|\! command /tmp/file') 'Native stdin altered text or the shell-command filename.'
        # PowerShell may append its own final CRLF after the already normalized
        # payload. Only trailing empty/CR-only lines are irrelevant to this test.
        for ($i=3; $i -lt $received.lines.Count; $i++) {
            Assert-BackupTest ($received.lines[$i].Trim("`r") -eq '') 'Unexpected content followed the final command line.'
        }
    }
    Invoke-BackupTest 'atomic JSON create and replacement preserve single-item arrays and Unicode' {
        $jsonPath = Join-Path $temporaryRoot 'array-unicode.json'
        Write-GargantuaJson -Path $jsonPath -Value @([pscustomobject]@{title='Коты-воители';revision=1})
        $created = Get-Content -LiteralPath $jsonPath -Raw -Encoding UTF8 | ConvertFrom-Json -NoEnumerate
        Assert-BackupTest ($created -is [array] -and $created.Count -eq 1) 'Initial JSON lost its single-item array shape.'
        Assert-BackupTest ($created[0].title -eq 'Коты-воители' -and $created[0].revision -eq 1) 'Initial JSON values or Unicode changed.'
        Assert-BackupTest (-not (Test-Path -LiteralPath ($jsonPath+'.tmp'))) 'Initial JSON publication left a temporary file.'
        Write-GargantuaJson -Path $jsonPath -Value @([pscustomobject]@{title='Гаргантюа — личная библиотека';revision=2})
        $replaced = Get-Content -LiteralPath $jsonPath -Raw -Encoding UTF8 | ConvertFrom-Json -NoEnumerate
        Assert-BackupTest ($replaced -is [array] -and $replaced.Count -eq 1) 'Replacement JSON lost its single-item array shape.'
        Assert-BackupTest ($replaced[0].title -eq 'Гаргантюа — личная библиотека' -and $replaced[0].revision -eq 2) 'Replacement retained stale values or damaged Unicode.'
        Assert-BackupTest (-not (Test-Path -LiteralPath ($jsonPath+'.tmp'))) 'Replacement JSON publication left a temporary file.'
    }
    Invoke-BackupTest 'base64 metadata transport preserves exact Unicode JSON bytes' {
        $transferPath = Join-Path $temporaryRoot 'unicode-transfer.json'
        $json = '{"title":"Гаргантюа 🌌","notes":["Коты-воители — глава 1"]}' + "`n"
        $bytes = [Text.UTF8Encoding]::new($false).GetBytes($json)
        $encoded = [Convert]::ToBase64String($bytes)
        Write-GargantuaBase64File -Path $transferPath -Encoded ("`r`n"+$encoded+"`r`n") -MaxBytes $bytes.Length
        $actual = [IO.File]::ReadAllBytes($transferPath)
        Assert-BackupTest ($actual.Length -eq $bytes.Length -and [Convert]::ToBase64String($actual) -eq $encoded) 'Metadata bytes, BOM, Unicode or final newline changed during transfer.'
        $decoded = [Text.Encoding]::UTF8.GetString($actual) | ConvertFrom-Json
        Assert-BackupTest ($decoded.title -eq 'Гаргантюа 🌌' -and $decoded.notes[0] -eq 'Коты-воители — глава 1') 'Transferred metadata cannot be read with its original values.'
    }
    Invoke-BackupTest 'base64 transfer rejects malformed oversized and existing-file targets' {
        $malformedPath = Join-Path $temporaryRoot 'invalid-transfer.json'
        Assert-BackupThrows { Write-GargantuaBase64File -Path $malformedPath -Encoded 'abc!' } 'Invalid or oversized' | Out-Null
        Assert-BackupThrows { Write-GargantuaBase64File -Path $malformedPath -Encoded 'abc' } 'not valid base64' | Out-Null
        Assert-BackupTest (-not (Test-Path -LiteralPath $malformedPath)) 'Malformed input created an output file.'
        $oversizePath = Join-Path $temporaryRoot 'oversize-transfer.json'
        $sixBytes = [Convert]::ToBase64String([byte[]]@(1,2,3,4,5,6))
        Assert-BackupThrows { Write-GargantuaBase64File -Path $oversizePath -Encoded $sixBytes -MaxBytes 4 } 'validation limit' | Out-Null
        $sevenBytes = [Convert]::ToBase64String([byte[]]@(1,2,3,4,5,6,7))
        Assert-BackupThrows { Write-GargantuaBase64File -Path $oversizePath -Encoded $sevenBytes -MaxBytes 4 } 'Invalid or oversized' | Out-Null
        Assert-BackupTest (-not (Test-Path -LiteralPath $oversizePath)) 'Oversized input created an output file.'
        $existingPath = Join-Path $temporaryRoot 'existing-transfer.bin'
        $original = [Convert]::ToBase64String([byte[]]@(0,13,10,255))
        Write-GargantuaBase64File -Path $existingPath -Encoded $original
        Assert-BackupThrows { Write-GargantuaBase64File -Path $existingPath -Encoded 'bmV3' } | Out-Null
        Assert-BackupTest ([Convert]::ToBase64String([IO.File]::ReadAllBytes($existingPath)) -eq $original) 'An existing output file was overwritten or truncated.'
    }

    Invoke-BackupTest 'stopped handler stays stopped without a start command' {
        Reset-BackupDockerMock
        $original = New-BackupOriginal
        New-BackupState -Id $original.id -Running $false -Paused $false | Out-Null
        Restore-GargantuaHandler -State $original
        Assert-BackupTest ((Get-BackupMutationCommands).Count -eq 0) 'An originally stopped service was changed.'
    }
    Invoke-BackupTest 'running handler is restored after snapshot stop' {
        Reset-BackupDockerMock
        $original = New-BackupOriginal -Running $true
        New-BackupState -Id $original.id -Running $false -Paused $false | Out-Null
        Restore-GargantuaHandler -State $original
        Assert-BackupTest (((Get-BackupMutationCommands) -join ',') -eq 'start') 'Running restoration did not use exactly one start.'
        Assert-BackupTest ($script:DockerStates[$original.id].Running -and -not $script:DockerStates[$original.id].Paused) 'Original running state was not restored.'
    }
    Invoke-BackupTest 'paused handler is restored to paused rather than just running' {
        Reset-BackupDockerMock
        $original = New-BackupOriginal -Running $true -Paused $true
        New-BackupState -Id $original.id -Running $false -Paused $false | Out-Null
        Restore-GargantuaHandler -State $original
        Assert-BackupTest (((Get-BackupMutationCommands) -join ',') -eq 'start,pause') 'Paused restoration omitted the pause or added unrelated mutations.'
        Assert-BackupTest ($script:DockerStates[$original.id].Running -and $script:DockerStates[$original.id].Paused) 'Original paused state was not restored.'
    }
    Invoke-BackupTest 'running original unpauses a currently paused handler' {
        Reset-BackupDockerMock
        $original = New-BackupOriginal -Running $true
        New-BackupState -Id $original.id -Running $true -Paused $true | Out-Null
        Restore-GargantuaHandler -State $original
        Assert-BackupTest (((Get-BackupMutationCommands) -join ',') -eq 'unpause') 'Current paused service was not restored to the unpaused original.'
    }
    Invoke-BackupTest 'stopped original unpauses then stops an unexpectedly active handler' {
        Reset-BackupDockerMock
        $original = New-BackupOriginal
        New-BackupState -Id $original.id -Running $true -Paused $true | Out-Null
        Restore-GargantuaHandler -State $original
        Assert-BackupTest (((Get-BackupMutationCommands) -join ',') -eq 'unpause,stop') 'Stopped restoration did not remove both running and paused state.'
    }
    Invoke-BackupTest 'absent original creates no container' {
        Reset-BackupDockerMock
        Restore-GargantuaHandler -State (New-BackupOriginal -Exists $false)
        Assert-BackupTest ($script:DockerCalls.Count -eq 0) 'Absent service caused Docker calls.'
    }
    Invoke-BackupTest 'restore command failure is propagated to the caller' {
        Reset-BackupDockerMock
        $original = New-BackupOriginal -Running $true
        New-BackupState -Id $original.id -Running $false -Paused $false | Out-Null
        $script:FailDockerOperation = 'restore worker running'
        Assert-BackupThrows { Restore-GargantuaHandler -State $original } 'Injected Docker failure' | Out-Null
        Assert-BackupTest (-not $script:DockerStates[$original.id].Running) 'Failed start unexpectedly changed mock state.'
    }
    Invoke-BackupTest 'exit zero alone cannot replace final state verification' {
        Reset-BackupDockerMock
        $original = New-BackupOriginal -Running $true
        New-BackupState -Id $original.id -Running $false -Paused $false | Out-Null
        $script:IgnoreStartMutation = $true
        Assert-BackupThrows { Restore-GargantuaHandler -State $original } 'Failed to restore original' | Out-Null
    }
    Invoke-BackupTest 'service capture preserves simultaneous running and paused flags' {
        Reset-BackupDockerMock
        $id = 'b'*64
        $script:DockerServiceIds.worker = $id
        New-BackupState -Id $id -Running $true -Paused $true | Out-Null
        $state = Get-GargantuaService -Service 'worker'
        Assert-BackupTest ($state.exists -and $state.running -and $state.paused) 'Paused capture was collapsed into another state.'
        Assert-BackupTest ((Get-BackupMutationCommands).Count -eq 0) 'Capturing service state mutated a service.'
    }
    Invoke-BackupTest 'unstable restarting service is rejected before mutation' {
        Reset-BackupDockerMock
        $id = 'c'*64
        $script:DockerServiceIds.worker = $id
        $state = New-BackupState -Id $id -Running $true -Paused $false
        $state.Restarting = $true
        Assert-BackupThrows { Get-GargantuaService -Service 'worker' } 'Unstable worker state' | Out-Null
        Assert-BackupTest ((Get-BackupMutationCommands).Count -eq 0) 'Unstable capture mutated a service.'
    }
    Invoke-BackupTest 'quiescence check rejects a paused container' {
        Reset-BackupDockerMock
        $original = New-BackupOriginal -Running $true -Paused $true
        New-BackupState -Id $original.id -Running $true -Paused $true | Out-Null
        Assert-BackupThrows { Assert-GargantuaStopped -State $original } 'did not stop' | Out-Null
    }
    Invoke-BackupTest 'owned restore marker rejects a token mismatch' {
        $ownedRoot = Join-Path $temporaryRoot 'ownership-check'
        New-Item -ItemType Directory -Path $ownedRoot | Out-Null
        Write-GargantuaJson -Path (Join-Path $ownedRoot 'restore-owner.json') -Value @{token=$token;root=$ownedRoot}
        Assert-GargantuaOwnedRestore -Path $ownedRoot -Token $token
        Assert-BackupThrows { Assert-GargantuaOwnedRestore -Path $ownedRoot -Token ('0'*32) } 'ownership mismatch' | Out-Null
    }
    Invoke-BackupTest 'containment normalizes trailing separators and includes equality' {
        $base = Join-Path $temporaryRoot 'restore-boundary'
        $child = Join-Path $base 'report.json'
        $withSeparator = $base + [IO.Path]::DirectorySeparatorChar
        Assert-BackupTest (Test-GargantuaPathWithin -Root $withSeparator -Target $child) 'A trailing separator hid a descendant.'
        Assert-BackupTest (Test-GargantuaPathWithin -Root $base -Target $withSeparator) 'Equivalent root paths did not compare as equal.'
    }
    Invoke-BackupTest 'containment does not confuse a sibling sharing the same prefix' {
        $base = Join-Path $temporaryRoot 'restore-boundary'
        $sibling = Join-Path ($base+'-other') 'report.json'
        Assert-BackupTest (-not (Test-GargantuaPathWithin -Root $base -Target $sibling)) 'A sibling path was treated as an owned child.'
    }
    Invoke-BackupTest 'containment handles a filesystem root without doubling its separator' {
        $driveRoot = [IO.Path]::GetPathRoot($temporaryRoot)
        Assert-BackupTest (Test-GargantuaPathWithin -Root $driveRoot -Target $temporaryRoot) 'Filesystem-root containment missed a real descendant.'
    }
    Invoke-BackupTest 'orchestration PowerShell drafts parse without execution' {
        foreach ($name in @('backup-common.ps1','backup.ps1','verify-backup.ps1')) {
            $tokens=$null; $parseErrors=$null
            [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $project ('scripts/'+$name)),[ref]$tokens,[ref]$parseErrors) | Out-Null
            Assert-BackupTest (@($parseErrors).Count -eq 0) "PowerShell syntax errors in $name."
        }
    }
    Invoke-BackupTest 'restore launch retains isolation and a read-only dump mount' {
        $tokens=$null; $parseErrors=$null
        $ast = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $project 'scripts/verify-backup.ps1'),[ref]$tokens,[ref]$parseErrors)
        $assignment = @($ast.FindAll({param($node) $node -is [System.Management.Automation.Language.AssignmentStatementAst] -and $node.Left -is [System.Management.Automation.Language.VariableExpressionAst] -and $node.Left.VariablePath.UserPath -eq 'createArguments'},$true))
        Assert-BackupTest ($assignment.Count -eq 1) 'Restore launch arguments cannot be identified unambiguously.'
        $launch = $assignment[0].Right.Extent.Text
        Assert-BackupTest ($launch -match "'--network'\s*,\s*'none'") 'Restore container lost network isolation.'
        Assert-BackupTest ($launch.Contains("'--read-only'")) 'Restore container root filesystem became writable.'
        Assert-BackupTest ($launch -match 'target=/restore-input[.]dump,readonly') 'Dump mount lost its explicit read-only contract.'
        Assert-BackupTest ($launch -match "'--pull'\s*,\s*'never'") 'Restore validation can unexpectedly pull an image.'
    }
} catch {
    $script:Cases.Add([pscustomobject]@{name='test harness';status='FAIL';error=$_.Exception.Message})
    Write-Host "FAIL test harness: $($_.Exception.Message)"
} finally {
    if ($createdRoot) {
        try {
            $resolvedTarget = [IO.Path]::GetFullPath($temporaryRoot)
            if (-not $resolvedTarget.StartsWith($temporaryBase+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'Cleanup escaped the temporary base.' }
            if ((Get-Item -LiteralPath $resolvedTarget).Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)) { throw 'Cleanup target became a reparse point.' }
            $owner = Get-Content -LiteralPath $ownerPath -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($owner.token -ne $token -or $owner.root -ne $resolvedTarget) { throw 'Cleanup ownership mismatch.' }
            Remove-Item -LiteralPath $resolvedTarget -Recurse -Force -ErrorAction Stop
        } catch {
            $script:Cases.Add([pscustomobject]@{name='owned temporary cleanup';status='FAIL';error=$_.Exception.Message})
            Write-Host "FAIL temporary cleanup: $($_.Exception.Message)"
        }
    }
}
$failed = @($script:Cases | Where-Object { $_.status -eq 'FAIL' })
Write-Host ("Offline backup helper checks: {0} passed, {1} failed. No Docker or production entrypoint was run." -f ($script:Cases.Count-$failed.Count),$failed.Count)
if ($failed.Count) { exit 1 }
exit 0

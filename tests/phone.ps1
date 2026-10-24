param(
 [ValidateSet('snapshot','tap','swipe','swipe-back','back','enter','restart','password','text')][string]$Action='snapshot',
 [int]$X=0,[int]$Y=0,[int]$X2=0,[int]$Y2=0,
 [string]$Text='', [string]$Name='phone-current', [switch]$FilePicker
)
$ErrorActionPreference='Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
$package=Get-ChildItem "$env:LOCALAPPDATA/Microsoft/WinGet/Packages" -Directory -Filter 'Genymobile.scrcpy*' | Select-Object -First 1
$adbPath=@(rg --files $package.FullName -g adb.exe)[0]
if (-not $adbPath) { throw 'ADB not found' }
if ($Name -notmatch '^[a-zA-Z0-9-]{1,70}$') { throw 'Invalid screenshot name' }
if ($Action -ne 'restart' -and $Action -ne 'snapshot') {
 $focus=[string]((& $adbPath -d shell dumpsys window | Select-String 'mCurrentFocus') -join ' ')
 $allowedFocus=if($FilePicker){'com.google.android.documentsui|com.android.documentsui'}else{'local.cotology.reader.preview'}
 if ($focus -notmatch $allowedFocus) { throw 'Expected test app is not focused; no input sent' }
}
switch ($Action) {
 'tap' { & $adbPath -d shell input tap $X $Y }
 'swipe' { & $adbPath -d shell input swipe $X $Y $X2 $Y2 400 }
 'swipe-back' { & $adbPath -d shell input swipe $X $Y $X2 $Y2 100; & $adbPath -d shell input keyevent 4 }
 'back' { & $adbPath -d shell input keyevent 4 }
 'enter' { & $adbPath -d shell input keyevent 66 }
 'restart' { & $adbPath -d shell am force-stop local.cotology.reader.preview; & $adbPath -d shell am start -n local.cotology.reader.preview/local.cotology.reader.MainActivity }
 'password' {
  $loginData=Get-Content .local/login.txt -Raw | ConvertFrom-Json
  if ($loginData.password -notmatch '^[a-zA-Z0-9_-]{12,100}$') { throw 'Password cannot be safely entered through this test helper' }
  & $adbPath -d shell input text $loginData.password
 }
 'text' {
  if ($Text -notmatch '^[a-zA-Z0-9_-]{1,100}$') { throw 'Only bounded test text is accepted' }
  & $adbPath -d shell input text $Text
 }
}
if ($LASTEXITCODE -ne 0) { throw 'ADB action failed' }
& $adbPath -d shell uiautomator dump /data/local/tmp/cotology-ui.xml | Out-Null
& $adbPath -d pull /data/local/tmp/cotology-ui.xml .local/screenshots/phone-ui.xml 2>$null | Out-Null
& $adbPath -d shell screencap -p /data/local/tmp/cotology-check.png
& $adbPath -d pull /data/local/tmp/cotology-check.png ".local/screenshots/$Name.png" 2>$null | Out-Null
& $adbPath -d shell rm /data/local/tmp/cotology-check.png /data/local/tmp/cotology-ui.xml
[xml]$ui=Get-Content .local/screenshots/phone-ui.xml -Raw
$ui.SelectNodes('//node') | Where-Object { ($_.clickable -eq 'true' -or $_.class -eq 'android.widget.EditText') -and $_.password -ne 'true' } | ForEach-Object { [pscustomobject]@{Text=$_.text;Label=$_.'content-desc';Bounds=$_.bounds} } | ConvertTo-Json -Depth 2 -Compress

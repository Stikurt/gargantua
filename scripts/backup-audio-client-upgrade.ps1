$ErrorActionPreference='Stop'
$workspace=(Resolve-Path -LiteralPath (Split-Path $PSScriptRoot -Parent)).Path
$target=Join-Path $workspace ('backups/client-before-audio-'+[DateTime]::UtcNow.ToString('yyyy-MM-dd_HH-mm-ss')+'-'+[guid]::NewGuid().ToString('N').Substring(0,8))
New-Item -ItemType Directory -Path $target | Out-Null
$items=@(
 @{Source=(Join-Path $env:APPDATA 'Cotology/library');Name='windows-library'},
 @{Source=(Join-Path $env:APPDATA 'Cotology/audio');Name='windows-audio'},
 @{Source=(Join-Path $workspace 'releases/Cotology-Windows/resources/app');Name='previous-windows-app'},
 @{Source=(Join-Path $workspace 'releases/Cotology-Android/Cotology-preview.apk');Name='previous-android.apk'}
)
$proof=@()
foreach($item in $items){
 if(-not(Test-Path -LiteralPath $item.Source)){continue}
 $source=(Resolve-Path -LiteralPath $item.Source).Path
 $entry=Get-Item -LiteralPath $source
 if($entry.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Резервирование ссылок не поддерживается'}
 $destination=Join-Path $target $item.Name
 if($entry.PSIsContainer){
  $files=@(Get-ChildItem -LiteralPath $source -Recurse -Force -File)
  if(@(Get-ChildItem -LiteralPath $source -Recurse -Force | Where-Object {$_.Attributes -band [IO.FileAttributes]::ReparsePoint}).Count){throw 'В резервируемом каталоге обнаружена ссылка'}
  foreach($file in $files){$relative=[IO.Path]::GetRelativePath($source,$file.FullName);$copy=Join-Path $destination $relative;New-Item -ItemType Directory -Force (Split-Path $copy -Parent)|Out-Null;Copy-Item -LiteralPath $file.FullName -Destination $copy;$a=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash;$b=(Get-FileHash -LiteralPath $copy -Algorithm SHA256).Hash;if($a-ne$b){throw 'Резервная копия не совпадает с исходником'};$proof+=@{path=$item.Name+'/'+$relative.Replace('\','/');sha256=$b.ToLowerInvariant();bytes=$file.Length}}
 }else{Copy-Item -LiteralPath $source -Destination $destination;$a=(Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash;$b=(Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash;if($a-ne$b){throw 'Резервная копия не совпадает с исходником'};$proof+=@{path=$item.Name;sha256=$b.ToLowerInvariant();bytes=$entry.Length}}
}
@{schemaVersion=1;verified=$true;createdAt=[DateTimeOffset]::UtcNow.ToString('o');files=$proof}|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $target 'verification.json') -Encoding utf8
Write-Host "Проверенная копия перед обновлением клиента: $target ($($proof.Count) файлов)"

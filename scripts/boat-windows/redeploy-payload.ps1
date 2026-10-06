# Fast iteration on the backend: rebuild only the headless bundle and copy it over the
# desktop app's installed payload (the app seeds its payload only when none exists), then
# restart the app. Same POD-5301 workaround as build-desktop.ps1.
$bun = "$env:LOCALAPPDATA\mise\installs\bun\1.4.2\bin"
$rest = (($env:Path -split ';') | Where-Object { $_ -notmatch 'mise' }) -join ';'
$env:Path = "$bun;$env:USERPROFILE\.cargo\bin;$rest"
Set-Location C:\src\podium
& "$bun\bun.exe" run package:headless *> C:\headless.log
if ($LASTEXITCODE -ne 0) { Get-Content C:\headless.log -Tail 20; exit $LASTEXITCODE }
Get-Process Podium, podium-cli -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep 2
$payload = "$env:APPDATA\app.podium.desktop\payload"
Remove-Item -Recurse -Force $payload -ErrorAction SilentlyContinue
Copy-Item -Recurse C:\src\podium\dist-bun\headless $payload
'payload redeployed'

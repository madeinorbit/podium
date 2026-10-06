# Build the Windows desktop app in C:\src\podium (after boat-win.sh sync). Runs Bun without
# mise on PATH: with mise's pigz shim visible the headless archive step hangs forever
# (POD-5301). Writes C:\build.log / C:\build.err; exits with the build's exit code.
param([int]$TimeoutMinutes = 25)
$bun = "$env:LOCALAPPDATA\mise\installs\bun\1.4.2\bin"
$rest = (($env:Path -split ';') | Where-Object { $_ -notmatch 'mise' }) -join ';'
$env:Path = "$bun;$env:USERPROFILE\.cargo\bin;$rest"
Set-Location C:\src\podium
& "$bun\bun.exe" install --frozen-lockfile *> C:\install.log
if ($LASTEXITCODE -ne 0) { Get-Content C:\install.log -Tail 20; exit $LASTEXITCODE }
$t = Get-Date
$p = Start-Process -PassThru -NoNewWindow -FilePath "$bun\bun.exe" `
  -ArgumentList 'run', '--cwd', 'apps/desktop', 'build', '--', '--no-bundle' `
  -RedirectStandardOutput C:\build.log -RedirectStandardError C:\build.err
$null = $p.Handle
if (-not $p.WaitForExit($TimeoutMinutes * 60000)) { taskkill /T /F /PID $p.Id | Out-Null; 'TIMEOUT'; exit 124 }
"build exit $($p.ExitCode) after $([int]((Get-Date) - $t).TotalSeconds) s"
Get-Content C:\build.err -Tail 15
exit $p.ExitCode

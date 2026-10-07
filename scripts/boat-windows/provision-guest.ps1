# Provision the Windows guest for Podium development. Run once, as the `podium`
# admin user, over SSH (boat-win.sh provision). Re-running is safe: every step
# skips what is already installed.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$tmp = 'C:\provision'
New-Item -ItemType Directory -Force $tmp | Out-Null

function Have($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
function Fetch($url, $out) { Invoke-WebRequest -UseBasicParsing $url -OutFile $out }
function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
              [Environment]::GetEnvironmentVariable('Path', 'User')
}

# Defender real-time scanning roughly doubles bun install and cargo build times.
Set-MpPreference -DisableRealtimeMonitoring $true -ErrorAction SilentlyContinue
Add-MpPreference -ExclusionPath 'C:\src', "$env:USERPROFILE\.cargo", "$env:USERPROFILE\.rustup", "$env:LOCALAPPDATA\mise" -ErrorAction SilentlyContinue
Set-ExecutionPolicy -Scope LocalMachine Bypass -Force
# QEMU's RTC runs in UTC; Windows reads it as local time unless told otherwise, which put
# the guest clock hours off and made Cargo trust stale outputs (POD-5728).
Set-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\TimeZoneInformation' RealTimeIsUniversal 1 -Type DWord
# Long paths: node_modules trees exceed MAX_PATH.
Set-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' LongPathsEnabled 1
# No automatic updates or reboots in the middle of an agent's run.
New-Item -Force 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU' | Out-Null
Set-ItemProperty 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU' NoAutoUpdate 1

if (-not (Have git)) {
  Write-Host '== Git for Windows'
  $rel = Invoke-RestMethod https://api.github.com/repos/git-for-windows/git/releases/latest
  $asset = $rel.assets | Where-Object name -Match '^Git-.*-64-bit\.exe$' | Select-Object -First 1
  Fetch $asset.browser_download_url "$tmp\git.exe"
  Start-Process "$tmp\git.exe" -Wait -ArgumentList '/VERYSILENT','/NORESTART','/NOCANCEL','/SP-','/o:PathOption=Cmd'
  Refresh-Path
  git config --system core.longpaths true
  git config --system core.autocrlf false
}

if (-not (Test-Path 'C:\BuildTools\VC')) {
  Write-Host '== Visual Studio C++ Build Tools (slow: ~10 min)'
  Fetch https://aka.ms/vs/17/release/vs_BuildTools.exe "$tmp\vs_BuildTools.exe"
  Start-Process "$tmp\vs_BuildTools.exe" -Wait -ArgumentList '--quiet','--wait','--norestart','--nocache',
    '--installPath','C:\BuildTools',
    '--add','Microsoft.VisualStudio.Workload.VCTools',
    '--add','Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
    '--add','Microsoft.VisualStudio.Component.Windows11SDK.22621'
}

if (-not (Test-Path "$env:USERPROFILE\.cargo\bin\rustup.exe")) {
  Write-Host '== Rust (MSVC)'
  Fetch https://win.rustup.rs/x86_64 "$tmp\rustup-init.exe"
  & "$tmp\rustup-init.exe" -y --default-host x86_64-pc-windows-msvc --profile minimal
}
# rustup only edits the USER Path, which non-interactive SSH sessions do not always see.
$machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
if ($machinePath -notlike "*\.cargo\bin*") {
  [Environment]::SetEnvironmentVariable('Path', "$machinePath;$env:USERPROFILE\.cargo\bin", 'Machine')
  Refresh-Path
}

if (-not (Have mise)) {
  Write-Host '== mise'
  $rel = Invoke-RestMethod https://api.github.com/repos/jdx/mise/releases/latest
  $asset = $rel.assets | Where-Object name -Match 'windows-x64\.zip$' | Select-Object -First 1
  Fetch $asset.browser_download_url "$tmp\mise.zip"
  Expand-Archive -Force "$tmp\mise.zip" 'C:\tools'
  $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  foreach ($p in 'C:\tools\mise\bin', "$env:LOCALAPPDATA\mise\shims") {
    if ($machinePath -notlike "*$p*") { $machinePath += ";$p" }
  }
  [Environment]::SetEnvironmentVariable('Path', $machinePath, 'Machine')
  Refresh-Path
}

Write-Host '== Node (Metro/Expo needs a real Node; POD-5732) and agent CLIs'
cmd /c "mise use -g node@lts >NUL 2>&1"
cmd /c "mise reshim >NUL 2>&1"
Refresh-Path
if (-not (Have codex)) { cmd /c "npm i -g @openai/codex >NUL 2>&1"; cmd /c "mise reshim >NUL 2>&1" }
# Claude Code's native installer puts claude.exe in ~\.local\bin and leaves Path alone, like a
# real user's machine; Podium's own fallbacks have to find it there.
if (-not (Test-Path "$env:USERPROFILE\.local\bin\claude.exe")) { irm https://claude.ai/install.ps1 | iex }

Write-Host '== WebView2 runtime'
$wv = 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
if (-not (Test-Path $wv)) {
  Fetch https://go.microsoft.com/fwlink/p/?LinkId=2124703 "$tmp\webview2.exe"
  Start-Process "$tmp\webview2.exe" -Wait -ArgumentList '/silent','/install'
}

New-Item -ItemType Directory -Force 'C:\src' | Out-Null
Write-Host '== versions'
git --version; rustup --version; mise --version
Write-Host 'PROVISION OK'

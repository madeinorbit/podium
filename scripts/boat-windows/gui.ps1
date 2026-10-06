# Run a command in the signed-in desktop session (SSH sessions have no desktop), and
# optionally capture the screen. Used by boat-win.sh gui / shot / click / app.
#
# The command runs as a scheduled task in that session. This script waits until the task's
# script has finished (it writes a .done or .err marker) and fails when it errors or does not
# finish in time, so a caller never reads a stale screenshot or races a still-running click.
param([string]$Command = '', [string]$Shot = '', [int]$TimeoutSeconds = 60)
$ErrorActionPreference = 'Stop'
$name = 'boatwin-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
$marker = "$env:TEMP\$name"
if ($Shot) {
  Remove-Item -Force $Shot -ErrorAction SilentlyContinue
  $Command = @"
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
`$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
`$bmp = New-Object System.Drawing.Bitmap `$b.Width, `$b.Height
[System.Drawing.Graphics]::FromImage(`$bmp).CopyFromScreen(`$b.Location, [System.Drawing.Point]::Empty, `$b.Size)
`$bmp.Save('$Shot', [System.Drawing.Imaging.ImageFormat]::Png)
"@
}
# The task writes its own completion marker. A GUI app it launches with Start-Process does
# not hold the task open, so this measures the command, not the app's lifetime.
Set-Content -Encoding UTF8 "$marker.ps1" @"
`$ErrorActionPreference = 'Stop'
try {
$Command
  Set-Content '$marker.done' 'ok'
} catch {
  Set-Content '$marker.err' (`$_ | Out-String)
}
"@
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$marker.ps1`""
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest
Register-ScheduledTask -TaskName $name -Action $action -Principal $principal | Out-Null
try {
  Start-ScheduledTask -TaskName $name
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while (-not (Test-Path "$marker.done") -and -not (Test-Path "$marker.err")) {
    if ((Get-Date) -gt $deadline) { throw "desktop-session command did not finish within $TimeoutSeconds s" }
    Start-Sleep -Milliseconds 200
  }
  if (Test-Path "$marker.err") { throw "desktop-session command failed: $(Get-Content -Raw "$marker.err")" }
  if ($Shot -and -not (Test-Path $Shot)) { throw "no screenshot was written to $Shot" }
} finally {
  Unregister-ScheduledTask -TaskName $name -Confirm:$false
  Remove-Item -Force "$marker.ps1", "$marker.done", "$marker.err" -ErrorAction SilentlyContinue
}

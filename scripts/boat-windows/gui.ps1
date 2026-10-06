# Run a command in the signed-in desktop session (SSH sessions have no desktop), and
# optionally capture the screen. Used by boat-win.sh gui / shot.
param([string]$Command = '', [string]$Shot = '')
$ErrorActionPreference = 'Stop'
$name = 'boatwin-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
if ($Shot) {
  $Command = @"
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
`$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
`$bmp = New-Object System.Drawing.Bitmap `$b.Width, `$b.Height
[System.Drawing.Graphics]::FromImage(`$bmp).CopyFromScreen(`$b.Location, [System.Drawing.Point]::Empty, `$b.Size)
`$bmp.Save('$Shot', [System.Drawing.Imaging.ImageFormat]::Png)
"@
}
$script = "$env:TEMP\$name.ps1"
Set-Content -Encoding UTF8 $script $Command
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`""
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest
Register-ScheduledTask -TaskName $name -Action $action -Principal $principal | Out-Null
Start-ScheduledTask -TaskName $name
if ($Shot) {
  $deadline = (Get-Date).AddSeconds(30)
  while (-not (Test-Path $Shot) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 300 }
  Start-Sleep -Milliseconds 500
}
Unregister-ScheduledTask -TaskName $name -Confirm:$false

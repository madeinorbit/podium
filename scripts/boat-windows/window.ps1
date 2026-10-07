# Move/resize a top-level window in the signed-in desktop session (boat-win.sh gui runs it there).
#   & \\host.lan\Data\window.ps1 -Process Podium -X 0 -Y 0 -Width 1000 -Height 700
param([string]$Process = 'Podium', [int]$X = 0, [int]$Y = 0, [int]$Width = 1200, [int]$Height = 760)
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class BoatWindow {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int hgt, bool repaint);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@
[BoatWindow]::SetProcessDPIAware() | Out-Null
$p = Get-Process $Process -ErrorAction Stop | Where-Object MainWindowHandle -ne 0 | Select-Object -First 1
if (-not $p) { throw "no window for process $Process" }
[BoatWindow]::ShowWindow($p.MainWindowHandle, 9) | Out-Null  # SW_RESTORE (leave maximized state)
if (-not [BoatWindow]::MoveWindow($p.MainWindowHandle, $X, $Y, $Width, $Height, $true)) { throw 'MoveWindow failed' }

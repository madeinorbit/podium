# Click (or type) in the signed-in desktop session. Run through boat-win.sh click/type.
param([int]$X = -1, [int]$Y = -1, [string]$Text = '', [switch]$Double)
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class BoatInput {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@
[BoatInput]::SetProcessDPIAware() | Out-Null
if ($X -ge 0) {
  [BoatInput]::SetCursorPos($X, $Y) | Out-Null
  $n = if ($Double) { 2 } else { 1 }
  for ($i = 0; $i -lt $n; $i++) {
    [BoatInput]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero); [BoatInput]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 80
  }
}
if ($Text) { Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait($Text) }

# Shrink the Windows guest before baking a snapshot. Boat fetches each file whole before
# serving it (~110 MB/s on resume), so every GB on the Windows disk image is resume time.
# Run as the podium admin user. boat-win.sh compact runs it, reboots, then runs -ZeroOnly.
param([switch]$ZeroOnly)
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

if (-not $ZeroOnly) {
# No pagefile: the 6 GB VM RAM covers builds, and a pagefile is GBs of churn per snapshot.
$cs = Get-CimInstance Win32_ComputerSystem
if ($cs.AutomaticManagedPagefile) { Set-CimInstance $cs -Property @{ AutomaticManagedPagefile = $false } }
Get-CimInstance Win32_PageFileSetting | Remove-CimInstance
powercfg /hibernate off

# Installer and update leftovers.
Remove-Item -Recurse -Force 'C:\provision', "$env:TEMP\*", 'C:\Windows\Temp\*', 'C:\Windows\SoftwareDistribution\Download\*' -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force 'C:\ProgramData\Package Cache\*' -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\mise\downloads", "$env:USERPROFILE\.rustup\downloads", "$env:USERPROFILE\.rustup\tmp" -ErrorAction SilentlyContinue
Dism.exe /Online /Cleanup-Image /StartComponentCleanup /ResetBase /Quiet | Out-Null

}

# Zero free space so qemu-img convert drops it (detect-zeroes): sdelete-free equivalent.
# With DISK_DISCARD=ignore TRIM never reaches the host, so zero-filling is what frees it.
$f = 'C:\zero.fill'
$buf = New-Object byte[] (16MB)
$s = [IO.File]::Open($f, 'Create')
try { while ($true) { $s.Write($buf, 0, $buf.Length) } } catch { } finally { $s.Close(); Remove-Item -Force $f }

'{0} GB used on C:' -f [int]((Get-PSDrive C).Used / 1GB)

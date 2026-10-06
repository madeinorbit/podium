# Shrink the Windows guest before baking a snapshot. Boat fetches each file whole before
# serving it (~110 MB/s on resume), so every GB on the Windows disk image is resume time.
# Run as the podium admin user. boat-win.sh compact runs it, reboots, then runs -ZeroOnly.
param([switch]$ZeroOnly)
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

if (-not $ZeroOnly) {
# A fixed 4 GB pagefile: 6 GB of RAM alone runs out during the web build (node.exe at 3.5 GB
# was reported as "low virtual memory" and the build died). Windows zeroes it at every
# clean shutdown, and zeroed clusters take no space in the qcow2 disk, so the snapshot
# carries only the pages in use when it was taken (boat-win.sh stop shuts down cleanly).
$cs = Get-CimInstance Win32_ComputerSystem
if ($cs.AutomaticManagedPagefile) { Set-CimInstance $cs -Property @{ AutomaticManagedPagefile = $false } }
Get-CimInstance Win32_PageFileSetting | Remove-CimInstance
New-CimInstance -ClassName Win32_PageFileSetting -Property @{ Name = 'C:\pagefile.sys'; InitialSize = [uint32]4096; MaximumSize = [uint32]4096 } | Out-Null
Set-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Memory Management' ClearPageFileAtShutdown 1
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

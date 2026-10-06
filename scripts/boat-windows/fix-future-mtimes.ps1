# After the guest clock was corrected (RTC read as UTC, POD-5728), files written while it ran
# ahead carry timestamps in the future. Build tools compare those against "now" (cargo's
# freshness, build-clients' run-summary scan), so reset any future time to now.
$now = Get-Date
$n = 0
foreach ($root in 'C:\src', "$env:USERPROFILE\.cargo", "$env:USERPROFILE\.bun", "$env:LOCALAPPDATA\mise") {
  Get-ChildItem -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -gt $now } |
    ForEach-Object { try { $_.LastWriteTime = $now; $n++ } catch {} }
}
"reset $n future timestamps"

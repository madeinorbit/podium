#!/bin/sh
# Profile the running Podium backend (coordinating server + agent daemon) — RSS + %CPU —
# over a window, sampling from /proc. Resolves the two pids by their listening ports each
# sample (server :18787, daemon hook :45777), so it survives a restart and works
# identically for the Node (tsx) and Bun runtimes. Reusable: run under Node for a
# baseline, then under Bun, and diff the summaries.
#
#   sh scripts/profile-backend.sh <label> <duration_s> <interval_s>
#   e.g. sh scripts/profile-backend.sh node-baseline 600 20
#
# Writes perf/<label>-samples.csv and perf/<label>-summary.json.

LABEL="${1:-baseline}"
DUR="${2:-600}"
INT="${3:-20}"
OUT="perf"
mkdir -p "$OUT"
CSV="$OUT/${LABEL}-samples.csv"
SUMMARY="$OUT/${LABEL}-summary.json"
CLK=$(getconf CLK_TCK 2>/dev/null || echo 100)

ticks() { awk '{print $14+$15}' "/proc/$1/stat" 2>/dev/null; }
rssmb() { awk '/VmRSS/{printf "%.1f",$2/1024}' "/proc/$1/status" 2>/dev/null; }
pidon() { ss -ltnp 2>/dev/null | grep ":$1 " | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2; }
cpu() { awk -v a="$1" -v b="$2" -v c="$CLK" -v i="$INT" 'BEGIN{if(a==""||b==""){print ""}else{printf "%.1f",(b-a)/c/i*100}}'; }

echo "ts,server_pid,server_rss_mb,server_cpu_pct,daemon_pid,daemon_rss_mb,daemon_cpu_pct,attach_clients" > "$CSV"
sp=$(pidon 18787); dp=$(pidon 45777)
spt=$(ticks "$sp"); dpt=$(ticks "$dp")
echo "[profile] label=$LABEL server=$sp daemon=$dp dur=${DUR}s int=${INT}s clk=$CLK -> $CSV"

n=$(( DUR / INT ))
i=0
while [ "$i" -lt "$n" ]; do
  sleep "$INT"
  i=$(( i + 1 ))
  csp=$(pidon 18787); cdp=$(pidon 45777)
  cspt=$(ticks "$csp"); cdpt=$(ticks "$cdp")
  # CPU only valid when the pid is unchanged across the interval.
  if [ "$csp" = "$sp" ]; then scpu=$(cpu "$spt" "$cspt"); else scpu=""; fi
  if [ "$cdp" = "$dp" ]; then dcpu=$(cpu "$dpt" "$cdpt"); else dcpu=""; fi
  srss=$(rssmb "$csp"); drss=$(rssmb "$cdp")
  ac=$(pgrep -fc 'abduco -q -e' 2>/dev/null || echo 0)
  echo "$(date -Iseconds),$csp,$srss,$scpu,$cdp,$drss,$dcpu,$ac" >> "$CSV"
  sp=$csp; dp=$cdp; spt=$cspt; dpt=$cdpt
done

# Summary: avg/max over the samples (CPU skips the first/blank cells).
awk -F, -v label="$LABEL" '
  NR>1 {
    if($3!=""){sr+=$3;srn++; if($3>srm)srm=$3}
    if($4!=""){sc+=$4;scn++; if($4>scm)scm=$4}
    if($6!=""){dr+=$6;drn++; if($6>drm)drm=$6}
    if($7!=""){dc+=$7;dcn++; if($7>dcm)dcm=$7}
    if($8!=""){ac+=$8;acn++}
  }
  END{
    printf "{\n  \"label\": \"%s\",\n  \"samples\": %d,\n", label, NR-1
    printf "  \"server_rss_mb\": {\"avg\": %.1f, \"max\": %.1f},\n", (srn?sr/srn:0), srm
    printf "  \"server_cpu_pct\": {\"avg\": %.1f, \"max\": %.1f},\n", (scn?sc/scn:0), scm
    printf "  \"daemon_rss_mb\": {\"avg\": %.1f, \"max\": %.1f},\n", (drn?dr/drn:0), drm
    printf "  \"daemon_cpu_pct\": {\"avg\": %.1f, \"max\": %.1f},\n", (dcn?dc/dcn:0), dcm
    printf "  \"attach_clients_avg\": %.0f\n}\n", (acn?ac/acn:0)
  }' "$CSV" > "$SUMMARY"

echo "[profile] done -> $SUMMARY"
cat "$SUMMARY"

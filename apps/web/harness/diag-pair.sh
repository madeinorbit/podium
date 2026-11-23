#!/usr/bin/env bash
# Runs on vega2 from ~/podium-test-7122: prepare both arms, then one cold/warm pair per arm.
set -e
R=$1
ARMS=${2:-after before}
python3 apps/web/harness/data-on-device-baseline.py prepare --host=vega --base=17d01cd9c5 --cells=${CELLS:-h1a1} > /tmp/prep-7122.log 2>&1 || { tail -30 /tmp/prep-7122.log; exit 1; }
tail -3 /tmp/prep-7122.log
T="$HOME/podium-lanes-toolchain"; export PATH="$T:$PATH" LD_LIBRARY_PATH="$T/lib"
for arm in $ARMS; do
  dir=$HOME/podium-test-7122; [ $arm = before ] && dir=$HOME/podium-test-7122-base
  O=.artifacts/old-vs-new/diag-$arm-${SURFACE:-phone}-${CELL:-h1a1}-r$R
  (cd $dir && mkdir -p $O && echo '{"name":"test:vega2-agents","host":"vega2-agents","heldBy":"remote-lane (whole call)"}' > $O/lease.json &&
   bun --conditions=@podium/source apps/web/harness/cold-start.mjs --external-lease --mode=timing --arm=h1a1 --surface=${SURFACE:-phone} --cell=${CELL:-h1a1} --round=$R --samples=${SAMPLES:-1} ${PROFILE:---no-profile} --port=19671 --out=$O --host=vega2-agents --lease=test:vega2-agents > /tmp/diag-$arm-7122.log 2>&1; grep -E "app-|CAPTURE_FINISHED|status" /tmp/diag-$arm-7122.log || tail -40 /tmp/diag-$arm-7122.log)
done

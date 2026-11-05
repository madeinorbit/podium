#!/usr/bin/env bash
# Compare the same known released artifact before and after the runner HTTP/3 workaround.
set -euo pipefail

if [ "${GITHUB_ACTIONS:-}" != true ] || [ "${RUNNER_ENVIRONMENT:-}" != github-hosted ] || [ "${RUNNER_OS:-}" != macOS ]; then
  echo 'This transport probe runs only on an ephemeral GitHub-hosted macOS runner.' >&2
  exit 1
fi

probe_dir="${1:?pass an evidence directory}"
mkdir -p "$probe_dir"
dmg="$probe_dir/Podium_0.2.0_x64.dmg"
curl --fail --location --retry 4 --retry-all-errors --retry-delay 5 --max-time 90 \
  https://github.com/madeinorbit/podium/releases/download/v0.2.0/Podium_0.2.0_x64.dmg \
  --output "$dmg"
sw_vers > "$probe_dir/platform.txt"
xcodebuild -version >> "$probe_dir/platform.txt"
codesign --verify --strict --verbose=2 "$dmg" 2> "$probe_dir/signature.txt"
shasum -a 256 "$dmg" > "$probe_dir/before.sha256"
printf 'phase,attempt,status,seconds\n' > "$probe_dir/results.csv"

probe() {
  local phase="$1" attempt started status
  for attempt in 1 2 3; do
    started=$(date +%s)
    if xcrun stapler validate -v "$dmg" > "$probe_dir/$phase-$attempt.log" 2>&1; then
      status=0
    else
      status=$?
    fi
    printf '%s,%s,%s,%s\n' "$phase" "$attempt" "$status" "$(( $(date +%s) - started ))" \
      | tee -a "$probe_dir/results.csv"
    cat "$probe_dir/$phase-$attempt.log"
  done
}

probe baseline

# GitHub runner maintainers confirmed UDP/443 failures for stapler's HTTP/3 path:
# https://github.com/actions/runner-images/issues/14924#issuecomment-6188826956
# Only this disposable runner is affected; HTTPS still uses TLS over TCP.
printf '%s\n' 'block return out quick proto udp from any to any port 443' | sudo pfctl -f -
sudo pfctl -E
sudo pfctl -sr > "$probe_dir/active-pf-rules.txt"
probe tcp

shasum -a 256 "$dmg" > "$probe_dir/after.sha256"
cmp "$probe_dir/before.sha256" "$probe_dir/after.sha256"
awk -F, '$1 == "tcp" && $3 != "0" { failed=1 } END { exit failed }' "$probe_dir/results.csv"

#!/usr/bin/env bash
# Compare the same known released artifact before and after the runner HTTP/3 workaround.
set -euo pipefail

if [ "${GITHUB_ACTIONS:-}" != true ] || [ "${RUNNER_ENVIRONMENT:-}" != github-hosted ] || [ "${RUNNER_OS:-}" != macOS ]; then
  echo 'This transport probe runs only on an ephemeral GitHub-hosted macOS runner.' >&2
  exit 1
fi

probe_dir="${1:?pass an evidence directory}"
mkdir -p "$probe_dir"

# Read the exact original submission through the same existing release credentials.
# Keep the temporary private key outside the uploaded evidence directory.
umask 077
notary_key="$RUNNER_TEMP/stapler-probe-key.p8"
trap 'rm -f "$notary_key"' EXIT
printf '%s\n' "${APPLE_API_KEY_CONTENT:?release API key is required for the submission log}" > "$notary_key"
xcrun notarytool log ef934ca2-1d7a-4dda-8c07-a2c1dd55e296 \
  --key "$notary_key" --key-id "${APPLE_API_KEY:?}" --issuer "${APPLE_API_ISSUER:?}" \
  "$probe_dir/original-submission.json"
rm -f "$notary_key"
python3 - "$probe_dir" <<'PY'
from pathlib import Path
import json, sys
root = Path(sys.argv[1])
log = json.loads((root / 'original-submission.json').read_text())
assert log['jobId'] == 'ef934ca2-1d7a-4dda-8c07-a2c1dd55e296'
assert log['status'] == 'Accepted', log['status']
tickets = [item for item in log['ticketContents'] if item['path'].endswith('.dmg')]
assert tickets, 'No DMG ticket in the accepted submission log'
assert all(item['digestAlgorithm'] == 'SHA-256' for item in tickets)
request = {'records': [{'recordName': '2/2/' + item['cdhash'].lower()} for item in tickets]}
(root / 'original-ticket-request.json').write_text(json.dumps(request))
PY
curl --http2 --fail --show-error --retry 3 --retry-all-errors --max-time 30 \
  --header 'Content-Type: application/json' \
  --data-binary "@$probe_dir/original-ticket-request.json" \
  https://api.apple-cloudkit.com/database/1/com.apple.gk.ticket-delivery/production/public/records/lookup \
  --output "$probe_dir/original-ticket-response.json"
python3 - "$probe_dir" <<'PY'
from pathlib import Path
import json, sys
root = Path(sys.argv[1])
log = json.loads((root / 'original-submission.json').read_text())
request = json.loads((root / 'original-ticket-request.json').read_text())
response = json.loads((root / 'original-ticket-response.json').read_text())
records = response['records']
assert {item['recordName'] for item in records} == {item['recordName'] for item in request['records']}
assert all(item.get('fields', {}).get('signedTicket', {}).get('value') for item in records), records
summary = {'submission': log['jobId'], 'status': log['status'], 'archive': log['archiveFilename'], 'archiveSha256': log['sha256'], 'issues': log['issues'], 'ticketRecords': [item['recordName'] for item in records], 'signedTicketsRetrievedOverHttp2': len(records)}
(root / 'original-ticket-summary.json').write_text(json.dumps(summary, indent=2) + '\n')
print(json.dumps(summary, indent=2))
PY

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

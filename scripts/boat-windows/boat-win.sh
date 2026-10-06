#!/usr/bin/env bash
# Windows test sandboxes on boat.dev. Each boat sandbox is a Linux VM with nested
# KVM; inside it a dockur/windows container runs a Windows 11 LTSC guest whose disk
# lives in ~/win/storage, so boat's filesystem snapshots carry the whole Windows
# install. See docs/agents/boat-windows.md.
#
#   boat-win.sh up [--name N]        fork a sandbox from the base snapshot, wait for Windows SSH
#   boat-win.sh list                  this tool's sandboxes (named podium-win-*)
#   boat-win.sh sync ID [REF]         ship the local checkout (REF, default HEAD) to C:\src\podium
#   boat-win.sh win ID [CMD...]       run a PowerShell command in the guest (no CMD: interactive)
#   boat-win.sh pull ID GUESTPATH LOCALPATH   copy a file out of the guest
#   boat-win.sh bun ID FILE [ARGS]    run a local .ts file in the guest checkout (Bun, source conditions)
#   boat-win.sh gui ID CMD...         run PowerShell in the signed-in desktop session (GUI apps)
#   boat-win.sh shot ID OUT.png       screenshot of the Windows desktop
#   boat-win.sh click ID X Y [TEXT]   left-click at screen pixel X,Y (as in a shot), then type TEXT
#                                     (SendKeys syntax: {ENTER}, ^a, …). Type in the SAME call: a
#                                     separate call's helper process takes the keyboard focus.
#   boat-win.sh app ID [EXE]          (re)start the desktop app with WebView2 remote debugging on
#   boat-win.sh ui ID STEP...         drive the app UI by text (see ui.ts); `ui ID shot OUT.png` fetches it
#   boat-win.sh desktop ID            print the noVNC URL of the Windows screen
#   boat-win.sh stop ID               shut Windows down cleanly, then stop (snapshot) the sandbox
#   boat-win.sh resume ID             resume a stopped sandbox and wait for Windows SSH
#   boat-win.sh extend ID [MIN]      push auto-stop out to MIN minutes from now (default 30)
#   boat-win.sh rm ID                 delete the sandbox
#   boat-win.sh compact ID            shrink-guest.ps1, then rewrite the disk as a dense zstd qcow2
#   boat-win.sh bake ID [NAME]        shut Windows down, save as NAME (default $BOAT_WIN_BASE), stop
set -euo pipefail

BASE_SNAPSHOT="${BOAT_WIN_BASE:-podium-win}"  # or win11-clean: Windows + SSH only
# Short on purpose: boat auto-stop is time-based only, so a forgotten sandbox stops
# soon. Agents call `extend` while they still need it.
TTL="${BOAT_WIN_TTL:-1800}"
GUEST_SSH='ssh -q -i ~/.ssh/win_ed25519 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=5 -p 2222 podium@127.0.0.1'

die() { echo "boat-win: $*" >&2; exit 1; }
need_id() { [[ -n "${1:-}" ]] || die "missing sandbox id"; }

# Run a shell command on the sandbox host (Linux).
host() { local id="$1"; shift; boat ssh "$id" "$*"; }

# Run PowerShell in the guest. The script travels as -EncodedCommand (base64 UTF-16LE),
# so no quoting layer between here and Windows can alter it. Exits with its exit code.
ps() {
  local id="$1" enc
  enc=$(printf '$ProgressPreference="SilentlyContinue"\n%s\nexit $LASTEXITCODE' "$2" | iconv -t UTF-16LE | base64 -w0)
  host "$id" "$GUEST_SSH powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $enc"
}

# Start Windows only once boat has finished restoring the sandbox's files. Boat's lazy
# filesystem fetches a file whole before serving it, and a process that opens the disk
# image while it is still downloading is never woken (seen 2026-10-06), so an early
# `docker start` hangs dockur forever. The container therefore has no restart policy.
start_windows() {
  local id="$1" deadline=$((SECONDS + 900))
  until host "$id" 'st=/var/lib/ascii-lazy/status.json; { [ ! -e $st ] || grep -q "\"phase\":\"done\"" $st; } && test -s ~/win/storage/data.qcow2 && echo restored' 2>/dev/null | grep -q restored; do
    (( SECONDS < deadline )) || die "sandbox files still restoring on $id after 15 min"
    sleep 5
  done
  # Recreate the container every time, so its settings come from this repo, not the snapshot.
  boat ssh "$id" 'bash -s' < "$(dirname "$0")/start-win.sh" >/dev/null
}

# Shut Windows down and make the disk file DENSE before boat snapshots it. Boat cannot
# restore a sparse file (the first read hangs forever), and qcow2 can leave small holes.
quiesce() {
  host "$1" 'docker stop -t 120 win >/dev/null; f=~/win/storage/data.qcow2; fallocate -l $(stat -c %s $f) $f && sync'
}

wait_windows() {
  local id="$1" deadline=$((SECONDS + 600))
  echo "waiting for Windows SSH on $id ..." >&2
  # boat ssh prints its own failures as JSON on stdout, so match the guest's answer.
  until host "$id" "$GUEST_SSH whoami" 2>/dev/null | grep -qi podium; do
    (( SECONDS < deadline )) || die "Windows SSH did not come up in 10 min; see: boat-win.sh desktop $id"
    sleep 5
  done
  echo "Windows ready on $id" >&2
}

cmd="${1:-}"; shift || true
case "$cmd" in
  up)
    name="podium-win-$(date +%m%d-%H%M%S)"
    [[ "${1:-}" == --name ]] && name="podium-win-$2"
    id=$(boat new --from "$BASE_SNAPSHOT" --ttl "$TTL" --json | tail -1 |
         python3 -c 'import sys,json;d=json.load(sys.stdin);d=d.get("sandbox",d);print(d.get("id") or d)')
    [[ "$id" == bx_* ]] || die "boat new failed: $id"
    # Rename is not exposed by the CLI; the name lives only in this tool's log.
    echo "$id $name $(date -u +%FT%TZ)" >> "${XDG_STATE_HOME:-$HOME/.local/state}/boat-win.log" 2>/dev/null || true
    start_windows "$id"
    wait_windows "$id"
    echo "$id"
    ;;
  list)
    boat list --json | python3 -c '
import sys,json
for s in json.load(sys.stdin)["sandboxes"]:
    print(s["id"], s["state"], s["type"], s["archiveAfter"], s["name"])'
    ;;
  sync)
    need_id "${1:-}"; id="$1"; ref="${2:-HEAD}"
    root=$(git rev-parse --show-toplevel)
    sha=$(git -C "$root" rev-parse "$ref")
    bundle=$(mktemp --suffix=.bundle)
    git -C "$root" bundle create "$bundle" "$ref" --quiet 2>/dev/null || git -C "$root" bundle create "$bundle" "$ref"
    boat scp "$bundle" "$id:/home/user/win/shared/podium.bundle" >/dev/null
    rm -f "$bundle"
    # \\host.lan\Data is the dockur Samba share backed by ~/win/shared.
    ps "$id" "if (-not (Test-Path C:\\src\\podium\\.git)) { git init -q C:\\src\\podium }; cd C:\\src\\podium; git fetch -q //host.lan/Data/podium.bundle $sha; git checkout -q --force $sha; git log -1 --oneline"
    host "$id" 'rm -f ~/win/shared/podium.bundle'   # else every resume re-downloads it
    ;;
  win)
    need_id "${1:-}"; id="$1"; shift
    if (( $# )); then ps "$id" "$*"
    else boat ssh "$id" -t "$GUEST_SSH"; fi
    ;;
  pull)
    need_id "${1:-}"; id="$1"; src="$2"; dst="$3"
    ps "$id" "Copy-Item -Force '$src' \\\\host.lan\\Data\\out.bin"
    boat scp "$id:/home/user/win/shared/out.bin" "$dst" >/dev/null
    ;;
  bun)
    # Copied INTO the checkout (C:\src\podium\apps\cli\.boat-run) so workspace packages resolve.
    need_id "${1:-}"; id="$1"; file="$2"; shift 2
    name="$(basename "$file")"
    boat scp "$file" "$id:/home/user/win/shared/run-$name" >/dev/null
    ps "$id" "New-Item -ItemType Directory -Force C:\\src\\podium\\apps\\cli\\.boat-run | Out-Null; Copy-Item -Force \\\\host.lan\\Data\\run-$name C:\\src\\podium\\apps\\cli\\.boat-run\\$name; cd C:\\src\\podium\\apps\\cli; & \"\$env:LOCALAPPDATA\\mise\\installs\\bun\\1.4.2\\bin\\bun.exe\" --conditions=@podium/source .boat-run\\$name $*"
    ;;
  click)
    need_id "${1:-}"; id="$1"; x="$2"; y="$3"; shift 3
    boat scp "$(dirname "$0")/click.ps1" "$id:/home/user/win/shared/click.ps1" >/dev/null
    text="${*//\'/\'\'}"
    "$0" gui "$id" "& \\\\host.lan\\Data\\click.ps1 -X $x -Y $y${text:+ -Text '$text'}"
    ;;
  app)
    need_id "${1:-}"; id="$1"
    exe="${2:-C:\\src\\podium\\apps\\desktop\\src-tauri\\target\\release\\Podium.exe}"
    # A fresh build re-stamps the web bundle while sw.js can stay byte-identical, so the
    # service worker keeps serving the previous page; start every app run from no SW cache.
    ps "$id" 'Get-Process Podium,msedgewebview2 -EA 0 | Stop-Process -Force; Start-Sleep 1; Remove-Item -Recurse -Force "$env:LOCALAPPDATA\app.podium.desktop\EBWebView\Default\Service Worker" -EA 0' >/dev/null 2>&1 || true
    "$0" gui "$id" "\$env:PODIUM_WEBVIEW_DEBUG_PORT = '9222'; Start-Process -WindowStyle Maximized '$exe'"
    deadline=$((SECONDS + 120))
    until ps "$id" '(Invoke-WebRequest -UseBasicParsing http://127.0.0.1:9222/json/version -TimeoutSec 3).StatusCode' 2>/dev/null | grep -q 200; do
      (( SECONDS < deadline )) || die "the app's WebView2 debugging port did not open"
      sleep 3
    done
    ;;
  ui)
    need_id "${1:-}"; id="$1"; shift
    if [[ "${1:-}" == shot ]]; then
      "$0" bun "$id" "$(dirname "$0")/ui.ts" shot 'C:\\ui.png'
      ps "$id" 'Copy-Item -Force C:\ui.png \\host.lan\Data\ui.png'
      boat scp "$id:/home/user/win/shared/ui.png" "${2:-ui.png}" >/dev/null
    else
      args=""; for a in "$@"; do args+=" '${a//\'/\'\'}'"; done
      "$0" bun "$id" "$(dirname "$0")/ui.ts" $args
    fi
    ;;
  gui|shot)
    need_id "${1:-}"; id="$1"; shift
    boat scp "$(dirname "$0")/gui.ps1" "$id:/home/user/win/shared/gui.ps1" >/dev/null
    if [[ "$cmd" == gui ]]; then
      tmp=$(mktemp); printf '%s\n' "$*" > "$tmp"
      boat scp "$tmp" "$id:/home/user/win/shared/gui-cmd.ps1" >/dev/null; rm -f "$tmp"
      ps "$id" '& \\host.lan\Data\gui.ps1 -Command (Get-Content -Raw \\host.lan\Data\gui-cmd.ps1)'
    else
      [[ -n "${1:-}" ]] || die "missing output path"
      ps "$id" 'Remove-Item -Force C:\shot.png -EA 0; & \\host.lan\Data\gui.ps1 -Shot C:\shot.png; Copy-Item -Force C:\shot.png \\host.lan\Data\shot.png'
      boat scp "$id:/home/user/win/shared/shot.png" "$1" >/dev/null
    fi
    ;;
  desktop)
    need_id "${1:-}"
    url=$(boat host "$1" 8006 --json 2>/dev/null | tail -1 | python3 -c 'import sys,json;print(json.load(sys.stdin).get("url",""))' || true)
    echo "${url:-run: boat forward $1 8006   then open http://localhost:8006}"
    ;;
  stop)
    need_id "${1:-}"
    quiesce "$1"
    boat stop "$1"
    ;;
  resume)
    need_id "${1:-}"
    boat resume "$1" --ttl "$TTL" >/dev/null
    start_windows "$1"
    wait_windows "$1"
    ;;
  extend)
    need_id "${1:-}"; boat extend "$1" --ttl $(( ${2:-30} * 60 )) >/dev/null ;;
  rm)
    need_id "${1:-}"; boat delete "$1" --yes ;;
  compact)
    # Every GB on the disk image is ~10 s of resume time (boat restores ~110 MB/s), so
    # zero free space in the guest and let qemu-img drop it and compress the rest.
    need_id "${1:-}"; id="$1"
    boat scp "$(dirname "$0")/shrink-guest.ps1" "$id:/home/user/win/shared/shrink.ps1" >/dev/null
    ps "$id" 'powershell -ExecutionPolicy Bypass -File \\host.lan\Data\shrink.ps1'
    # Reboot so the removed pagefile is gone, then zero the freed space too.
    host "$id" 'docker restart -t 120 win >/dev/null'; wait_windows "$id"
    ps "$id" 'powershell -ExecutionPolicy Bypass -File \\host.lan\Data\shrink.ps1 -ZeroOnly'
    host "$id" 'set -e; docker stop -t 120 win >/dev/null; cd ~/win/storage
      command -v qemu-img >/dev/null || sudo apt-get install -y -qq qemu-utils >/dev/null
      qemu-img convert -c -O qcow2 -o compression_type=zstd,preallocation=off data.qcow2 data.new
      fallocate -l $(stat -c %s data.new) data.new && mv data.new data.qcow2 && ls -l data.qcow2
      rm -f ~/win/shared/shrink.ps1'
    start_windows "$id"
    wait_windows "$id"
    ;;
  bake)
    need_id "${1:-}"
    host "$1" 'rm -f ~/win/shared/*'
    quiesce "$1"
    boat snapshot "$1" "${2:-$BASE_SNAPSHOT}"
    boat stop "$1"
    ;;
  *) sed -n '2,20p' "$0"; exit 1 ;;
esac

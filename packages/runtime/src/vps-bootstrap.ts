export type VpsReleaseChannel = 'stable' | 'edge'

const RELEASE_BASE = 'https://github.com/madeinorbit/podium/releases'

// A fresh VPS is allowed to be genuinely bare. Download install.sh to a complete file before
// executing it, and install curl first when the distro has neither supported downloader. Keep
// this browser-safe: the activation UI renders the command locally without importing node:fs.
const BARE_LINUX_FETCH = [
  'set -eu',
  'url="$1"',
  'shift',
  'if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then if [ "$(id -u)" = "0" ]; then elevate=""; elif command -v sudo >/dev/null 2>&1; then elevate="sudo -n"; else echo "podium: need root or passwordless sudo to install curl" >&2; exit 1; fi; if command -v apt-get >/dev/null 2>&1; then $elevate apt-get update >/dev/null; $elevate env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates curl >/dev/null; elif command -v apk >/dev/null 2>&1; then $elevate apk add --no-cache ca-certificates curl >/dev/null; elif command -v dnf >/dev/null 2>&1; then $elevate dnf install -y ca-certificates curl >/dev/null; elif command -v yum >/dev/null 2>&1; then $elevate yum install -y ca-certificates curl >/dev/null; elif command -v zypper >/dev/null 2>&1; then $elevate zypper --non-interactive refresh >/dev/null; $elevate zypper --non-interactive install ca-certificates curl >/dev/null; elif command -v pacman >/dev/null 2>&1; then $elevate pacman -Sy --noconfirm ca-certificates curl >/dev/null; else echo "podium: no downloader and no supported package manager" >&2; exit 1; fi; fi',
  'tmp="${TMPDIR:-/tmp}/podium-install.$$"',
  'trap "rm -f \\"$tmp\\"" EXIT HUP INT TERM',
  'if command -v curl >/dev/null 2>&1; then curl -fsSL "$url" -o "$tmp"; else wget -qO "$tmp" "$url"; fi',
  'sh "$tmp" "$@"',
].join('; ')

function installerUrl(channel: VpsReleaseChannel): string {
  return channel === 'edge'
    ? `${RELEASE_BASE}/download/edge/install.sh`
    : `${RELEASE_BASE}/latest/download/install.sh`
}

/**
 * One command for a NEW Podium authority on a VPS — not a machine join and not a server transfer.
 * The installer adds Podium and supported agents; the dedicated TTY flow then configures this VPS
 * as an all-in-one host, asks only for safe reachability/login choices, and starts it persistently.
 */
export function buildVpsBootstrapCommand(channel: VpsReleaseChannel = 'stable'): string {
  return (
    "sh -c '" +
    BARE_LINUX_FETCH +
    '; exec "$HOME/.local/bin/podium" setup --vps\' sh ' +
    installerUrl(channel) +
    ' --channel ' +
    channel +
    ' --agents codex,claude-code,grok'
  )
}

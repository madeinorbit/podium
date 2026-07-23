import { encodeJoin } from '@podium/runtime/join'
import { wssFrom } from '@podium/runtime/setup'

const RELEASE_BASE = 'https://github.com/madeinorbit/podium/releases'

// The machine may be a bare distro image with neither curl nor wget. Keep this
// outer bootstrap limited to fetching install.sh; install.sh itself installs the
// complete Podium/agent prerequisite set. It downloads to a file before running
// it so a failed fetch cannot become a successful empty `curl | sh` pipeline.
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

/** Keep a new daemon on the same release train as the server that admitted it. */
function installerUrl(channel: 'stable' | 'edge'): string {
  return channel === 'edge'
    ? `${RELEASE_BASE}/download/edge/install.sh`
    : `${RELEASE_BASE}/latest/download/install.sh`
}

/**
 * Build the ready-to-paste join command for a new machine. The outer POSIX-sh
 * bootstrap installs curl when a bare supported distro has no downloader, then
 * runs install.sh from a complete temporary file.
 * The token embeds the instance's ws-ified `publicUrl` plus a freshly-minted
 * pairing code, so a single paste joins the machine to this server.
 *
 * Throws when no `publicUrl` is configured yet (setup not finished).
 */
export function buildJoinCommand(p: {
  publicUrl?: string
  pairCode: string
  name?: string
  channel?: 'stable' | 'edge'
}): string {
  if (!p.publicUrl) {
    throw new Error('No public URL configured yet — finish setup (networking step) first.')
  }
  const token = encodeJoin({
    v: 1,
    serverUrl: wssFrom(p.publicUrl),
    pairCode: p.pairCode,
    ...(p.name ? { name: p.name } : {}),
  })
  const channel = p.channel ?? 'stable'
  return `sh -c '${BARE_LINUX_FETCH}' sh ${installerUrl(channel)} --channel ${channel} --agents codex,claude-code,grok --join ${token}`
}

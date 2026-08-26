export type VpsReleaseChannel = 'stable' | 'edge'

const RELEASE_BASE = 'https://github.com/madeinorbit/podium/releases'

function installerUrl(channel: VpsReleaseChannel): string {
  return channel === 'edge'
    ? `${RELEASE_BASE}/download/edge/install.sh`
    : `${RELEASE_BASE}/latest/download/install.sh`
}

/**
 * One command for a NEW Podium authority on a VPS — not a machine join and not a server transfer.
 * The installer adds Podium and supported agents; the dedicated TTY flow then configures this VPS
 * as an all-in-one host, asks only for safe reachability/login choices, and starts it persistently.
 *
 * The channel is REQUIRED and must be the channel of the app presenting the command: there is no
 * default because guessing or substituting a release train installs a different build than the
 * user chose.
 */
export function buildVpsBootstrapCommand(channel: VpsReleaseChannel): string {
  const url = installerUrl(channel)
  // Keep the command inspectable without returning to `curl | sh`: curl must finish a complete
  // file before a shell executes it. Running that file also leaves stdin attached to the SSH TTY,
  // which the interactive `setup --vps` step requires.
  return (
    'tmp="$(mktemp)" && ' +
    'trap \'rm -f "$tmp"\' EXIT HUP INT TERM && ' +
    `curl -fsSL "${url}" -o "$tmp" && ` +
    `sh "$tmp" --channel ${channel} --agents codex,claude-code,grok && ` +
    '"$HOME/.local/bin/podium" setup --vps'
  )
}

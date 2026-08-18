export type VpsReleaseChannel = 'stable' | 'edge'

const RELEASE_BASE = 'https://github.com/madeinorbit/podium/releases'

/**
 * Whether `stable` names a published release. Podium is pre-1.0: only the rolling
 * `edge` prerelease is published (README; POD-1848 owns cutting the first stable),
 * and `releases/latest` deliberately ignores prereleases — so the stable installer
 * URL is a 404, not a slower path to the same file. Cutting the first stable tag
 * flips this constant in the same commit.
 */
export const STABLE_INSTALLER_PUBLISHED = false

/**
 * The channel a VPS can actually install from, which is not always the one this
 * instance updates on. Asking for a channel nothing is published on is answered
 * with the train that exists rather than with a command that 404s — the caller is
 * expected to SAY so (see `VpsFirstActivation`), never to substitute in silence.
 */
export function vpsInstallerChannel(channel: VpsReleaseChannel): VpsReleaseChannel {
  return channel === 'stable' && !STABLE_INSTALLER_PUBLISHED ? 'edge' : channel
}

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
 * The channel is REQUIRED and resolved through {@link vpsInstallerChannel}: there is no default
 * because a guessed channel is what pasted an installer URL nobody had published (POD-1288).
 */
export function buildVpsBootstrapCommand(channel: VpsReleaseChannel): string {
  const installing = vpsInstallerChannel(channel)
  const url = installerUrl(installing)
  // Keep the command inspectable without returning to `curl | sh`: curl must finish a complete
  // file before a shell executes it. Running that file also leaves stdin attached to the SSH TTY,
  // which the interactive `setup --vps` step requires.
  return (
    'tmp="$(mktemp)" && ' +
    'trap \'rm -f "$tmp"\' EXIT HUP INT TERM && ' +
    `curl -fsSL "${url}" -o "$tmp" && ` +
    `sh "$tmp" --channel ${installing} --agents codex,claude-code,grok && ` +
    '"$HOME/.local/bin/podium" setup --vps'
  )
}

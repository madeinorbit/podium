import { type InstallerChannel, installerUrls } from './installer'

export type VpsReleaseChannel = InstallerChannel

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
  const urls = installerUrls(channel)
  // Keep the command inspectable without returning to `curl | sh`: curl must finish a complete
  // file before a shell executes it.
  //
  // `--vps` rather than a chained `podium setup --vps` [POD-3274]: install.sh now hands off to
  // the installed binary itself, so the VPS flow runs inside the one command. Chaining a second
  // one meant an operator who lost the tail of a pasted line got an installed-but-unconfigured
  // box; there is no tail to lose now.
  return (
    'tmp="$(mktemp)" && ' +
    'trap \'rm -f "$tmp"\' EXIT HUP INT TERM && ' +
    `(${urls.map((url) => `curl -fsSL --connect-timeout 5 --max-time 10 "${url}" -o "$tmp"`).join(' || ')}) && ` +
    `sh "$tmp" --channel ${channel} --agents codex,claude-code,grok --vps`
  )
}

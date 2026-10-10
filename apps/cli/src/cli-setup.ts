import { existsSync, renameSync, rmSync } from 'node:fs'
import { stagePasswordForFirstBoot as realSetPassword } from '@podium/runtime/auth-store'
import {
  configPath,
  forgetConfig,
  inspectConfig,
  loadConfig,
  saveConfig,
  stateDir,
} from '@podium/runtime/config'
import { CHECK_ERROR_SENTENCES, type CheckResult } from '@podium/runtime/connect-check'
import { connectivityPath, readLiveConnectivity } from '@podium/runtime/connectivity'
import { decodeJoin } from '@podium/runtime/join'
import { loadSupervisorState } from '@podium/runtime/machine-supervisor'
import {
  assertModeWritable,
  assertPublicUrlWritable,
  commandExists,
  ephemeralTunnelWarning,
  type NetworkOption,
  networkOptionCommand,
  networkOptionTool,
  validatePublicUrl,
} from '@podium/runtime/setup'
import { prepareSetupEnrollment } from '@podium/runtime/setup-enrollment'
import { applyJoinToken } from './cli-join'
import { realCheckReachability } from './cli-reachability'
import { hasSystemctl, hasUserSystemd } from './cli-systemd'
import { realTailscaleDeps, type TailscaleDeps, tailscaleStep } from './setup-tailscale'
import { isCancel, type SetupIO } from './setup-ui'
import {
  bundledCloudflaredPath,
  type EnableTunnelResult,
  downloadCloudflared as realDownloadCloudflared,
  enableTunnel as realEnableTunnel,
  waitForTunnelUrl as realWaitForTunnelUrl,
} from './tunnel-cli'

export type { SetupIO } from './setup-ui'

export interface StartBackendOpts {
  persistence: 'systemd' | 'detached'
  /** 'daemon' = a joined worker (start just the daemon); host modes start the split. */
  mode: HostMode | 'daemon'
  port: number
}
export interface StartBackendResult {
  /** What actually got set up (systemd install can fall back to detached). */
  effectivePersistence: 'systemd' | 'detached'
  message: string
}

export interface SetupDeps {
  /** Injected for testing; defaults to the real scrypt-backed password store. */
  setPassword?: (password: string) => Promise<void>
  /** Injected for testing; defaults to real systemd-install / detached-spawn. */
  startBackend?: (opts: StartBackendOpts) => Promise<StartBackendResult>
  /** Injected for testing; defaults to observing the daemon cross-process connectivity. */
  waitForEnrollment?: () => Promise<void>
  /**
   * `--confirm-url-change` (PDM-26): the operator has already said that replacing
   * a live public URL — and stranding every machine that joined at the old one —
   * is what they mean. Without it the flow asks, which is the right shape for a
   * terminal; the flag exists so a scripted re-run does not hang on the prompt.
   */
  confirmUrlChange?: boolean
  /**
   * This machine is being configured AS PART OF INSTALLING IT (`podium install-finish`), so
   * the backend's first boot must already see the persistence choice.
   *
   * Without it the freshly installed hub starts before `persistence` is written, and
   * `/readiness` correctly answers `activation_pending / restart_required` with the data
   * plane BLOCKED — a one-paste install that silently needs a restart before anything works.
   * Found by the two-container end-to-end run: minting a join code on the new hub answered
   * `server_not_ready`, `stale: ["persistence"]`.
   *
   * `runVpsSetup` has always passed it. The CLI flow could not have wanted it before, because
   * until POD-3274 nothing ran it on a machine that had just been installed.
   */
  activateImmediately?: boolean
  /**
   * Injected for testing; defaults to a PATH walk. Answers whether the tool a reachability
   * option needs — `tailscale`, `cloudflared` — can actually be run on this machine, so the
   * flow can offer install instructions instead of a command that cannot work.
   */
  hasCommand?: (binary: string) => boolean
  /**
   * Injected for testing; defaults to asking Podium Connect to probe the pasted URL from
   * the outside (POD-4534 — see cli-reachability.ts for why it is a direct ConnectClient
   * rather than the local server's `connect.check` router). `undefined` = "we could not
   * ask" (Connect off, no installation identity yet, cloud unreachable): no opinion, and
   * the flow proceeds exactly as it would with no check. A failed probe NEVER blocks —
   * the flow warns and asks, and the operator's yes is honoured. Tests stub this, so no
   * test performs network I/O.
   */
  checkReachability?: (url: string) => Promise<CheckResult | undefined>
  /**
   * THE MANAGED QUICK TUNNEL (POD-3274). Injected for testing; the defaults download
   * cloudflared, install the podium-tunnel user unit and read the URL the server records.
   * No test may touch the network or systemd, so each step has a seam.
   */
  managedTunnel?: Partial<ManagedTunnelDeps>
  /** Injected for testing: Tailscale's state and the commands setup runs (POD-3274). */
  tailscale?: Partial<TailscaleDeps>
  /** Injected for testing: fetch a tailnet-only URL from this machine (Tailscale Serve). */
  checkInside?: (url: string) => Promise<boolean>
}

/** What the managed Cloudflare quick tunnel needs from the machine. */
export interface ManagedTunnelDeps {
  /** cloudflared is on PATH, or setup already downloaded it beside podium. */
  hasCloudflared: () => boolean
  /** A systemd user session exists to keep podium-tunnel running. */
  canSupervise: () => boolean
  /** Fetch Cloudflare's own cloudflared build; resolves to where it was put. */
  download: () => Promise<string>
  /** Install and start the podium-tunnel unit. */
  enable: () => EnableTunnelResult
  /** Resolve to the first quick-tunnel URL the server records that is not `previous`. */
  waitForUrl: (previous?: string) => Promise<string | undefined>
}

function managedTunnelDeps(
  hasCommand: (binary: string) => boolean,
  over: Partial<ManagedTunnelDeps> = {},
): ManagedTunnelDeps {
  return {
    hasCloudflared: () => hasCommand('cloudflared') || existsSync(bundledCloudflaredPath()),
    canSupervise: () => hasSystemctl() && hasUserSystemd(),
    download: () => realDownloadCloudflared(),
    enable: () => realEnableTunnel(),
    waitForUrl: (previous) => realWaitForTunnelUrl(previous ? { previous } : {}),
    ...over,
  }
}

const JOIN_CONNECT_TIMEOUT_MS = 30_000
const JOIN_CONNECT_POLL_MS = 100

/** Wait for this join attempt to reach an authenticated daemon handshake. The daemon's
 * connectivity file is the cross-process truth: a parent PID or a started systemd unit says
 * nothing about whether the source accepted the credential.
 *
 * Read it through the POD-3815 liveness fence (POD-3826). The file is shared by every
 * process that has ever held this machine's link, so a record outlives its writer — and
 * all three terminal branches below would then answer for a daemon that is gone: a stale
 * `connected` returns success with no live link, a stale `unauthorized`/`blocked` throws a
 * rejection that may be long over. Suppressing the dead writer's record settles all three
 * at once, and leaves the loop seeing nothing — which is exactly the state of a join that
 * has not happened yet, so it keeps waiting for the real daemon until the deadline. */
export async function waitForDaemonEnrollment(
  opts: {
    timeoutMs?: number
    pollMs?: number
    now?: () => number
    sleep?: (ms: number) => Promise<void>
  } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? JOIN_CONNECT_TIMEOUT_MS
  const pollMs = opts.pollMs ?? JOIN_CONNECT_POLL_MS
  const now = opts.now ?? Date.now
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const deadline = now() + timeoutMs
  let lastError: string | undefined
  while (now() < deadline) {
    // `.status` only: whether the fence could VERIFY the writer's identity does
    // not change what a join should do. A record it let through is the best fact
    // available, and one it suppressed leaves the loop with nothing — which is
    // exactly the state of a join that has not happened yet, so it keeps polling
    // (POD-3826, POD-3837).
    const status = readLiveConnectivity()?.status
    if (status?.state === 'connected') return
    if (status?.state === 'unauthorized') {
      throw new Error(
        `daemon was rejected by the server (${status.authorizationReason ?? 'auth-failed'})`,
      )
    }
    if (status?.state === 'blocked') {
      throw new Error(
        `daemon was blocked by the server (${status.blockedReason ?? 'unknown reason'})`,
      )
    }
    lastError = status?.lastError ?? lastError
    await sleep(pollMs)
  }
  throw new Error(
    `daemon did not connect within ${Math.ceil(timeoutMs / 1_000)} seconds${
      lastError ? ` (${lastError})` : ''
    }`,
  )
}

/** Default backend starter: systemd install (with detached fallback) or a detached spawn. Works
 *  for host modes (start the server + daemon split) AND a joined worker (start just the daemon).
 *  Exported as THE one start-backend engine (issue #20) — interactive setup, the
 *  non-interactive `podium setup --join`, and the pending-persistence reconcile all share it. */
export async function startBackendEngine(opts: StartBackendOpts): Promise<StartBackendResult> {
  const { persistence, mode, port } = opts
  const { startDetachedStack } = await import('./cli-spawn')
  // Tear down any previously-running backend first, so switching modes (or reconfiguring) never
  // leaves the old server/daemon running alongside the new one. No-op on a fresh box.
  const { stopBackend } = await import('./cli-lifecycle')
  await stopBackend()
  // A stale connected/refused record belongs to a previous attempt and cannot prove this one.
  // Clear it only after the previous backend has stopped, then let the new daemon be the writer.
  if (mode === 'daemon') rmSync(connectivityPath(), { force: true })
  const what = mode === 'daemon' ? 'daemon' : 'server + daemon'
  let result: StartBackendResult
  if (persistence === 'systemd') {
    const { installSystemd } = await import('./cli-systemd')
    const res = installSystemd(mode, port)
    if (res.ok) {
      result = {
        effectivePersistence: 'systemd',
        message: res.lingerRemedy
          ? `Installed + started the ${what} as a systemd service, but it stops when you log out ` +
            `and does not come back after a reboot. ${res.lingerRemedy}`
          : `Installed + started the ${what} as a systemd service — survives reboot.`,
      }
    } else {
      const { serverUp } = await startDetachedStack(mode, port, loadConfig().bindHost)
      // Not an error the operator has to act on: the ${what} IS running. Say what we could not do,
      // what we did instead, and the one consequence that matters (it won't come back on reboot).
      const lines = [
        `Could not install a systemd service — ${res.reason}.`,
        `Started the ${what} detached instead: working now, but it will not come back after a reboot.`,
      ]
      if (!serverUp) lines.push('It did not come up, though — check ~/.podium/logs/.')
      if (res.remedy) lines.push(res.remedy)
      result = { effectivePersistence: 'detached', message: lines.join('\n') }
    }
  } else {
    const { serverUp } = await startDetachedStack(mode, port, loadConfig().bindHost)
    result = {
      effectivePersistence: 'detached',
      message: serverUp
        ? `Started the ${what} (detached) — runs until reboot. Use \`podium status\` / \`podium stop\` to manage.`
        : 'Did not come up — check ~/.podium/logs/.',
    }
  }
  return result
}

/**
 * Whether `podium setup` / `--reconfigure` should launch the interactive terminal flow.
 * It's THE interactive command (nothing invokes it headless), so the only guard is a TTY:
 * without a terminal the prompts would hang, so we fall through to serving the web UI. The
 * menu lets you switch into ANY mode, so it's offered regardless of the current mode.
 */
export function shouldRunCliSetup(opts: {
  forceSetup: boolean
  firstRunNeedsSetup: boolean
  isTTY: boolean
}): boolean {
  // Interactive only (a TTY): headless/systemd/piped runs must never block on a prompt —
  // they fall through to serving the web setup URL. Trusted local launchers apply their default
  // before this decision, so firstRunNeedsSetup is already false for that path.
  return (opts.forceSetup || opts.firstRunNeedsSetup) && opts.isTTY
}

type HostMode = 'all-in-one' | 'server'
/** What the mode menu can return. The three modes, plus the host-only quick edits. */
type SetupChoice = HostMode | 'daemon' | 'url' | 'password'

/**
 * WHAT THE DEPLOYMENT OWNS, THIS COMMAND MAY NOT WRITE (PDM-26).
 *
 * Printed and refused UP FRONT rather than at the write: the setup flow asks a
 * string of questions before it saves anything, and letting an operator answer
 * all of them only to be told the answer cannot be kept is the worst version of
 * this refusal. Returns false when the flow must not proceed.
 */
function deploymentOwns(io: SetupIO, what: 'mode' | 'publicUrl'): boolean {
  try {
    if (what === 'mode') assertModeWritable()
    else assertPublicUrlWritable()
    return false
  } catch (e) {
    io.error((e as Error).message)
    return true
  }
}

/**
 * REPLACING A LIVE PUBLIC URL IS A DECISION, not a step (PDM-26).
 *
 * The old URL is already inside every join token issued and every paired
 * device's record, and none of them can be told about the new one. In a terminal
 * the honest way to ask is to ask — `--confirm-url-change` answers it ahead of
 * time for a scripted run.
 */
async function confirmUrlChange(
  io: SetupIO,
  next: string,
  preConfirmed: boolean,
): Promise<boolean> {
  const current = loadConfig().publicUrl
  if (!current || current === next) return true
  // A quick-tunnel address was always going to change; replacing it strands nothing new.
  if (next === MANAGED_TUNNEL_TARGET && ephemeralTunnelWarning(current)) return true
  if (preConfirmed) return true
  io.warn(
    `This instance is already reachable at ${current}.\n` +
      'Changing it strands every machine that joined at the old URL — they will not\n' +
      'be told about the new one and will have to be pointed at it by hand.',
  )
  // Deliberately a typed word rather than a confirm: this is destructive in a way no other
  // answer in the flow is, and `--confirm-url-change` exists precisely because it is heavy.
  const answer = await io.text({
    message: `Type CHANGE to replace it with ${next}`,
    validate: (v) =>
      v.trim() === 'CHANGE' || v.trim() === ''
        ? undefined
        : 'Type CHANGE, or leave blank to keep the current URL.',
  })
  if (!isCancel(answer) && answer.trim() === 'CHANGE') return true
  io.step('Left the URL as it was.')
  return false
}

type ReachabilityChoice =
  | { publicUrl: string; networkOption: NetworkOption; managedTunnel?: false }
  /** Podium runs the quick tunnel, so the URL is not known until the server is up. */
  | { networkOption: 'cloudflare-tunnel'; managedTunnel: true }

/**
 * THE ONE-CLICK OPTION. The Cloudflare quick tunnel is the only way to be reachable that
 * needs no account and no sign-in, so it is the one Podium can run end to end: fetch
 * cloudflared when it is missing, keep it running under podium-tunnel, and record each
 * new address so joined machines can look it up. The label says Podium runs it, because
 * that is the difference from every other row.
 */
/** What {@link confirmUrlChange} names as the replacement when the URL is not known yet. */
const MANAGED_TUNNEL_TARGET = 'a Cloudflare quick tunnel'
const MANAGED_TUNNEL_LABEL = 'Cloudflare quick tunnel, managed by Podium (easiest, no account)'
const MANAGED_TUNNEL_NOTE =
  'One-click setup, with nothing to install or sign up for. Cloudflare gives no uptime guarantee for quick tunnels.'

/**
 * Get cloudflared onto this machine for the managed tunnel, asking first. False means the
 * managed tunnel cannot go ahead and the operator has been told why.
 */
async function ensureCloudflared(io: SetupIO, tunnel: ManagedTunnelDeps): Promise<boolean> {
  if (tunnel.hasCloudflared()) return true
  const tool = networkOptionTool('cloudflare-tunnel')
  const fetchIt = await io.confirm({
    message: `cloudflared is not installed. Download it now? (Cloudflare's own build, into ${bundledCloudflaredPath()})`,
    initialValue: true,
  })
  if (isCancel(fetchIt) || !fetchIt) {
    if (tool?.install) io.command(tool.install, 'Install it yourself, then re-run `podium setup`:')
    return false
  }
  const spin = io.spinner()
  spin.start('Downloading cloudflared')
  try {
    const path = await tunnel.download()
    spin.stop(`Downloaded cloudflared to ${path}.`)
    return true
  } catch (e) {
    spin.error(`Could not download cloudflared: ${(e as Error).message}`)
    if (tool?.install) io.command(tool.install, 'Install it yourself, then re-run `podium setup`:')
    return false
  }
}

/**
 * Start the managed tunnel and wait for its first address. Runs once the server is up,
 * because podium-tunnel hands each address to the running server.
 */
async function startManagedTunnel(
  io: SetupIO,
  tunnel: ManagedTunnelDeps,
  previous: string | undefined,
): Promise<string | undefined> {
  const enabled = tunnel.enable()
  if (!enabled.ok) {
    io.error(`Could not start the tunnel: ${enabled.reason}`)
    return undefined
  }
  const spin = io.spinner()
  spin.start('Starting the Cloudflare tunnel (can take a minute)')
  const url = await tunnel.waitForUrl(previous)
  if (!url) {
    spin.error('The tunnel has not reported an address yet.')
    io.command(`journalctl --user -u ${enabled.unit} -f`, 'See what it is doing:')
    io.step('Podium records the address as soon as the tunnel reports one.')
    return undefined
  }
  spin.stop(`The Cloudflare tunnel is up at ${url}`)
  // ONE paragraph per line: clack wraps note text to the terminal itself, so a line broken
  // by hand here gets broken twice and reads ragged.
  io.note(
    [
      'The address changes whenever the tunnel restarts, for example after a reboot or a dropped connection.',
      'Podium records each new address, and machines joined to this server follow it on their own.',
      'The browser and the desktop and mobile apps do not follow it yet: `podium status` shows the current address.',
    ].join('\n'),
    'About this address',
  )
  return url
}

/**
 * Show what the operator has to run — and, when the tool that command needs is NOT on this
 * machine, how to get it first.
 *
 * The flow used to print `tailscale funnel 18787` whether or not tailscale existed here, so
 * on a bare box the very next instruction was a command that answers `command not found`.
 * The install lines come FIRST and the reachability command after, because that is the order
 * they have to be run in.
 */
function presentReachabilityCommand(
  io: SetupIO,
  opt: NetworkOption,
  port: number,
  hasCommand: (binary: string) => boolean,
): void {
  const { command } = networkOptionCommand(opt, port)
  const tool = networkOptionTool(opt)
  const installed = tool === undefined || hasCommand(tool.binary)
  if (tool && !installed) {
    // ONE box, not one per line: four stacked boxes is the same information at four times
    // the visual weight, and `command()` already keeps each line separately selectable.
    // The docs URL is not a command, so it stays in the sentence.
    io.warn(
      `\`${tool.binary}\` is not installed on this machine.\n` +
        `Other ways to install it: ${tool.docs}`,
    )
    const steps = [tool.install, tool.signIn].filter((s): s is string => s !== undefined)
    if (steps.length > 0) {
      io.command(
        steps.join('\n'),
        tool.signIn ? `Install ${tool.binary} and sign in:` : `Install ${tool.binary}:`,
      )
    }
  }
  // The one thing on this screen the operator must COPY gets a box of its own.
  if (command) {
    io.command(command, installed ? 'Run this, then come back:' : 'Then run this and come back:')
  }
}

/** The rows of the reachability menu. Tailscale is ONE row with a nested choice. */
type ReachabilityRow = 'tailscale' | 'cloudflare-tunnel' | 'manual'

/**
 * What a reverse proxy has to do for Podium — said as requirements, not as one proxy's
 * config, because the operator who picks this row already runs a proxy of their own.
 * "On this machine" is load-bearing: the server binds 127.0.0.1 and trusts exactly one
 * proxy hop's X-Forwarded-Proto there (resolveTrustedProxyHops), so a proxy elsewhere
 * cannot reach it and its HTTPS would not be believed.
 */
export function manualProxyRequirements(port: number): string {
  return [
    'Your reverse proxy needs to:',
    '',
    '• serve Podium over HTTPS, with a valid certificate, at the root of its own hostname (no path prefix)',
    `• run on this machine and forward everything to http://127.0.0.1:${port}`,
    '• pass WebSocket upgrades through, on every path, and not time out long-lived connections',
    '• send X-Forwarded-Proto: https',
  ].join('\n')
}

/**
 * Reachability step: pick how this machine is reached, and get its https URL. Returns the
 * URL and exposure method, or undefined when the operator gave up. With `save` (the
 * standalone "change the URL" edit on a running box) it persists immediately; the full
 * host flow passes save:false and writes config ONCE at the end — so a Ctrl-C midway
 * can't leave a configured-looking-but-passwordless box (issue #21).
 *
 * Whether the URL actually works is checked AFTER the server is up ({@link verifyReachable}):
 * on a fresh box there is nothing yet to answer an outside probe, which is why the check
 * used to be skipped there without a word.
 *
 * THERE IS NO WAY BACK from here, deliberately. clack has no back of its own — its action
 * vocabulary is fixed and `escape` is aliased to `cancel` — and an invented one read as
 * noise. One clear way out (Ctrl-C, nothing saved, re-run `podium setup`) beats two
 * unclear ones.
 */
async function reachabilityStep(
  io: SetupIO,
  port: number,
  mode: HostMode,
  opts: {
    save: boolean
    confirmUrlChange?: boolean
    hasCommand?: (binary: string) => boolean
    managedTunnel?: Partial<ManagedTunnelDeps>
    tailscale?: Partial<TailscaleDeps>
  } = { save: true },
): Promise<ReachabilityChoice | undefined> {
  const hasCommand = opts.hasCommand ?? commandExists
  const row = await io.select<ReachabilityRow>({
    message: 'How can clients reach this machine over the network?',
    options: [
      {
        value: 'tailscale',
        label: 'Tailscale (recommended)',
        hint: 'A real HTTPS address with no domain and no open ports — public, or private to your tailnet.',
      },
      { value: 'cloudflare-tunnel', label: MANAGED_TUNNEL_LABEL, hint: MANAGED_TUNNEL_NOTE },
      {
        value: 'manual',
        label: 'My own reverse proxy',
        hint: 'You make sure clients can reach Podium on this machine over HTTPS.',
      },
    ],
  })
  if (isCancel(row) || !row) return undefined

  if (row === 'tailscale') {
    const exposure = await io.select<'tailscale-funnel' | 'tailscale-serve'>({
      message: 'Who should be able to reach it?',
      options: [
        {
          value: 'tailscale-funnel',
          label: 'Anyone with the link (Tailscale Funnel)',
          hint: 'Public. Phones and laptops need nothing installed.',
        },
        {
          value: 'tailscale-serve',
          label: 'Only devices on my tailnet (Tailscale Serve)',
          hint: 'Private. Every device you use Podium from needs Tailscale, signed in.',
        },
      ],
    })
    if (isCancel(exposure) || !exposure) return undefined
    const url = await tailscaleStep(
      io,
      exposure === 'tailscale-funnel' ? 'funnel' : 'serve',
      port,
      { ...realTailscaleDeps, ...opts.tailscale },
    )
    if (!url) {
      io.step('Nothing saved. Re-run `podium setup` when ready.')
      return undefined
    }
    return finishUrl(io, mode, url, exposure, opts)
  }

  if (row === 'cloudflare-tunnel') {
    const tunnel = managedTunnelDeps(hasCommand, opts.managedTunnel)
    if (tunnel.canSupervise()) {
      if (!(await ensureCloudflared(io, tunnel))) {
        io.step('Nothing saved. Re-run `podium setup` when ready.')
        return undefined
      }
      if (!opts.save) return { networkOption: 'cloudflare-tunnel', managedTunnel: true }
      const previous = loadConfig().publicUrl
      if (!(await confirmUrlChange(io, MANAGED_TUNNEL_TARGET, opts.confirmUrlChange === true)))
        return undefined
      const { publicUrl: _replaced, ...rest } = loadConfig()
      saveConfig({ ...rest, mode, networkOption: 'cloudflare-tunnel' })
      const url = await startManagedTunnel(io, tunnel, previous)
      return url
        ? { publicUrl: url, networkOption: 'cloudflare-tunnel' }
        : { networkOption: 'cloudflare-tunnel', managedTunnel: true }
    }
    // No systemd user session to keep podium-tunnel alive: fall back to running
    // cloudflared by hand and pasting its URL, exactly as before the managed tunnel.
    io.warn(
      'This machine has no systemd user session, so Podium cannot keep the tunnel running.\n' +
        'Run cloudflared yourself instead.',
    )
    presentReachabilityCommand(io, 'cloudflare-tunnel', port, hasCommand)
  } else {
    io.note(manualProxyRequirements(port), 'Your reverse proxy')
  }

  const message =
    row === 'manual'
      ? 'The https:// URL your reverse proxy serves'
      : networkOptionCommand('cloudflare-tunnel', port).hint
  // Re-asked by the prompt itself until it validates; a cancel returns CANCEL.
  const pasted = await io.text({
    message,
    placeholder: 'https://…',
    validate: (v) =>
      v.trim() === ''
        ? 'Paste the URL, or press Ctrl-C to give up.'
        : validatePublicUrl(v).ok
          ? undefined
          : (validatePublicUrl(v) as { error: string }).error,
  })
  const v = isCancel(pasted) ? undefined : validatePublicUrl(pasted)
  if (!v?.ok) {
    io.step('No URL — nothing saved. Re-run `podium setup` when ready.')
    return undefined
  }
  return finishUrl(io, mode, v.normalized, row, opts)
}

/** Save (or announce) a URL the operator chose; shared by every row that yields one. */
async function finishUrl(
  io: SetupIO,
  mode: HostMode,
  normalized: string,
  networkOption: NetworkOption,
  opts: { save: boolean; confirmUrlChange?: boolean },
): Promise<ReachabilityChoice | undefined> {
  if (opts.save) {
    if (!(await confirmUrlChange(io, normalized, opts.confirmUrlChange === true))) {
      return undefined
    }
    saveConfig({ ...loadConfig(), mode, publicUrl: normalized, networkOption })
    io.success(`Saved. This instance is reachable at ${normalized}.`)
  } else {
    io.step(`This instance will be reachable at ${normalized}.`)
  }
  const warning = ephemeralTunnelWarning(normalized)
  if (warning) io.warn(warning)
  return { publicUrl: normalized, networkOption }
}

/** How a URL is proven to work: from the internet, or — for a tailnet-only one — from here. */
export interface ReachabilityChecks {
  /** Ask Podium Connect to probe the URL from the outside. `undefined` = could not ask. */
  outside: (url: string) => Promise<CheckResult | undefined>
  /** Fetch the URL's `/version` from this machine (through the tailnet, or Cloudflare). */
  inside: (url: string) => Promise<boolean>
}

/**
 * Fetch `/version` from this machine, retrying for up to `budgetMs`. A brand-new address
 * can take a while to answer — a quick tunnel's name once took over 15 s to reach both of
 * Cloudflare's nameservers, and a lookup in that window is cached as "no such name" for a
 * minute — so one miss right after it appears is not a verdict.
 */
async function realInsideCheck(url: string, budgetMs = 90_000): Promise<boolean> {
  const deadline = Date.now() + budgetMs
  for (;;) {
    try {
      const res = await fetch(`${url.replace(/\/$/, '')}/version`, {
        signal: AbortSignal.timeout(10_000),
      })
      if (res.ok) return true
    } catch {
      // Not answering yet — try again until the budget is spent.
    }
    if (Date.now() + 5_000 >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 5_000))
  }
}

/**
 * THE REACHABILITY CHECK, AFTER THE SERVER IS UP (POD-4534, moved by POD-3274). A failure
 * informs; the human decides: keep the URL (it may be meant for the inside only), or set
 * up a different way. Tailscale Serve is private by design, so it is checked from this
 * machine through the tailnet instead of from the internet, where it always fails.
 */
async function verifyReachable(
  io: SetupIO,
  url: string,
  networkOption: NetworkOption,
  checks: ReachabilityChecks,
): Promise<'ok' | 'keep' | 'change'> {
  // Checked from THIS machine: Serve because it is private, so an outside probe always
  // fails; the Cloudflare tunnel because Connect's probe (a Cloudflare Worker) could not
  // connect to trycloudflare.com addresses that answered everywhere else — measured on the
  // lab, 2026-10-06. Either way the request leaves through the same path a client takes.
  const via =
    networkOption === 'tailscale-serve'
      ? 'your tailnet'
      : networkOption === 'cloudflare-tunnel'
        ? 'Cloudflare'
        : undefined
  if (via) {
    const spin = io.spinner()
    spin.start(`Checking the address from this machine, through ${via} (can take a minute)`)
    if (await checks.inside(url)) {
      spin.stop(`Reachable — ${url} answers through ${via}.`)
      return 'ok'
    }
    spin.error(`${url} did not answer from this machine through ${via}.`)
  } else {
    const verdict = await checks.outside(url)
    if (verdict === undefined || (!verdict.ok && verdict.error === 'CONNECT_UNAVAILABLE')) {
      io.step('Could not run the outside reachability check right now; skipped it.')
      return 'ok'
    }
    if (verdict.ok) {
      io.success(`Reachable — an outside probe connected to ${url}.`)
      return 'ok'
    }
    const detail = typeof verdict.detail === 'string' ? verdict.detail.trim() : ''
    // The cloud's answer arrives as a cast and may know codes this CLI predates: an
    // unknown code names itself rather than crashing setup.
    const sentence =
      (CHECK_ERROR_SENTENCES as Partial<Record<string, string>>)[verdict.error] ??
      `The outside probe reported a problem it described as ${verdict.error}.`
    io.warn(detail ? `${sentence} The probe reported: ${detail}` : sentence)
  }
  const next = await io.select<'keep' | 'change'>({
    message: 'What now?',
    options: [
      {
        value: 'keep',
        label: 'Keep this address',
        hint: 'It may only be reachable inside my network, or will be once I finish setting it up.',
      },
      { value: 'change', label: 'Set up a different way to reach this machine' },
    ],
  })
  return isCancel(next) || next !== 'change' ? 'keep' : 'change'
}

/**
 * Check the URL now in config; on "change", walk the reachability step again (saving, the
 * server is running) and check what that produced, until it works or is kept.
 */
async function checkAndOfferChange(
  io: SetupIO,
  port: number,
  mode: HostMode,
  first: ReachabilityChoice,
  checks: ReachabilityChecks,
  stepOpts: {
    hasCommand?: (binary: string) => boolean
    managedTunnel?: Partial<ManagedTunnelDeps>
    tailscale?: Partial<TailscaleDeps>
  },
): Promise<void> {
  let choice: ReachabilityChoice | undefined = first
  while (choice && !choice.managedTunnel) {
    const outcome = await verifyReachable(io, choice.publicUrl, choice.networkOption, checks)
    if (outcome !== 'change') return
    // The URL just checked is the one being replaced, and it does not work: replacing
    // it strands nobody, so the "type CHANGE" question is answered.
    choice = await reachabilityStep(io, port, mode, {
      save: true,
      confirmUrlChange: true,
      ...stepOpts,
    })
  }
}

/**
 * Password step: a reachable instance should require login, so strongly encourage a
 * password. Blank = run open only after an explicit confirmation word — the CLI's
 * equivalent of the web flow's `acknowledgeNoPassword`. Returns false when neither a
 * password nor the explicit no-password ack was given, so the host flow ABORTS instead
 * of quietly configuring an open box (issue #21).
 */
async function passwordStep(
  io: SetupIO,
  setPassword: (password: string) => Promise<void>,
): Promise<boolean> {
  io.step(
    'Choose the password you will log in to Podium with: in the browser, and in the desktop and mobile apps.',
  )
  // Loops until the operator either sets a password or explicitly accepts an open box.
  // A cancel (Ctrl-C, or a scripted run out of answers) ends it — which is why there is no
  // attempt counter: CANCEL is the terminating condition readline could never report.
  for (;;) {
    const pw = await io.password({ message: 'Podium login password (leave blank for no login)' })
    if (isCancel(pw)) break
    if (pw.trim()) {
      await setPassword(pw.trim())
      io.success('Password set. The browser and the apps ask for it when they connect.')
      return true
    }
    // SP-7f2c: the no-password option must be an explicit opt-in behind a confirmed warning.
    io.warn('No password means anyone who can reach this URL can use this instance.')
    const open = await io.confirm({
      message: 'Run without a password?',
      initialValue: false,
    })
    if (isCancel(open)) break
    if (open) {
      io.warn('No password set — anyone who can reach this URL can use this instance.')
      return true
    }
    io.step('No-password mode was not confirmed.')
  }
  io.error('No password chosen and no-password mode not confirmed.')
  return false
}

/**
 * Persistence step: after the host is configured, ask whether to survive reboot (systemd) or
 * run detached, then actually start the backend (server + daemon as two processes) and record
 * the effective persistence in config.
 */
async function persistenceStep(
  io: SetupIO,
  port: number,
  mode: HostMode | 'daemon',
  startBackend: (opts: StartBackendOpts) => Promise<StartBackendResult>,
  options: { activateImmediately?: boolean } = {},
): Promise<StartBackendResult> {
  const answer = await io.confirm({
    message: 'Keep Podium running as a systemd service (survives reboot)?',
    initialValue: true,
  })
  // A cancel here must not silently pick the weaker option: default to the recommended
  // systemd path, exactly as a bare Enter did before.
  const wantSystemd = isCancel(answer) ? true : answer
  const requestedPersistence = wantSystemd ? 'systemd' : 'detached'
  // A new VPS must boot against its final config, otherwise `/readiness` correctly reports that
  // the server still needs a restart. Record the requested value before its first process starts.
  // If systemd is unavailable and the engine falls back, restart the detached stack once after
  // recording that effective value so the one-command onboarding path still finishes ready.
  if (options.activateImmediately) savePersistence(requestedPersistence)
  let res = await startBackend({ persistence: requestedPersistence, mode, port })
  savePersistence(res.effectivePersistence)
  if (options.activateImmediately && res.effectivePersistence !== requestedPersistence) {
    res = await startBackend({ persistence: res.effectivePersistence, mode, port })
    savePersistence(res.effectivePersistence)
  }
  io.step(res.message)
  return res
}

/**
 * Record the EFFECTIVE persistence — which is not always the one asked for:
 * `startBackendEngine` falls back to detached when systemd is unavailable, and
 * the config must say what actually happened.
 *
 * There is no separate intent to clear any more. v1 kept `pendingPersistence`
 * beside this field and this function deleted it; POD-333 folded the two into
 * one (see CONFIG_MIGRATIONS in @podium/runtime/config), so a write here is the
 * whole story.
 */
function savePersistence(persistence: 'systemd' | 'detached'): void {
  saveConfig({ ...loadConfig(), persistence })
}

/**
 * Non-interactive join (issue #20): `podium setup --join <token> --persist systemd|detached`.
 * Applies the join token (PATCHING config — updateChannel etc. survive) and starts/persists
 * the daemon through the SAME engine the interactive flow uses. `install.sh --join` delegates
 * here instead of hand-writing a drifting unit file.
 */
export async function runJoinSetup(
  token: string,
  persistence: 'systemd' | 'detached',
  port: number,
  deps: SetupDeps = {},
): Promise<{ name: string; warning?: string; result: StartBackendResult }> {
  const startBackend = deps.startBackend ?? startBackendEngine
  const waitForEnrollment = deps.waitForEnrollment ?? waitForDaemonEnrollment
  const { name, warning } = await applyJoinToken(token)
  const result = await startBackend({ persistence, mode: 'daemon', port })
  savePersistence(result.effectivePersistence)
  await waitForEnrollment()
  return { name, ...(warning ? { warning } : {}), result }
}

/** The checks the flow runs once the server is up: the injected ones, or the real ones. */
function reachabilityChecks(
  io: SetupIO,
  options: {
    checkReachability?: (url: string) => Promise<CheckResult | undefined>
    checkInside?: (url: string) => Promise<boolean>
  },
): ReachabilityChecks {
  return {
    outside:
      options.checkReachability ??
      // The identity is minted by the server's first boot, which just happened.
      ((url) => realCheckReachability(url, io, { waitForIdentityMs: 20_000 })),
    inside: options.checkInside ?? realInsideCheck,
  }
}

/**
 * Choose a host mode → collect its URL, then its password, and only THEN write config —
 * atomically at the end of the decision flow (issue #21). A Ctrl-C/EOF before the password
 * choice leaves the box exactly as unconfigured as before, instead of a saved mode+URL
 * with no password (which looked configured AND was open to anyone who could reach it).
 */
async function hostStep(
  io: SetupIO,
  port: number,
  mode: HostMode,
  setPassword: (password: string) => Promise<void>,
  startBackend: (opts: StartBackendOpts) => Promise<StartBackendResult>,
  options: {
    activateImmediately?: boolean
    /** `--confirm-url-change`: answer the "this strands joined machines" question ahead of time. */
    confirmUrlChange?: boolean
    hasCommand?: (binary: string) => boolean
    checkReachability?: (url: string) => Promise<CheckResult | undefined>
    checkInside?: (url: string) => Promise<boolean>
    managedTunnel?: Partial<ManagedTunnelDeps>
    tailscale?: Partial<TailscaleDeps>
  } = {},
): Promise<void> {
  if (deploymentOwns(io, 'mode') || deploymentOwns(io, 'publicUrl')) return
  const stepOpts = {
    ...(options.hasCommand ? { hasCommand: options.hasCommand } : {}),
    ...(options.managedTunnel ? { managedTunnel: options.managedTunnel } : {}),
    ...(options.tailscale ? { tailscale: options.tailscale } : {}),
  }
  const reachability = await reachabilityStep(io, port, mode, { save: false, ...stepOpts })
  if (!reachability) return
  const nextUrl = reachability.managedTunnel ? MANAGED_TUNNEL_TARGET : reachability.publicUrl
  if (!(await confirmUrlChange(io, nextUrl, options.confirmUrlChange === true))) return
  if (!(await passwordStep(io, setPassword))) {
    io.error('Nothing saved — re-run `podium setup` to start over.')
    return
  }
  const supervisor = loadSupervisorState(stateDir())
  if (!supervisor.enrolledPublicKey && !supervisor.token)
    prepareSetupEnrollment(mode === 'all-in-one', true)
  const previousUrl = loadConfig().publicUrl
  if (reachability.managedTunnel) {
    // No URL yet: the tunnel has not started. The server records it when it does.
    const { publicUrl: _replaced, ...rest } = loadConfig()
    saveConfig({ ...rest, mode, networkOption: reachability.networkOption })
    io.success('Saved.')
  } else {
    const { publicUrl, networkOption } = reachability
    saveConfig({ ...loadConfig(), mode, publicUrl, networkOption })
    io.success(`Saved. This instance is reachable at ${publicUrl}.`)
  }
  await persistenceStep(io, port, mode, startBackend, {
    activateImmediately: options.activateImmediately,
  })
  let established: ReachabilityChoice | undefined = reachability
  if (reachability.managedTunnel) {
    const url = await startManagedTunnel(
      io,
      managedTunnelDeps(options.hasCommand ?? commandExists, options.managedTunnel),
      previousUrl,
    )
    established = url ? { publicUrl: url, networkOption: 'cloudflare-tunnel' } : undefined
  }
  // The server is up now, so the URL can be proven (or not) for real.
  if (established) {
    await checkAndOfferChange(
      io,
      port,
      mode,
      established,
      reachabilityChecks(io, options),
      stepOpts,
    )
  }
}

/**
 * Fresh-VPS setup used by desktop onboarding. This is intentionally NOT the reconfiguration menu:
 * the machine is a new all-in-one Podium authority, so topology is already decided. Reachability,
 * login protection, and persistence remain because they are required for a safe usable server.
 */
export async function runVpsSetup(io: SetupIO, port: number, deps: SetupDeps = {}): Promise<void> {
  const inspection = inspectConfig()
  if (inspection.state === 'corrupt') {
    io.error(
      `Your config file (${configPath()}) exists but is invalid: ${inspection.error}\n` +
        'Refusing to set up over it. Fix the file, or run `podium setup --repair`.',
    )
    return
  }
  io.intro('Set up this VPS as your always-on Podium')
  await hostStep(
    io,
    port,
    'all-in-one',
    deps.setPassword ?? realSetPassword,
    deps.startBackend ?? startBackendEngine,
    {
      activateImmediately: true,
      ...(deps.hasCommand ? { hasCommand: deps.hasCommand } : {}),
      ...(deps.checkReachability ? { checkReachability: deps.checkReachability } : {}),
      ...(deps.checkInside ? { checkInside: deps.checkInside } : {}),
      ...(deps.managedTunnel ? { managedTunnel: deps.managedTunnel } : {}),
      ...(deps.tailscale ? { tailscale: deps.tailscale } : {}),
    },
  )
}

/** Daemon mode: paste the one-line join code (it carries the server URL + pairing code), then
 *  start the daemon (persistence choice) — same as the host path, so the user never has to
 *  manually restart. */
async function joinStep(
  io: SetupIO,
  port: number,
  startBackend: (opts: StartBackendOpts) => Promise<StartBackendResult>,
  waitForEnrollment: () => Promise<void>,
): Promise<void> {
  io.note('Find it on the server, under Machines \u2192 Add machine.', 'Paste the join code')
  // Validated in the prompt, so a typo is corrected in place rather than restarting the step.
  const token = await io.text({
    message: 'Join code',
    validate: (v) => {
      if (v.trim() === '') return 'Paste the join code, or press Ctrl-C to cancel.'
      try {
        decodeJoin(v.trim())
        return undefined
      } catch (e) {
        return (e as Error).message
      }
    },
  })
  if (isCancel(token)) {
    io.step('Cancelled.')
    return
  }
  try {
    const { name, warning } = await applyJoinToken(token.trim())
    if (warning) io.warn(warning)
    await persistenceStep(io, port, 'daemon', startBackend)
    const spin = io.spinner()
    spin.start('Waiting for the server to accept this machine')
    try {
      await waitForEnrollment()
      spin.stop(`Joined as "${name}".`)
    } catch (e) {
      spin.error((e as Error).message)
      throw e
    }
  } catch (e) {
    io.error((e as Error).message)
  }
}

/**
 * `podium setup` — the terminal counterpart to the web setup screen. A mode-first menu:
 * host a server here (all-in-one), host the relay only (server), or join a server as a
 * worker (daemon, paste a join code). It runs the same first-run and as a reconfigure, so
 * you can switch mode after the fact; when this box already hosts a server it also offers
 * quick edits (change the URL / change the password) without re-walking the whole flow.
 * (`client` mode isn't here — it's a desktop-app convenience; on a server box you just
 * open the URL in a browser.)
 */
/**
 * `podium setup --repair` (issue #21): an existing-but-invalid config.json is backed up
 * (never deleted) so setup can start fresh without silently destroying operator state.
 * Valid or missing configs are left untouched.
 */
export function repairConfig(): {
  state: 'ok' | 'missing' | 'repaired'
  backupPath?: string
  error?: string
} {
  const res = inspectConfig()
  if (res.state === 'ok') return { state: 'ok' }
  if (res.state === 'missing') return { state: 'missing' }
  const backupPath = `${configPath()}.invalid-${new Date().toISOString().replace(/[:.]/g, '-')}`
  renameSync(configPath(), backupPath)
  // This process just moved the live config away without writing to it, so the
  // loader's entry for that path describes a file that is no longer there.
  forgetConfig()
  return { state: 'repaired', backupPath, ...(res.error ? { error: res.error } : {}) }
}

export async function runCliSetup(io: SetupIO, port: number, deps: SetupDeps = {}): Promise<void> {
  // A corrupt config would make every apply step throw mid-flow (they refuse destructive
  // writes over an existing-but-invalid file, #21) — surface the repair path up front.
  const inspection = inspectConfig()
  if (inspection.state === 'corrupt') {
    io.error(
      `Your config file (${configPath()}) exists but is invalid: ${inspection.error}\n` +
        'Refusing to set up over it. Fix the file, or run `podium setup --repair` to\n' +
        'back it up and start fresh.',
    )
    return
  }
  const setPassword = deps.setPassword ?? realSetPassword
  const startBackend = deps.startBackend ?? startBackendEngine
  const waitForEnrollment = deps.waitForEnrollment ?? waitForDaemonEnrollment
  const mode = loadConfig().mode
  const hostsServer = mode === 'all-in-one' || mode === 'server'

  const menu: { value: SetupChoice; label: string; hint: string }[] = [
    {
      value: 'all-in-one',
      label: 'Run the Podium server AND agents here. (Recommended)',
      hint: 'It will serve the web frontend and let our native desktop and mobile apps connect to it.',
    },
    {
      value: 'daemon',
      label: 'Connect to an existing Podium server.',
      hint: 'You want to run agents on this machine.',
    },
    {
      value: 'server',
      label: 'Run ONLY the Podium server and NO agents here.',
      hint: 'You will need to set up an additional machine that will host your agents.',
    },
  ]
  if (hostsServer) {
    menu.push(
      { value: 'url', label: 'Change how this machine is reached (its URL)', hint: '' },
      { value: 'password', label: 'Change or remove the login password', hint: '' },
    )
  }

  const choice = await io.select({
    message: 'What do you want this machine to do?',
    options: menu.map((m) => ({
      value: m.value,
      label: m.label,
      ...(m.hint ? { hint: m.hint } : {}),
    })),
  })

  const hostOptions = {
    ...(deps.hasCommand ? { hasCommand: deps.hasCommand } : {}),
    ...(deps.confirmUrlChange ? { confirmUrlChange: true } : {}),
    ...(deps.activateImmediately ? { activateImmediately: true } : {}),
    ...(deps.checkReachability ? { checkReachability: deps.checkReachability } : {}),
    ...(deps.checkInside ? { checkInside: deps.checkInside } : {}),
    ...(deps.managedTunnel ? { managedTunnel: deps.managedTunnel } : {}),
    ...(deps.tailscale ? { tailscale: deps.tailscale } : {}),
  }
  if (choice === 'all-in-one') {
    await hostStep(io, port, 'all-in-one', setPassword, startBackend, hostOptions)
  } else if (choice === 'server') {
    await hostStep(io, port, 'server', setPassword, startBackend, hostOptions)
  } else if (choice === 'daemon') {
    if (deploymentOwns(io, 'mode')) return
    await joinStep(io, port, startBackend, waitForEnrollment)
  } else if (choice === 'url' && hostsServer) {
    if (deploymentOwns(io, 'publicUrl')) return
    const hostMode = mode === 'server' ? 'server' : 'all-in-one'
    const stepOpts = {
      ...(deps.hasCommand ? { hasCommand: deps.hasCommand } : {}),
      ...(deps.managedTunnel ? { managedTunnel: deps.managedTunnel } : {}),
      ...(deps.tailscale ? { tailscale: deps.tailscale } : {}),
    }
    const changed = await reachabilityStep(io, port, hostMode, {
      save: true,
      ...(deps.confirmUrlChange ? { confirmUrlChange: true } : {}),
      ...stepOpts,
    })
    // This box already runs its server, so the new URL can be checked at once.
    if (changed) {
      await checkAndOfferChange(
        io,
        port,
        hostMode,
        changed,
        reachabilityChecks(io, hostOptions),
        stepOpts,
      )
    }
  } else if (choice === 'password' && hostsServer) {
    await passwordStep(io, setPassword)
  } else {
    io.step('Nothing changed.')
  }
}

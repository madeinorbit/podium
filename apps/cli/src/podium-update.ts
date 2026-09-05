/**
 * Explicit CLI consent resolves one exact signed target and submits it to the
 * machine supervisor. Legacy installations without a parent use the same executor
 * as a one-shot supervisor and retain their manual-restart exit-code contract.
 * Download, verification, staging, activation and recovery live in runtime.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { compareVersions, isProvablyNewer, platformTargetFor } from '@podium/protocol'
import { resolveInstallDir, resolveUpdateTarget } from '@podium/runtime/config'
import { instanceServiceName, resolveInstanceId } from '@podium/runtime/instance'
import { PODIUM_UPDATE_PUBKEY } from '@podium/runtime/update-delivery'
import { MachineUpdateExecutor } from '@podium/runtime/machine-update'
import {
  createHeadlessMachineUpdateAdapter,
  installedArtifactDigest,
} from '@podium/runtime/machine-update-headless'
import { requestMachineUpdate } from '@podium/runtime/machine-update-control'
import { stateDir } from '@podium/runtime/config'

export type SystemctlExec = (command: string, args: string[]) => string

const execSystemctl: SystemctlExec = (command, args) =>
  execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })

/**
 * A schema-blocked janitor exits 78 and RestartPreventExitStatus deliberately
 * leaves it stopped. After a bundle catch-up, revive exactly that instance's
 * blocked unit; healthy, absent, and differently-failed units are untouched.
 * [spec:SP-c29e]
 *
 * LEGACY-ONLY since PDM-27: nothing writes a janitor unit any more (the janitor
 * is a thread inside the server, and a refusal there is reported as DEGRADED
 * rather than an exit), so this can only ever reach a unit an install carried in
 * from before the migration. On every other host the probe finds no such unit
 * and returns false. It goes when the migration window closes.
 */
export function reviveCompatibilityBlockedJanitor(
  instanceId: string = resolveInstanceId(),
  exec: SystemctlExec = execSystemctl,
): boolean {
  const unit = instanceServiceName('janitor', instanceId)
  try {
    const status = exec('systemctl', [
      '--user',
      'show',
      unit,
      '--property=ExecMainStatus',
      '--value',
    ]).trim()
    if (status !== '78') return false
    exec('systemctl', ['--user', 'reset-failed', unit])
    exec('systemctl', ['--user', 'start', unit])
    return true
  } catch {
    return false
  }
}

/**
 * Precedence between two versions, or `null` when either side is not a version
 * this can order.
 *
 * THE PARSER MOVED (POD-2221) to `@podium/protocol` — `update/version-order` —
 * because the daemon's schema gate needs the same ordering to tell an
 * unprovable step FORWARD from an unprovable step BACK, and two semver
 * comparisons in one update system is two answers waiting to disagree. Still
 * re-exported from here: this module's name is what the CLI's callers and tests
 * know it by.
 */
export { compareVersions }

/**
 * WHETHER TO SELF-UPDATE, for the UNATTACHED path only (POD-2099).
 *
 * This is the one place in Podium that asks "is there something newer" rather
 * than "am I running what I was told to run": with no server as authority,
 * `podium update` has only the feed's manifest to compare against, so an
 * ordering is unavoidable here. The attached daemon keeps target EQUALITY
 * (`planConvergence`), which is what makes a deliberate downgrade possible, and
 * this must not spread there.
 *
 * The old implementation was `Number()` per dot-separated segment. Podium's own
 * versions ARE prereleases — `0.1.4-edge.4` splits to `['0','1','4-edge','4']`,
 * `Number('4-edge')` is `NaN`, and `NaN !== NaN` is true, so the loop returned
 * `NaN > NaN` = false at the third segment. Every edge-to-edge comparison
 * answered "not newer", and an unattached edge install could never self-update.
 *
 * FAILS CLOSED. An unparseable version on either side is "not newer": the
 * consequence of a false negative is an install that stays put and says so,
 * while a false positive downloads and swaps an install directory on the
 * strength of a label nobody could read. A source checkout reporting `dev+<sha>`
 * takes this path, and staying put is the correct answer for it.
 */
export function isNewer(candidate: string, current: string): boolean {
  return isProvablyNewer(candidate, current)
}

/**
 * Map a Node/Bun (platform, arch) pair to the manifest's platform-asset key
 * (Tauri updater target triple prefix, e.g. 'linux-x86_64', 'darwin-aarch64').
 *
 * Delegates to the protocol's single derivation. This used to compute the string
 * itself, as did the development publisher and the release scripts — three copies of
 * the rule that decides which artifact a machine is offered.
 */
export function platformTarget(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  return platformTargetFor(platform, arch)
}

export function parseManifest(
  json: string,
  target = 'linux-x86_64',
): { version: string; url: string; signature: string } {
  const m = JSON.parse(json) as {
    version: string
    platforms: Record<string, { url: string; signature?: string }>
  }
  const plat = m.platforms[target]
  if (!plat?.url) throw new Error(`manifest has no ${target} artifact`)
  return { version: m.version, url: plat.url, signature: plat.signature ?? '' }
}

function installDir(): string {
  // The headless launcher (dist-bun/headless/podium) exports PODIUM_HOME=<its own dir>.
  return resolveInstallDir()
}

function currentVersion(dir: string): string {
  const f = join(dir, 'VERSION')
  return existsSync(f) ? readFileSync(f, 'utf8').trim() : 'dev'
}

const RELEASE_BASE = 'https://github.com/madeinorbit/podium/releases'

/**
 * Resolve the update manifest URL. With no `feedOverride`, this points at the channel's
 * static GitHub Releases asset (`stable` → the `latest` release, `edge` → the rolling
 * `edge` prerelease tag). A `feedOverride` keeps the LEGACY templated feed path
 * (`<feed>/update/<target>/x86_64/<cur>`) so the local fixture feed + E2E updater script
 * (which exercise the real download/verify/swap path) stay back-compatible.
 */
export function manifestUrlFor(
  channel: 'stable' | 'edge',
  ctx: { target: string; cur: string; feedOverride?: string },
): string {
  if (ctx.feedOverride) {
    return `${ctx.feedOverride.replace(/\/$/, '')}/update/${ctx.target}/x86_64/${ctx.cur}`
  }
  return channel === 'stable'
    ? `${RELEASE_BASE}/latest/download/podium-update.json`
    : `${RELEASE_BASE}/download/edge/podium-update.json`
}

export async function runUpdate(
  arg: string | { channel: 'stable' | 'edge'; feedOverride?: string },
  // Test seam only: lets the unit tests verify the real download→verify→swap path with an
  // ephemeral keypair on checkouts that don't have the (gitignored) dev signing key. The
  // CLI never passes this, so production installs always verify against the committed key.
  pubkeyB64: string = PODIUM_UPDATE_PUBKEY,
  reviveJanitor: () => boolean = reviveCompatibilityBlockedJanitor,
): Promise<void> {
  const { channel, feedOverride } =
    typeof arg === 'string' ? { channel: 'stable' as const, feedOverride: arg } : arg
  const dir = installDir()
  const cur = currentVersion(dir)
  const runningDigest = installedArtifactDigest(dir)
  // Resolve the platform asset to look for in the manifest: explicit env override
  // (config seam), else the running host's os/arch mapping.
  const target = resolveUpdateTarget(process.env, platformTarget())
  const manifestUrl = manifestUrlFor(channel, { target, cur, feedOverride })
  const res = await fetch(manifestUrl)
  if (!res.ok) {
    console.error(`[podium update] feed returned ${res.status}`)
    process.exitCode = 1
    return
  }
  const { version, url, signature } = parseManifest(await res.text(), target)
  if (!isNewer(version, cur)) {
    console.log(`[podium update] already up to date (${cur})`)
    return
  }
  if (!signature) {
    console.error('[podium update] artifact signature is missing; install unchanged')
    process.exitCode = 1
    return
  }
  console.log(`[podium update] updating ${cur} → ${version}`)
  const runtimeDir = join(stateDir(), 'runtime')
  const grant = {
    type: 'updateGrant' as const,
    grantId: `cli-${crypto.randomUUID()}`,
    issuedAt: Date.now(),
    target: {
      version,
      critical: false,
      trust: 'release' as const,
      artifacts: {
        headless: {
          delivery: 'feed' as const,
          platforms: {
            [target]: {
              url,
              signature,
              digest: `signature:${signature}`,
            },
          },
        },
      },
    },
  }
  if (existsSync(join(runtimeDir, 'machine-update-control.json'))) {
    await requestMachineUpdate(runtimeDir, '/grant', grant)
    console.log(`[podium update] supervisor accepted ${version}; use podium status for progress`)
    return
  }
  // An unconfigured legacy installation has no persistent parent yet. This
  // command is its one-shot supervisor, using exactly the same journal and
  // verified installer. Preserve its explicit manual-restart contract.
  const executor = new MachineUpdateExecutor({
    runtimeDir,
    adapter: createHeadlessMachineUpdateAdapter({
      installDir: dir,
      runningVersion: cur,
      runningDigest,
      caps: ['update.delivery.feed'],
      platform: target,
      pubkey: pubkeyB64,
      pinnedPubkey: () => undefined,
      restart: async () => 'handover-pending',
    }),
    report: (status) => {
      if (status.detail) console.error(`[podium update] ${status.detail}`)
    },
  })
  const prior = executor.snapshot()
  // A fresh legacy CLI can witness the previous manual installation. Confirm
  // only that exact committed artifact: general boot recovery can retry an
  // unresolved activation, which must still fence admission of this new target.
  if (
    prior &&
    (prior.phase === 'activating' || prior.phase === 'restarting') &&
    prior.prepared &&
    cur === prior.grant.target.version &&
    runningDigest === prior.prepared.digest
  ) {
    await executor.confirmBoot(true)
  }
  try {
    await executor.accept(grant)
  } catch (error) {
    // The CLI crash net logs escaped errors and survives. Admission refusal
    // must still be a failed one-shot command, with the committed journal intact.
    process.exitCode = 1
    throw error
  }
  const result = executor.snapshot()
  if (result?.phase !== 'restarting' && result?.phase !== 'current') {
    process.exitCode = 1
    if (result?.detail?.includes('signature verification')) return
    throw new Error(result?.detail ?? 'The supervisor could not install the update.')
  }
  console.log(`[podium update] updated to ${version}; restart podium to apply`)
  if (reviveJanitor()) console.log('[podium update] restarted compatibility-blocked janitor')
  process.exitCode = 10
}

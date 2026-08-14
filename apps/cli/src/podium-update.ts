/**
 * `podium update`: compare the installed headless bundle's VERSION to the feed manifest;
 * if newer, download the headless tarball, atomically swap the install dir, and message
 * the user to restart. The install dir is resolved from PODIUM_HOME (set by the launcher
 * shim) else dirname(process.execPath).
 *
 * Crash-safety: staging happens in a temp dir SIBLING to the install dir (same filesystem),
 * so the final swap rename is an atomic same-device operation (never EXDEV, even when /tmp is
 * tmpfs). The swap moves the old install to `<dir>.old` first; if the second rename fails, the
 * backup is rolled back into place so the install dir is never left missing.
 *
 * The manifest shape mirrors Tauri's updater "dynamic" endpoint response
 * ({ version, notes, pub_date, platforms: { '<os>-<arch>': { url, signature } } }), so a
 * single feed can serve both the desktop and headless channels.
 *
 * SECURITY: the headless path does its own version check AND verifies the manifest's
 * Ed25519 `signature` over the downloaded tarball bytes (against PODIUM_UPDATE_PUBKEY)
 * BEFORE extracting/swapping. A tampered or unsigned tarball is rejected and the install
 * is left untouched. (The desktop AppImage path uses a separate Tauri minisign keypair.)
 */
import { execFileSync } from 'node:child_process'
import { verify as cryptoVerify } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { resolveInstallDir, resolveUpdateTarget } from '@podium/runtime/config'
import { instanceServiceName, resolveInstanceId } from '@podium/runtime/instance'
import { PODIUM_UPDATE_PUBKEY } from '@podium/runtime/update-delivery'

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
 * A version this comparison can actually reason about: three numeric core
 * components plus semver's dotted prerelease identifiers. Build metadata
 * (`+<sha>`) is accepted and DISCARDED — semver §10 says it takes no part in
 * precedence, and two builds of one version are the same version here.
 */
interface ParsedVersion {
  core: readonly [number, number, number]
  prerelease: readonly (string | number)[]
}

const SEMVER =
  /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

const numericOrText = (id: string): string | number => (/^\d+$/.test(id) ? Number(id) : id)

/** `null` for anything that is not a semver — including the `dev+<sha>` and
 *  plain `dev` labels a source checkout carries, which have no ordering at all. */
function parseVersion(raw: string): ParsedVersion | null {
  const m = SEMVER.exec(raw.trim())
  if (!m) return null
  return {
    core: [Number(m[1]), Number(m[2]), Number(m[3])],
    prerelease: (m[4] ?? '').length === 0 ? [] : (m[4] as string).split('.').map(numericOrText),
  }
}

/**
 * Semver §11 precedence over the prerelease identifiers. The two rules that the
 * old dot-splitting comparison could not express, and that decide real Podium
 * versions:
 *
 * - **A release outranks its own prereleases.** `0.1.4` > `0.1.4-edge.4`, so an
 *   edge install stops offering itself the prerelease once the release lands.
 * - **Numeric identifiers compare NUMERICALLY.** `edge.10` > `edge.4`; compared
 *   as text it is the other way round, and edge would stall at `.9` forever.
 *
 * Mixed identifiers: numeric always ranks below alphanumeric, and a shorter set
 * of otherwise-equal identifiers ranks below a longer one.
 */
function comparePrerelease(
  a: readonly (string | number)[],
  b: readonly (string | number)[],
): number {
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1
  if (b.length === 0) return -1
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const left = a[i] as string | number
    const right = b[i] as string | number
    if (left === right) continue
    const leftIsNumber = typeof left === 'number'
    const rightIsNumber = typeof right === 'number'
    if (leftIsNumber !== rightIsNumber) return leftIsNumber ? -1 : 1
    if (leftIsNumber && rightIsNumber) return left < right ? -1 : 1
    return (left as string) < (right as string) ? -1 : 1
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1
}

/**
 * Precedence between two versions, or `null` when either side is not a version
 * this can order.
 */
export function compareVersions(a: string, b: string): number | null {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) return null
  for (let i = 0; i < 3; i++) {
    const l = left.core[i] as number
    const r = right.core[i] as number
    if (l !== r) return l < r ? -1 : 1
  }
  return comparePrerelease(left.prerelease, right.prerelease)
}

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
  const order = compareVersions(candidate, current)
  return order !== null && order > 0
}

/**
 * Map a Node/Bun (platform, arch) pair to the manifest's platform-asset key
 * (Tauri updater target triple prefix, e.g. 'linux-x86_64', 'darwin-aarch64').
 */
export function platformTarget(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  const os = platform === 'win32' ? 'windows' : platform
  const cpu = arch === 'x64' ? 'x86_64' : arch === 'arm64' ? 'aarch64' : arch
  return `${os}-${cpu}`
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

/**
 * Pure, testable Ed25519 verification of a downloaded tarball. Returns true iff
 * `signatureB64` is a valid Ed25519 signature of `bytes` under the base64 SPKI/DER
 * public key `pubkeyB64`. A missing/empty signature, a malformed key, or any crypto
 * error returns false (never throws) so callers can fail closed.
 */
export function verifyTarball(
  bytes: Uint8Array,
  signatureB64: string,
  pubkeyB64: string = PODIUM_UPDATE_PUBKEY,
): boolean {
  if (!signatureB64) return false
  try {
    const key = {
      key: Buffer.from(pubkeyB64, 'base64'),
      format: 'der' as const,
      type: 'spki' as const,
    }
    // Ed25519 verify takes (algorithm=null, data, key, signature).
    return cryptoVerify(null, bytes, key, Buffer.from(signatureB64, 'base64'))
  } catch {
    return false
  }
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
  console.log(`[podium update] updating ${cur} → ${version}`)
  // Stage on the install dir's OWN filesystem (a sibling temp dir), NOT tmpdir(): /tmp is
  // frequently tmpfs / a different device, which would make the final swap rename throw EXDEV
  // AFTER the old install was already moved to `.old` — bricking the install with no rollback.
  // A sibling temp dir guarantees the final rename is a same-device atomic operation.
  const tmp = mkdtempSync(join(dirname(dir), '.podium-update-'))
  try {
    const tarball = join(tmp, 'bundle.tar.gz')
    const dl = await fetch(url)
    if (!dl.ok) throw new Error(`artifact download returned ${dl.status}`)
    const bytes = new Uint8Array(await dl.arrayBuffer())
    // SECURITY GATE: verify the manifest's Ed25519 signature over the EXACT downloaded
    // bytes against the committed pubkey BEFORE extracting or touching the install. A
    // tampered/unsigned tarball is rejected here — fail closed, never swap.
    if (!verifyTarball(bytes, signature, pubkeyB64)) {
      console.error(
        '[podium update] signature verification FAILED — refusing to install. ' +
          'The tarball was not signed by the trusted Podium update key (tampered, ' +
          'corrupt, or wrong feed). No changes were made.',
      )
      process.exitCode = 1
      return
    }
    writeFileSync(tarball, bytes)
    // Extract into a staging dir, then atomically swap the install dir in place.
    const staged = join(tmp, 'staged')
    execFileSync('mkdir', ['-p', staged])
    execFileSync('tar', ['-xzf', tarball, '-C', staged])
    const newRoot = join(staged, 'headless')
    if (!existsSync(newRoot)) throw new Error('tarball did not contain a headless/ dir')
    const backup = `${dir}.old`
    rmSync(backup, { recursive: true, force: true })
    // Both `dir` and `newRoot` live on the same filesystem (sibling temp dir), so each rename is
    // an atomic same-device operation. If the second rename still fails for any reason, roll the
    // backup back into place so the install dir is never left missing.
    renameSync(dir, backup)
    try {
      renameSync(newRoot, dir)
    } catch (err) {
      renameSync(backup, dir)
      throw err
    }
    rmSync(backup, { recursive: true, force: true })
    console.log(`[podium update] updated to ${version}; restart podium to apply`)
    if (reviveJanitor()) {
      console.log(`[podium update] restarted compatibility-blocked janitor`)
    }
    // Exit 10 = "actually updated" (distinct from 0 = already current, 1 = failure). The
    // systemd update timer keys off this code to restart the daemon only on a real swap;
    // compatibility-blocked janitors need the explicit reset/start above.
    process.exitCode = 10
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

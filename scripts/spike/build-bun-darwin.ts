/**
 * SPIKE (POD-2501): cross-compile the headless CLI for Darwin from Linux.
 *
 * Not for landing as-is — a minimal fork of scripts/build-bun.ts that:
 *   - takes --target=bun-darwin-arm64 | bun-darwin-x64
 *   - embeds scripts/prebuilt/abduco/<platform>/abduco instead of compiling host abduco
 *   - skips web/mobile packaging (optional --full-bundle) so the spike can prove
 *     binary+abduco without rebuilding client dists
 *   - ad-hoc signs the Mach-O with rcodesign + Bun JIT entitlements
 *
 * Usage:
 *   bun --conditions=@podium/source scripts/spike/build-bun-darwin.ts --target=bun-darwin-arm64
 */
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DISCOVERY_WORKER_ENTRY } from '../../apps/daemon/src/discovery-worker-embed.js'
import {
  bunVersion,
  hasBunTerminal,
  minTerminalBunVersion,
} from '../../packages/pty/src/backends/bun-terminal-backend.js'
import { launcherShim } from '../build-bun.js'

type SpikeTarget = 'bun-darwin-arm64' | 'bun-darwin-x64'

function parseArgs(argv: string[]): { target: SpikeTarget; fullBundle: boolean } {
  let target: SpikeTarget | undefined
  let fullBundle = false
  for (const a of argv) {
    if (a.startsWith('--target=')) target = a.slice('--target='.length) as SpikeTarget
    else if (a === '--full-bundle') fullBundle = true
  }
  if (target !== 'bun-darwin-arm64' && target !== 'bun-darwin-x64') {
    throw new Error(
      'spike/build-bun-darwin: pass --target=bun-darwin-arm64 or --target=bun-darwin-x64',
    )
  }
  return { target, fullBundle }
}

function platformDir(target: SpikeTarget): 'darwin-arm64' | 'darwin-x64' {
  return target === 'bun-darwin-arm64' ? 'darwin-arm64' : 'darwin-x64'
}

function main(): void {
  if (!hasBunTerminal()) {
    throw new Error(
      `spike: Bun ${bunVersion()} lacks terminal PTY API; need >= ${minTerminalBunVersion()}`,
    )
  }

  const { target, fullBundle } = parseArgs(process.argv.slice(2))
  const root = fileURLToPath(new URL('../..', import.meta.url))
  const out = `${root}dist-bun-spike/${platformDir(target)}`
  const prebuilt = `${root}scripts/prebuilt/abduco/${platformDir(target)}/abduco`
  const entitlements = `${root}scripts/spike/bun-jit.entitlements.plist`

  if (!existsSync(prebuilt)) {
    throw new Error(
      `spike: missing prebuilt abduco at ${prebuilt} — run scripts/spike/build-prebuilt-abduco.sh first`,
    )
  }
  if (!existsSync(entitlements)) {
    throw new Error(`spike: missing entitlements ${entitlements}`)
  }

  const pkgVersion = (
    JSON.parse(readFileSync(`${root}package.json`, 'utf8')) as { version?: string }
  ).version
  const version =
    process.env.PODIUM_APP_VERSION ??
    `spike-darwin+${(pkgVersion ?? '0').replace(/[^A-Za-z0-9.+_-]/g, '')}`

  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })

  // Embed Darwin abduco bytes at the path scripts/embedded-abduco.ts imports.
  // The host dist-bun/abduco.bin is what the compile-time `with { type: 'file' }` reads.
  const hostEmbed = `${root}dist-bun`
  mkdirSync(hostEmbed, { recursive: true })
  cpSync(prebuilt, `${hostEmbed}/abduco.bin`)
  console.log(`[spike] embedded abduco <- ${prebuilt}`)

  console.log(`[spike] compiling podium for ${target} (v${version})…`)
  execFileSync(
    'bun',
    [
      'build',
      '--compile',
      `--target=${target}`,
      '--conditions=@podium/source',
      '--define',
      `process.env.PODIUM_APP_VERSION="${version}"`,
      'scripts/cli-compiled.ts',
      DISCOVERY_WORKER_ENTRY,
      '--outfile',
      `${out}/podium`,
    ],
    { cwd: root, stdio: 'inherit' },
  )

  const unsigned = `${out}/podium.unsigned`
  const signed = `${out}/podium`
  // Keep an unsigned copy so Mac verification can prove unsigned fails / ad-hoc passes.
  cpSync(signed, unsigned)
  chmodSync(unsigned, 0o755)

  console.log('[spike] rcodesign ad-hoc sign (with Bun JIT entitlements)…')
  // Exact invocation recorded for the spike evidence:
  //   rcodesign sign --binary-identifier podium \
  //     --entitlements-xml-file scripts/spike/bun-jit.entitlements.plist <mach-o>
  execFileSync(
    'rcodesign',
    [
      'sign',
      '--binary-identifier',
      'podium',
      '--entitlements-xml-file',
      entitlements,
      signed,
    ],
    { stdio: 'inherit' },
  )
  chmodSync(signed, 0o755)

  // Also ship a standalone signed abduco next to the binary (for PODIUM_ABDUCO override tests).
  cpSync(prebuilt, `${out}/abduco`)
  chmodSync(`${out}/abduco`, 0o755)

  const headless = `${out}/headless`
  mkdirSync(headless, { recursive: true })
  cpSync(signed, `${headless}/podium-cli`)
  chmodSync(`${headless}/podium-cli`, 0o755)
  writeFileSync(`${headless}/podium`, launcherShim())
  chmodSync(`${headless}/podium`, 0o755)
  writeFileSync(`${headless}/VERSION`, `${version}\n`)
  writeFileSync(
    `${headless}/SPIKE.txt`,
    [
      `POD-2501 Darwin cross-compile spike`,
      `built-on: linux ${process.arch}`,
      `bun-target: ${target}`,
      `bun-version: ${bunVersion()}`,
      `version: ${version}`,
      `abduco: scripts/prebuilt/abduco/${platformDir(target)}/abduco`,
      `sign: rcodesign sign --entitlements-xml-file scripts/spike/bun-jit.entitlements.plist`,
      `full-bundle: ${fullBundle}`,
      '',
    ].join('\n'),
  )

  if (fullBundle) {
    const webDist = `${root}apps/web/dist`
    const mobileDist = `${root}apps/mobile/dist`
    if (!existsSync(`${webDist}/index.html`) || !existsSync(`${mobileDist}/index.html`)) {
      throw new Error('spike --full-bundle requires apps/web/dist and apps/mobile/dist')
    }
    cpSync(webDist, `${headless}/web`, { recursive: true })
    cpSync(mobileDist, `${headless}/mobile`, { recursive: true })
  } else {
    // Minimal placeholders so a throwaway boot does not confuse path probes.
    mkdirSync(`${headless}/web`, { recursive: true })
    mkdirSync(`${headless}/mobile`, { recursive: true })
    writeFileSync(
      `${headless}/web/index.html`,
      '<!doctype html><title>spike</title><p>POD-2501 spike — no web dist</p>\n',
    )
    writeFileSync(
      `${headless}/mobile/index.html`,
      '<!doctype html><title>spike</title><p>POD-2501 spike — no mobile dist</p>\n',
    )
  }

  const tarball = `${out}/podium-headless-spike-${platformDir(target)}.tar.gz`
  execFileSync('tar', ['-czf', tarball, '-C', out, 'headless', 'podium', 'podium.unsigned', 'abduco'], {
    stdio: 'inherit',
  })

  console.log(`[spike] binary  -> ${signed}`)
  console.log(`[spike] unsigned copy -> ${unsigned}`)
  console.log(`[spike] tarball -> ${tarball}`)
  console.log(`[spike] file(1):`)
  execFileSync('file', [signed, unsigned, `${out}/abduco`], { stdio: 'inherit' })
}

if (import.meta.main) main()

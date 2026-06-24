/**
 * Build the single-file `bun build --compile` binaries.
 *
 *   1. Prebuild the vendored abduco (cc → dist-bun/abduco.bin) so the daemon can embed
 *      it — the compiled binary has no abduco.c on disk to compile at runtime.
 *   2. Compile the server (relay + bun:sqlite; no PTY, no abduco).
 *   3. Compile the daemon via scripts/daemon-compiled.ts (embeds + materializes abduco).
 *
 * Run with: bun scripts/build-bun.ts
 */
import { execFileSync } from 'node:child_process'
import { sign as cryptoSign } from 'node:crypto'
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildVendoredAbduco } from '../packages/agent-bridge/src/abduco-bin.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const out = `${root}dist-bun`
mkdirSync(out, { recursive: true })

// Single source of truth for the version: root package.json `version` (env PODIUM_APP_VERSION
// wins for one-off builds). Drives the headless VERSION stamp AND the value baked into the
// compiled server's /version (process.env.PODIUM_APP_VERSION via --define below).
const pkgVersion = (() => {
  try {
    return (JSON.parse(readFileSync(`${root}package.json`, 'utf8')) as { version?: string }).version
  } catch {
    return undefined
  }
})()
const version = process.env.PODIUM_APP_VERSION ?? pkgVersion ?? '0.1.0'

console.log('[build-bun] prebuilding abduco…')
const abduco = buildVendoredAbduco(`${out}/abduco.bin`)
if (!abduco) throw new Error('build-bun: failed to prebuild abduco (no C compiler?)')
console.log(`[build-bun] abduco -> ${abduco}`)

const compile = (entry: string, name: string): void => {
  console.log(`[build-bun] compiling ${name} (v${version})…`)
  execFileSync(
    'bun',
    [
      'build',
      '--compile',
      '--conditions=@podium/source',
      // Bake the real version so the compiled server's /version reports it (not 'dev').
      // Inlined at build time wherever process.env.PODIUM_APP_VERSION is read.
      '--define',
      `process.env.PODIUM_APP_VERSION="${version}"`,
      entry,
      '--outfile',
      `dist-bun/${name}`,
    ],
    { cwd: root, stdio: 'inherit' },
  )
}

compile('scripts/server.ts', 'podium-server')
compile('scripts/daemon-compiled.ts', 'podium-daemon')
compile('scripts/cli-compiled.ts', 'podium')
console.log('[build-bun] done -> dist-bun/podium-server, dist-bun/podium-daemon, dist-bun/podium')

// --- headless bundle: binaries + web + launcher ---------------------------------
const headless = `${out}/headless`
const webDist = `${root}apps/web/dist`
if (!existsSync(`${webDist}/index.html`)) {
  throw new Error('build-bun: apps/web/dist not built — run `bun run --filter @podium/web build` first')
}
mkdirSync(headless, { recursive: true })
for (const bin of ['podium-server', 'podium-daemon']) {
  cpSync(`${out}/${bin}`, `${headless}/${bin}`)
  chmodSync(`${headless}/${bin}`, 0o755)
}
cpSync(webDist, `${headless}/web`, { recursive: true })

cpSync(`${out}/podium`, `${headless}/podium-cli`)
chmodSync(`${headless}/podium-cli`, 0o755)

// VERSION stamp — drives `podium update`'s self version check. Same single source as the
// baked-in /version above (root package.json `version`, env PODIUM_APP_VERSION wins).
writeFileSync(`${headless}/VERSION`, `${version}\n`)

// Launcher shim: export PODIUM_HOME so `podium update`'s installDir() resolves to the
// bundle root (independent of cwd / the compiled binary's execPath).
const launcher = `#!/bin/sh
DIR="$(cd "$(dirname "$0")" && pwd)"
export PODIUM_HOME="$DIR"
export PODIUM_WEB_DIR="\${PODIUM_WEB_DIR:-$DIR/web}"
exec "$DIR/podium-cli" "$@"
`
writeFileSync(`${headless}/podium`, launcher)
chmodSync(`${headless}/podium`, 0o755)

// Self-update artifact: a tarball of the headless/ dir the feed can serve. `tar` from the
// bundle's parent so the archive root is `headless/` (matching runUpdate's extract path).
const tarball = `${out}/podium-headless-${version}.tar.gz`
execFileSync('tar', ['-czf', tarball, '-C', out, 'headless'], { cwd: root, stdio: 'inherit' })

// Sign the tarball bytes (Ed25519) so the feed can serve `signature` and `podium update`
// can verify before swapping. Key source: env PODIUM_UPDATE_SIGNING_KEY (base64 pkcs8/DER,
// the operator's production key at release) else the gitignored dev key. The matching public
// key is committed in scripts/podium-update-pubkey.ts — keep the two in lockstep on release.
const signingKeyB64 = (() => {
  if (process.env.PODIUM_UPDATE_SIGNING_KEY) return process.env.PODIUM_UPDATE_SIGNING_KEY.trim()
  const devKey = `${root}scripts/.podium-update-dev.key`
  if (existsSync(devKey)) return readFileSync(devKey, 'utf8').trim()
  return undefined
})()
if (!signingKeyB64) {
  console.warn(
    '[build-bun] no signing key (PODIUM_UPDATE_SIGNING_KEY unset + dev key missing) — ' +
      'skipping .sig; `podium update` will REJECT this tarball. Generate scripts/.podium-update-dev.key.',
  )
} else {
  const key = { key: Buffer.from(signingKeyB64, 'base64'), format: 'der' as const, type: 'pkcs8' as const }
  const sig = cryptoSign(null, readFileSync(tarball), key).toString('base64')
  writeFileSync(`${tarball}.sig`, `${sig}\n`)
  console.log(`[build-bun] headless update signature -> ${tarball}.sig`)
}

console.log(`[build-bun] headless bundle -> ${headless} (VERSION ${version})`)
console.log(`[build-bun] headless update artifact -> ${tarball}`)

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
import { chmodSync, cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildVendoredAbduco } from '../packages/agent-bridge/src/abduco-bin.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const out = `${root}dist-bun`
mkdirSync(out, { recursive: true })

console.log('[build-bun] prebuilding abduco…')
const abduco = buildVendoredAbduco(`${out}/abduco.bin`)
if (!abduco) throw new Error('build-bun: failed to prebuild abduco (no C compiler?)')
console.log(`[build-bun] abduco -> ${abduco}`)

const compile = (entry: string, name: string): void => {
  console.log(`[build-bun] compiling ${name}…`)
  execFileSync(
    'bun',
    ['build', '--compile', '--conditions=@podium/source', entry, '--outfile', `dist-bun/${name}`],
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
const launcher = `#!/bin/sh
DIR="$(cd "$(dirname "$0")" && pwd)"
export PODIUM_WEB_DIR="\${PODIUM_WEB_DIR:-$DIR/web}"
exec "$DIR/podium-cli" "$@"
`
writeFileSync(`${headless}/podium`, launcher)
chmodSync(`${headless}/podium`, 0o755)
console.log(`[build-bun] headless bundle -> ${headless}`)

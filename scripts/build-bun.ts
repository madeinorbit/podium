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
import { DISCOVERY_WORKER_ENTRY } from '../apps/daemon/src/discovery-worker-embed.js'
import { buildVendoredAbduco } from '../packages/agent-bridge/src/abduco-bin.js'
import {
  bunVersion,
  hasBunTerminal,
} from '../packages/agent-bridge/src/pty/bun-terminal-backend.js'

/**
 * The POSIX-sh launcher shim written to `headless/podium`. It exports PODIUM_HOME (so
 * `podium update`'s installDir() resolves to the bundle root, independent of cwd / the
 * compiled binary's execPath) and PODIUM_WEB_DIR, then execs the compiled CLI.
 *
 * It resolves symlinks before computing DIR so the bundle root is found even when invoked
 * via the `~/.local/bin/podium` symlink that install.sh creates — `$0` would otherwise be
 * the symlink's own directory (`~/.local/bin`), making it look for a nonexistent
 * `~/.local/bin/podium-cli` and export a wrong PODIUM_HOME. The loop is POSIX-portable
 * (plain `readlink`, resolving relative targets against their link's dir — NO `readlink -f`,
 * which is absent on macOS).
 *
 * Exported so a test can render + execute the REAL shim through a symlink (the value baked
 * into the shipped binary), rather than a stub.
 *
 * NOTE: in this template literal only `${…}` needs escaping (`\${…}`) — bare `$` (e.g. `$0`,
 * `$DIR`, `$(…)`) is literal, so the WRITTEN file contains real shell variables.
 */
export function launcherShim(): string {
  return `#!/bin/sh
# Resolve symlinks so DIR is the real bundle root even when invoked via a
# ~/.local/bin/podium symlink ($0 would otherwise be the symlink's own dir).
SELF="$0"
while [ -L "$SELF" ]; do
  link="$(readlink "$SELF")"
  case "$link" in
    /*) SELF="$link" ;;
    *) SELF="$(dirname "$SELF")/$link" ;;
  esac
done
DIR="$(cd "$(dirname "$SELF")" && pwd)"
export PODIUM_HOME="$DIR"
export PODIUM_WEB_DIR="\${PODIUM_WEB_DIR:-$DIR/web}"
exec "$DIR/podium-cli" "$@"
`
}

function main(): void {
  // Refuse to compile with a Bun whose terminal PTY API is missing (feature-detected, not
  // version-guessed). The compiled daemon's ONLY PTY is Bun's terminal — `bun build --compile`
  // can't embed node-pty's native addon — so an old build Bun would silently ship a binary
  // whose remote terminals render black (proc.terminal undefined on attach). This is the guard
  // that answers "why was the build allowed to use an old Bun": now it isn't.
  if (!hasBunTerminal())
    throw new Error(
      `build-bun: Bun ${bunVersion()} lacks a working terminal PTY API (Bun.spawn({terminal}) → ` +
        `proc.terminal); need Bun >= 1.3.5. The compiled daemon would render remote terminals black. ` +
        `Upgrade Bun (\`bun upgrade\`) and rebuild.`,
    )
  const root = fileURLToPath(new URL('..', import.meta.url))
  const out = `${root}dist-bun`
  mkdirSync(out, { recursive: true })

  // Single source of truth for the version: root package.json `version` (env PODIUM_APP_VERSION
  // wins for one-off builds). Drives the headless VERSION stamp AND the value baked into the
  // compiled server's /version (process.env.PODIUM_APP_VERSION via --define below).
  const pkgVersion = (() => {
    try {
      return (JSON.parse(readFileSync(`${root}package.json`, 'utf8')) as { version?: string })
        .version
    } catch {
      return undefined
    }
  })()
  const version = process.env.PODIUM_APP_VERSION ?? pkgVersion ?? '0.1.0'

  console.log('[build-bun] prebuilding abduco…')
  const abduco = buildVendoredAbduco(`${out}/abduco.bin`)
  if (!abduco)
    throw new Error(
      'build-bun: failed to prebuild abduco (missing C compiler, or a compile error — see the [podium] abduco build output above)',
    )
  console.log(`[build-bun] abduco -> ${abduco}`)

  const compile = (
    entry: string,
    name: string,
    opts: { extraEntrypoints?: string[]; defines?: Record<string, string> } = {},
  ): void => {
    console.log(`[build-bun] compiling ${name} (v${version})…`)
    const defines: Record<string, string> = {
      // Bake the real version so the compiled server's /version reports it (not 'dev').
      // Inlined at build time wherever process.env.PODIUM_APP_VERSION is read.
      'process.env.PODIUM_APP_VERSION': `"${version}"`,
      ...opts.defines,
    }
    const defineArgs = Object.entries(defines).flatMap(([k, v]) => ['--define', `${k}=${v}`])
    execFileSync(
      'bun',
      [
        'build',
        '--compile',
        '--conditions=@podium/source',
        ...defineArgs,
        entry,
        // Extra entrypoints are bundled + embedded alongside the main one (their whole dep
        // graph included). `bun build --compile` embeds each additional entrypoint at its path
        // relative to the common ancestor of ALL entrypoints, under /$bunfs/root. The main
        // entry, by contrast, always lands at /$bunfs/root/<outfile-basename>.
        ...(opts.extraEntrypoints ?? []),
        '--outfile',
        `dist-bun/${name}`,
      ],
      { cwd: root, stdio: 'inherit' },
    )
  }

  // ONE binary ships. The `podium` CLI runs every role — the split components as
  // `podium server` / `podium daemon` (separate processes), the desktop sidecar as in-process
  // all-in-one — so the previously-separate standalone `podium-server`/`podium-daemon` compiles
  // are redundant and dropped (see #98). The CLI runs a daemon in-process (all-in-one / `podium
  // daemon`), so it must embed the discovery Worker: `new Worker(new URL('./discovery-worker.ts',
  // import.meta.url))` is NOT auto-embedded by `bun build --compile` (Bun 1.3.x), so we add the
  // worker as an explicit extra entrypoint; worker-client.ts spawns it from
  // DISCOVERY_WORKER_EMBEDDED_PATH (shared via discovery-worker-embed.ts).
  compile('scripts/cli-compiled.ts', 'podium', { extraEntrypoints: [DISCOVERY_WORKER_ENTRY] })
  console.log('[build-bun] done -> dist-bun/podium')

  // --- headless bundle: binaries + web + launcher ---------------------------------
  const headless = `${out}/headless`
  const webDist = `${root}apps/web/dist`
  if (!existsSync(`${webDist}/index.html`)) {
    throw new Error(
      'build-bun: apps/web/dist not built — run `bun run --filter @podium/web build` first',
    )
  }
  mkdirSync(headless, { recursive: true })
  cpSync(webDist, `${headless}/web`, { recursive: true })

  // The one compiled binary, plus the launcher shim (below) that execs it as `podium-cli`.
  cpSync(`${out}/podium`, `${headless}/podium-cli`)
  chmodSync(`${headless}/podium-cli`, 0o755)

  // VERSION stamp — drives `podium update`'s self version check. Same single source as the
  // baked-in /version above (root package.json `version`, env PODIUM_APP_VERSION wins).
  writeFileSync(`${headless}/VERSION`, `${version}\n`)

  // Launcher shim (see launcherShim() above): resolves symlinks so `~/.local/bin/podium`
  // finds the real bundle, then execs the compiled CLI with PODIUM_HOME/PODIUM_WEB_DIR set.
  writeFileSync(`${headless}/podium`, launcherShim())
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
    const key = {
      key: Buffer.from(signingKeyB64, 'base64'),
      format: 'der' as const,
      type: 'pkcs8' as const,
    }
    const sig = cryptoSign(null, readFileSync(tarball), key).toString('base64')
    writeFileSync(`${tarball}.sig`, `${sig}\n`)
    console.log(`[build-bun] headless update signature -> ${tarball}.sig`)
  }

  console.log(`[build-bun] headless bundle -> ${headless} (VERSION ${version})`)
  console.log(`[build-bun] headless update artifact -> ${tarball}`)
}

if (import.meta.main) main()

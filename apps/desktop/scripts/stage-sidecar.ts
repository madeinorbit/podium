/**
 * Tauri prebuild: produce the compiled `podium` backend + web bundle, then stage them
 * where tauri.conf.json expects — the sidecar named with the host target triple, and the
 * web build as a bundled resource (PODIUM_WEB_DIR for external clients).
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const desktopDir = fileURLToPath(new URL('..', import.meta.url)) // apps/desktop/
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url)) // repo root

// 1. Build the backend (compiled podium) + web (dist-bun/headless/web + dist-bun/podium).
execFileSync('bun', ['run', 'package:headless'], { cwd: repoRoot, stdio: 'inherit' })

// 2. Host target triple (e.g. x86_64-unknown-linux-gnu) from rustc.
const vv = execFileSync('rustc', ['-vV'], { encoding: 'utf8' })
const triple = vv.split('\n').find((l) => l.startsWith('host: '))?.slice(6).trim()
if (!triple) throw new Error('could not determine rustc host triple')

// 3. Stage the sidecar binary, triple-suffixed.
const binDir = `${desktopDir}src-tauri/binaries`
rmSync(binDir, { recursive: true, force: true })
mkdirSync(binDir, { recursive: true })
const podium = `${repoRoot}/dist-bun/podium`
if (!existsSync(podium)) throw new Error(`missing ${podium} — package:headless did not produce it`)
cpSync(podium, `${binDir}/podium-${triple}`)
chmodSync(`${binDir}/podium-${triple}`, 0o755)

// 4. Stage the web bundle as a resource (served to external clients via PODIUM_WEB_DIR).
const webSrc = `${repoRoot}/apps/web/dist`
const webDst = `${desktopDir}src-tauri/resources/web`
rmSync(webDst, { recursive: true, force: true })
mkdirSync(`${desktopDir}src-tauri/resources`, { recursive: true })
cpSync(webSrc, webDst, { recursive: true })

console.log(`[stage-sidecar] podium-${triple} + resources/web staged`)

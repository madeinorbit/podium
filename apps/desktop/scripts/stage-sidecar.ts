/**
 * Tauri prebuild: produce the compiled `podium` backend + web bundle, then stage them
 * where tauri.conf.json expects — both as plain resources (copied verbatim, never patchelf'd).
 *
 * NOTE: we intentionally do NOT use Tauri externalBin / sidecar for `podium`.
 * Tauri's AppImage bundler runs patchelf on externalBin entries, which corrupts
 * Bun-compiled binaries (Bun appends a payload after the ELF, patchelf breaks it).
 * Instead we stage podium as a plain resource and spawn it via std::process::Command.
 */
import { chmodSync, cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const desktopDir = fileURLToPath(new URL('..', import.meta.url)) // apps/desktop/
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url)) // repo root

// 1. Build the backend (compiled podium) + web (dist-bun/headless/web + dist-bun/podium).
execFileSync('bun', ['run', 'package:headless'], { cwd: repoRoot, stdio: 'inherit' })

// 2. Stage the podium binary as a plain resource (no triple suffix, never patchelf'd).
const resourcesDir = `${desktopDir}src-tauri/resources`
mkdirSync(resourcesDir, { recursive: true })
const podiumSrc = `${repoRoot}/dist-bun/podium`
if (!existsSync(podiumSrc)) throw new Error(`missing ${podiumSrc} — package:headless did not produce it`)
const podiumDst = `${resourcesDir}/podium`
cpSync(podiumSrc, podiumDst)
chmodSync(podiumDst, 0o755)

// 3. Stage the web bundle as a resource (served to external clients via PODIUM_WEB_DIR).
const webSrc = `${repoRoot}/apps/web/dist`
const webDst = `${resourcesDir}/web`
rmSync(webDst, { recursive: true, force: true })
cpSync(webSrc, webDst, { recursive: true })

console.log(`[stage-sidecar] resources/podium + resources/web staged`)

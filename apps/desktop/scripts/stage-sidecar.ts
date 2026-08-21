/**
 * Tauri prebuild: produce the compiled `podium` backend + web bundle, then stage them
 * where tauri.conf.json expects — both as plain resources (copied verbatim, never patchelf'd).
 *
 * NOTE: we intentionally do NOT use Tauri externalBin / sidecar for `podium`.
 * Tauri's AppImage bundler runs patchelf on externalBin entries, which corrupts
 * Bun-compiled binaries (Bun appends a payload after the ELF, patchelf breaks it).
 * Instead we stage podium as a plain resource and spawn it via std::process::Command.
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
import { bundleNames } from '../../../scripts/build-bun.js'

const desktopDir = fileURLToPath(new URL('..', import.meta.url)) // apps/desktop/
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url)) // repo root

// 0. Single-source the version: copy root package.json `version` into tauri.conf.json so the
//    desktop + headless bundles always report ONE version. Root package.json is the source.
const rootVersion = (
  JSON.parse(readFileSync(`${repoRoot}/package.json`, 'utf8')) as {
    version?: string
  }
).version
if (rootVersion) {
  const confPath = `${desktopDir}src-tauri/tauri.conf.json`
  const conf = JSON.parse(readFileSync(confPath, 'utf8')) as {
    version?: string
  }
  if (conf.version !== rootVersion) {
    conf.version = rootVersion
    writeFileSync(confPath, `${JSON.stringify(conf, null, 2)}\n`)
    console.log(
      `[stage-sidecar] tauri.conf.json version -> ${rootVersion} (from root package.json)`,
    )
  }
}

// 1. Build the backend (compiled podium) + web (dist-bun/headless/web + dist-bun/podium).
execFileSync('bun', ['run', 'package:headless'], {
  cwd: repoRoot,
  stdio: 'inherit',
})

// 2. Stage the complete headless bundle as the immutable first-run seed. The native
//    shell copies this directory to Application Support exactly once; every later
//    payload change is the ordinary fleet grant swap against that external install.
const resourcesDir = `${desktopDir}src-tauri/resources`
mkdirSync(resourcesDir, { recursive: true })
const payloadSrc = `${repoRoot}/dist-bun/headless`
const payloadDst = `${resourcesDir}/payload`
if (!existsSync(payloadSrc))
  throw new Error(`missing ${payloadSrc} — package:headless did not produce it`)
rmSync(payloadDst, { recursive: true, force: true })
cpSync(payloadSrc, payloadDst, { recursive: true })
const podiumDst = `${payloadDst}/${bundleNames().cli}`
chmodSync(podiumDst, 0o755)

// 2b. macOS: code-sign the staged sidecar BEFORE `tauri build` seals the .app.
//
//     Notarization rejects a bundle containing ANY unsigned Mach-O, and Tauri's signing step
//     signs the app bundle without descending into `resources/` — so an unsigned sidecar here is
//     an Apple rejection later, not a warning. Signing it now means `tauri build` seals an
//     already-valid nested binary.
//
//     APPLE_SIGNING_IDENTITY is the same identity Tauri will use for the .app; the release
//     workflow imports the Developer ID into a keychain before this runs. Unset means a local
//     build, which gets an ad-hoc signature — required on Apple Silicon for the binary to run at
//     all, and never valid for distribution.
if (process.platform === 'darwin') {
  const identity = process.env.APPLE_SIGNING_IDENTITY?.trim() || '-'
  const adHoc = identity === '-'
  execFileSync(
    'codesign',
    [
      '--force',
      '--entitlements',
      `${desktopDir}src-tauri/entitlements.sidecar.plist`,
      // The hardened runtime and a trusted timestamp are both notarization requirements, and
      // both are rejected outright by an ad-hoc signature — so a local build gets neither.
      ...(adHoc ? [] : ['--options', 'runtime', '--timestamp']),
      '--sign',
      identity,
      podiumDst,
    ],
    { stdio: 'inherit' },
  )
  console.log(
    `[stage-sidecar] signed resources/payload/podium-cli with ${
      adHoc ? 'ad-hoc identity' : identity
    }`,
  )
}

console.log(`[stage-sidecar] resources/payload seed staged`)

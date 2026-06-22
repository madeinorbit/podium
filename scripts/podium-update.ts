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
 * single feed can serve both the desktop and headless channels. NOTE: the headless path
 * does its OWN version check and does NOT yet verify the tarball signature — signing the
 * headless tarball (minisign, like the desktop AppImage) is a later hardening step.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export function isNewer(candidate: string, current: string): boolean {
  const pa = candidate.split('.').map(Number)
  const pb = current.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const a = pa[i] ?? 0
    const b = pb[i] ?? 0
    if (a !== b) return a > b
  }
  return false
}

export function parseManifest(json: string): { version: string; url: string } {
  const m = JSON.parse(json) as { version: string; platforms: Record<string, { url: string }> }
  const url = m.platforms['linux-x86_64']?.url
  if (!url) throw new Error('manifest has no linux-x86_64 artifact')
  return { version: m.version, url }
}

function installDir(): string {
  // The headless launcher (dist-bun/headless/podium) exports PODIUM_HOME=<its own dir>.
  return process.env.PODIUM_HOME ?? dirname(process.execPath)
}

function currentVersion(dir: string): string {
  const f = join(dir, 'VERSION')
  return existsSync(f) ? readFileSync(f, 'utf8').trim() : 'dev'
}

export async function runUpdate(feedBase: string): Promise<void> {
  const dir = installDir()
  const cur = currentVersion(dir)
  const target = process.env.PODIUM_UPDATE_TARGET ?? 'linux-x86_64'
  const manifestUrl = `${feedBase.replace(/\/$/, '')}/update/${target}/x86_64/${cur}`
  const res = await fetch(manifestUrl)
  if (!res.ok) {
    console.error(`[podium update] feed returned ${res.status}`)
    process.exitCode = 1
    return
  }
  const { version, url } = parseManifest(await res.text())
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
    writeFileSync(tarball, new Uint8Array(await dl.arrayBuffer()))
    // Extract into a staging dir, then atomically swap the install dir in place.
    const staged = join(tmp, 'staged')
    execFileSync('mkdir', ['-p', staged])
    execFileSync('tar', ['-xzf', tarball, '-C', staged])
    const newRoot = join(staged, 'headless')
    if (!existsSync(newRoot)) throw new Error('tarball did not contain a headless/ dir')
    // TODO: verify signature before shipping to a non-localhost feed — the headless manifest
    // carries a (currently empty) `signature` field but it is NOT yet checked. Sign the tarball
    // (minisign, like the desktop AppImage) as a production-hardening step before remote feeds.
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
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

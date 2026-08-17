import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

function opencodeRuns(bin: string): boolean {
  try {
    return spawnSync(bin, ['--version'], { stdio: 'ignore' }).status === 0
  } catch {
    return false
  }
}

/** Candidate install locations, in priority order. The daemon's systemd PATH often
 *  omits ~/.opencode/bin even though interactive shells include it. */
export function opencodeBinCandidates(homeDir?: string): string[] {
  const home = homeDir ?? process.env.HOME ?? homedir()
  // Known install paths before bare `opencode`: the daemon's systemd PATH often
  // omits ~/.opencode/bin, and abduco execvp does not run through a login shell.
  return [
    join(home, '.opencode', 'bin', 'opencode'),
    join(home, '.local', 'bin', 'opencode'),
    'opencode',
  ]
}

/** Resolve the opencode binary to an absolute path when possible. */
export function resolveOpencodeBin(homeDir?: string): string {
  for (const candidate of opencodeBinCandidates(homeDir)) {
    if (candidate !== 'opencode' && !existsSync(candidate)) continue
    // Launch resolution must not execute the CLI. Availability/identity scans
    // own process probes; a PTY spawn only needs the preferred executable name
    // and lets the eventual exec report a missing or broken binary normally.
    return candidate
  }
  return 'opencode'
}

/** Legacy synchronous availability helper. Production discovery uses the daemon snapshot. */
export function isOpencodeCliAvailable(homeDir?: string): boolean {
  return opencodeRuns(resolveOpencodeBin(homeDir))
}

/** @deprecated No module cache remains; retained for older test callers. */
export function resetOpencodeCliCache(): void {}

/** True when `opencode --help` succeeds — a slightly stronger install check. */
export function validateOpencodeCliHelp(homeDir?: string): boolean {
  try {
    const res = spawnSync(resolveOpencodeBin(homeDir), ['--help'], { encoding: 'utf8' })
    const text = `${res.stdout ?? ''}${res.stderr ?? ''}`
    return res.status === 0 && text.includes('opencode')
  } catch {
    return false
  }
}

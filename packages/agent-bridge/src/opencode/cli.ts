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

let resolvedBin: string | undefined

/** Resolve the opencode binary to an absolute path when possible. */
export function resolveOpencodeBin(homeDir?: string): string {
  if (resolvedBin && homeDir === undefined) return resolvedBin
  for (const candidate of opencodeBinCandidates(homeDir)) {
    if (candidate !== 'opencode' && !existsSync(candidate)) continue
    if (opencodeRuns(candidate)) {
      if (homeDir === undefined) resolvedBin = candidate
      return candidate
    }
  }
  if (homeDir === undefined) resolvedBin = 'opencode'
  return 'opencode'
}

// Availability is probed with a SYNCHRONOUS `opencode --version` spawn, which is
// expensive enough to show up as sustained CPU when called on every targeted
// discovery refresh (POD-192). An install appearing/disappearing within the TTL is
// picked up on the next expiry; discovery re-runs constantly, so staleness is bounded.
const AVAILABILITY_TTL_MS = 60_000
const availabilityCache = new Map<string, { value: boolean; expiresAt: number }>()

/** True when an opencode binary can be resolved and responds to --version. */
export function isOpencodeCliAvailable(homeDir?: string): boolean {
  const key = homeDir ?? '\0default'
  const cached = availabilityCache.get(key)
  const now = Date.now()
  if (cached && cached.expiresAt > now) return cached.value
  const value = opencodeRuns(resolveOpencodeBin(homeDir))
  availabilityCache.set(key, { value, expiresAt: now + AVAILABILITY_TTL_MS })
  return value
}

/** Test hook: drop cached CLI availability/resolution so probes re-run. */
export function resetOpencodeCliCache(): void {
  availabilityCache.clear()
  resolvedBin = undefined
}

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

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

/** True when an opencode binary can be resolved and responds to --version. */
export function isOpencodeCliAvailable(homeDir?: string): boolean {
  return opencodeRuns(resolveOpencodeBin(homeDir))
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

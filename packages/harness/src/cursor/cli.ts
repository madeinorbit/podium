import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

function agentRuns(bin: string): boolean {
  try {
    return spawnSync(bin, ['--version'], { stdio: 'ignore' }).status === 0
  } catch {
    return false
  }
}

/** Candidate install locations for the Cursor Agent CLI (`agent`), in priority order. */
export function cursorBinCandidates(homeDir?: string): string[] {
  const home = homeDir ?? process.env.HOME ?? homedir()
  return [join(home, '.local', 'bin', 'agent'), 'agent']
}

let resolvedBin: string | undefined

/** Resolve the Cursor Agent binary to an absolute path when possible. */
export function resolveCursorBin(homeDir?: string): string {
  if (resolvedBin && homeDir === undefined) return resolvedBin
  for (const candidate of cursorBinCandidates(homeDir)) {
    if (candidate !== 'agent' && !existsSync(candidate)) continue
    if (agentRuns(candidate)) {
      if (homeDir === undefined) resolvedBin = candidate
      return candidate
    }
  }
  if (homeDir === undefined) resolvedBin = 'agent'
  return 'agent'
}

/** True when the Cursor Agent CLI can be resolved and responds to --version. */
export function isCursorCliAvailable(homeDir?: string): boolean {
  return agentRuns(resolveCursorBin(homeDir))
}

/** True when `agent --help` succeeds — a slightly stronger install check. */
export function validateCursorCliHelp(homeDir?: string): boolean {
  try {
    const res = spawnSync(resolveCursorBin(homeDir), ['--help'], { encoding: 'utf8' })
    const text = `${res.stdout ?? ''}${res.stderr ?? ''}`
    return res.status === 0 && text.includes('Cursor Agent')
  } catch {
    return false
  }
}
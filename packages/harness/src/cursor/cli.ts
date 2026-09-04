import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

type ResolverEnvironment = Readonly<Record<string, string | undefined>>

function childEnvironment(env?: ResolverEnvironment): NodeJS.ProcessEnv {
  return { ...(env ?? process.env) }
}

function agentRuns(bin: string, env?: ResolverEnvironment): boolean {
  try {
    return (
      spawnSync(bin, ['--version'], { stdio: 'ignore', env: childEnvironment(env) }).status === 0
    )
  } catch {
    return false
  }
}

/** Candidate install locations for the Cursor Agent CLI (`agent`), in priority order. */
export function cursorBinCandidates(homeDir?: string, env?: ResolverEnvironment): string[] {
  const home = homeDir ?? (env ? (env.HOME ?? homedir()) : (process.env.HOME ?? homedir()))
  return [join(home, '.local', 'bin', 'agent'), 'agent']
}

/** Resolve the Cursor Agent binary to an absolute path when possible. */
export function resolveCursorBin(homeDir?: string, env?: ResolverEnvironment): string {
  for (const candidate of cursorBinCandidates(homeDir, env)) {
    if (candidate !== 'agent' && !existsSync(candidate)) continue
    // Launch resolution must not execute the CLI. Inventory owns identity
    // probes; the PTY control path only selects the preferred executable name.
    return candidate
  }
  return 'agent'
}

/** @deprecated No module cache remains; retained for older test callers. */
export function resetCursorCliCache(): void {}

/** True when the Cursor Agent CLI can be resolved and responds to --version. */
export function isCursorCliAvailable(homeDir?: string, env?: ResolverEnvironment): boolean {
  return agentRuns(resolveCursorBin(homeDir, env), env)
}

/** True when `agent --help` succeeds — a slightly stronger install check. */
export function validateCursorCliHelp(homeDir?: string, env?: ResolverEnvironment): boolean {
  try {
    const res = spawnSync(resolveCursorBin(homeDir, env), ['--help'], {
      encoding: 'utf8',
      env: childEnvironment(env),
    })
    const text = `${res.stdout ?? ''}${res.stderr ?? ''}`
    return res.status === 0 && text.includes('Cursor Agent')
  } catch {
    return false
  }
}

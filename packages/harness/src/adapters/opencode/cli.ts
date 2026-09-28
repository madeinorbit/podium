import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

type ResolverEnvironment = Readonly<Record<string, string | undefined>>

function childEnvironment(env?: ResolverEnvironment): NodeJS.ProcessEnv {
  return { ...(env ?? process.env) }
}

function opencodeRuns(bin: string, env?: ResolverEnvironment): boolean {
  try {
    return (
      spawnSync(bin, ['--version'], { stdio: 'ignore', env: childEnvironment(env) }).status === 0
    )
  } catch {
    return false
  }
}

/** Candidate install locations, in priority order. The daemon's systemd PATH often
 *  omits ~/.opencode/bin even though interactive shells include it. */
export function opencodeBinCandidates(homeDir?: string, env?: ResolverEnvironment): string[] {
  const home = homeDir ?? (env ? (env.HOME ?? homedir()) : (process.env.HOME ?? homedir()))
  // Known install paths before bare `opencode`: the daemon's systemd PATH often
  // omits ~/.opencode/bin, and abduco execvp does not run through a login shell.
  return [
    join(home, '.opencode', 'bin', 'opencode'),
    join(home, '.local', 'bin', 'opencode'),
    'opencode',
  ]
}

/** Resolve the opencode binary to an absolute path when possible. */
export function resolveOpencodeBin(homeDir?: string, env?: ResolverEnvironment): string {
  for (const candidate of opencodeBinCandidates(homeDir, env)) {
    if (candidate !== 'opencode' && !existsSync(candidate)) continue
    // Launch resolution must not execute the CLI. Availability/identity scans
    // own process probes; a PTY spawn only needs the preferred executable name
    // and lets the eventual exec report a missing or broken binary normally.
    return candidate
  }
  return 'opencode'
}

/** Resolve the OpenCode 2 preview binary with the same instance-aware precedence. */
export function resolveOpencode2Bin(homeDir?: string, env?: ResolverEnvironment): string {
  const home = homeDir ?? (env ? (env.HOME ?? homedir()) : (process.env.HOME ?? homedir()))
  for (const candidate of [
    join(home, '.opencode', 'bin', 'opencode2'),
    join(home, '.local', 'bin', 'opencode2'),
    'opencode2',
  ]) {
    if (candidate !== 'opencode2' && !existsSync(candidate)) continue
    return candidate
  }
  return 'opencode2'
}

export function isOpencodeCliAvailable(homeDir?: string, env?: ResolverEnvironment): boolean {
  /** Legacy synchronous availability helper. Production discovery uses the daemon snapshot. */
  return opencodeRuns(resolveOpencodeBin(homeDir, env), env)
}

/** @deprecated No module cache remains; retained for older test callers. */
export function resetOpencodeCliCache(): void {}

/** True when `opencode --help` succeeds — a slightly stronger install check. */
export function validateOpencodeCliHelp(homeDir?: string, env?: ResolverEnvironment): boolean {
  try {
    const res = spawnSync(resolveOpencodeBin(homeDir, env), ['--help'], {
      encoding: 'utf8',
      env: childEnvironment(env),
    })
    const text = `${res.stdout ?? ''}${res.stderr ?? ''}`
    return res.status === 0 && text.includes('opencode')
  } catch {
    return false
  }
}

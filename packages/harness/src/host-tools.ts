/**
 * THE OS TOOLS A HARNESS ADAPTER MAY RUN (POD-6536, design
 * docs/design/harness-access-contract.md §3.4 "OS tools are not harness
 * access").
 *
 * `ps`, `pgrep`, `lsof`, `/usr/bin/security`, `curl`, `wget`, `ldd`, `sh` and
 * `bash` are not harness binaries, but they are still programs looked up on a
 * PATH, and the daemon's own PATH is the GUI-launched one that missed
 * `/opt/homebrew/bin` in the incident. So an adapter never names one to
 * `child_process`: it asks this port, which resolves each tool to an ABSOLUTE
 * path in the command environment it was built from (the recovered login-shell
 * PATH the harness child gets), and runs that path. A tool the environment
 * does not hold fails as a missing file, never as a lookup on the daemon's
 * PATH.
 *
 * `security` and `sh` are fixed system paths, the same on every machine that
 * has them, and are not looked up at all.
 *
 * The adapters and families import no `child_process`; the harness
 * ambient-access ratchet holds them at zero.
 */
import {
  type ChildProcessWithoutNullStreams,
  type ExecFileException,
  execFile as nodeExecFile,
  execFileSync as nodeExecFileSync,
  spawn as nodeSpawn,
} from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import type { HarnessEnvironment } from './manifest.js'

/** Every OS tool an adapter runs. A new one is added here, on purpose. */
export type HostToolName =
  | 'ps'
  | 'pgrep'
  | 'lsof'
  | 'security'
  | 'curl'
  | 'wget'
  | 'ldd'
  | 'sh'
  | 'bash'

/**
 * Tools at one fixed system path: never looked up. macOS ships its process
 * tools at these paths, and a Homebrew `ps`/`lsof` earlier on PATH speaks other
 * flags, so on darwin they are pinned exactly as the owned-rollout inspection
 * always pinned them.
 */
const FIXED_EVERYWHERE: Partial<Record<HostToolName, string>> = {
  security: '/usr/bin/security',
  sh: '/bin/sh',
}
const FIXED_DARWIN: Partial<Record<HostToolName, string>> = {
  ps: '/bin/ps',
  pgrep: '/usr/bin/pgrep',
  lsof: '/usr/sbin/lsof',
}

export interface HostToolExecOptions {
  readonly timeout?: number
  readonly maxBuffer?: number
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly cwd?: string
}

export interface HostTools {
  /** The tool's absolute path, or `undefined` when the environment has none. */
  path(tool: HostToolName): string | undefined
  /** `child_process.execFile` (utf8) of the tool's absolute path. */
  execFile(
    tool: HostToolName,
    args: readonly string[],
    options: HostToolExecOptions,
    callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
  ): void
  /** `child_process.execFileSync` (utf8) of the tool's absolute path. */
  execFileSync(
    tool: HostToolName,
    args: readonly string[],
    options: HostToolExecOptions & {
      readonly stdio?: readonly ['ignore' | 'pipe', 'ignore' | 'pipe', 'ignore' | 'pipe'] | 'ignore'
    },
  ): string
  /** `child_process.spawn` with piped stdio, no shell, of the absolute path.
   *  The child inherits the process environment, as the keychain lookup always
   *  has (`security` finds the login keychain through it); only the PATH
   *  lookup is the port's. */
  spawn(tool: HostToolName, args: readonly string[]): ChildProcessWithoutNullStreams
}

/** A tool the environment does not hold: the same shape a missing file has. */
function missing(tool: HostToolName): Error & { code: string } {
  return Object.assign(new Error(`${tool} is not on the command environment's PATH`), {
    code: 'ENOENT',
  })
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * The OS tools as `env` (the command environment) resolves them. Lookups are
 * memoized per tool for the life of the value.
 */
export function hostTools(
  env: HarnessEnvironment,
  platform: NodeJS.Platform = process.platform,
): HostTools {
  const resolved = new Map<HostToolName, string | undefined>()
  const fixedPaths =
    platform === 'darwin' ? { ...FIXED_EVERYWHERE, ...FIXED_DARWIN } : FIXED_EVERYWHERE
  const path = (tool: HostToolName): string | undefined => {
    if (resolved.has(tool)) return resolved.get(tool)
    const fixed = fixedPaths[tool]
    let found: string | undefined
    if (fixed) found = executable(fixed) ? fixed : undefined
    else {
      for (const dir of (env.PATH ?? '').split(delimiter)) {
        if (!dir || !isAbsolute(dir)) continue
        const candidate = join(dir, tool)
        if (executable(candidate)) {
          found = candidate
          break
        }
      }
    }
    resolved.set(tool, found)
    return found
  }
  const childEnv = (options: HostToolExecOptions): NodeJS.ProcessEnv | undefined =>
    options.env ? { ...options.env } : { ...env }
  return {
    path,
    execFile(tool, args, options, callback) {
      const file = path(tool)
      if (!file) {
        queueMicrotask(() => callback(missing(tool), '', ''))
        return
      }
      nodeExecFile(
        file,
        [...args],
        {
          encoding: 'utf8',
          ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
          ...(options.maxBuffer !== undefined ? { maxBuffer: options.maxBuffer } : {}),
          ...(options.cwd ? { cwd: options.cwd } : {}),
          env: childEnv(options),
        },
        (error, stdout, stderr) => callback(error, stdout, stderr),
      )
    },
    execFileSync(tool, args, options) {
      const file = path(tool)
      if (!file) throw missing(tool)
      return nodeExecFileSync(file, [...args], {
        encoding: 'utf8',
        stdio: (options.stdio ?? ['ignore', 'pipe', 'pipe']) as never,
        ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
        ...(options.cwd ? { cwd: options.cwd } : {}),
        env: childEnv(options),
      }) as unknown as string
    },
    spawn(tool, args) {
      const file = path(tool)
      if (!file) throw missing(tool)
      return nodeSpawn(file, [...args], {
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    },
  }
}

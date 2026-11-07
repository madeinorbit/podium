import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentKind } from '@podium/model'
import {
  type BoundCommand,
  harnessCommand,
  type ShellCommand,
  shellCommand,
} from './bound-command.js'
import type { HarnessContext } from './harness-context-types.js'
import { ISSUE_SYSTEM_POINTER, SPEC_SYSTEM_POINTER } from './issue-system-pointer.js'
import type { HarnessLaunchOptions, LaunchArgv } from './manifest.js'
import { harnessAdapterFor, harnessSupportsInitialPrompt } from './registry.js'

// Re-exported so daemon/launch consumers can import them alongside agentLaunchCommand.
export {
  harnessSupportsInitialPrompt as agentSupportsInitialPrompt,
  ISSUE_SYSTEM_POINTER,
  SPEC_SYSTEM_POINTER,
}

/**
 * Launch options as the session spawn path holds them. `harnessContext` is
 * required for every harness kind (the adapter's own `launch` takes it as a
 * required field); only the operator's shell runs without one.
 */
export type LaunchOptions = Omit<HarnessLaunchOptions, 'harnessContext'> & {
  harnessContext?: HarnessContext
}

/** A launchable session command: a harness bound to its context, or the shell. */
export type LaunchSpec = BoundCommand<LaunchArgv> | ShellCommand<LaunchArgv>

/**
 * Build the spawn command for an agent kind. Fresh vs resume is the only
 * difference; each harness's adapter is the single place that knows its CLI's
 * resume/model/effort flags, so the daemon stays agent-agnostic. The adapter
 * declares argv only; argv[0] is the session context's installation
 * ({@link harnessCommand}), never a name looked up on the daemon's PATH. The
 * positional initial prompt only applies to argv-capable agents
 * (capabilities.argvPrompt); the adapters drop it otherwise, and callers fall
 * back to seeding the composer draft.
 */
export function agentLaunchCommand(kind: AgentKind, opts: LaunchOptions): LaunchSpec {
  if (kind === 'shell') return shellLaunchCommand(opts)
  const adapter = harnessAdapterFor(kind)
  if (!adapter) throw new Error(`Unknown agent kind: ${String(kind)}`)
  const context = opts.harnessContext
  if (!context) throw new Error(`a ${kind} launch needs the session's harness context`)
  if (context.installation.kind !== kind) {
    throw new Error(`a ${kind} launch was handed a ${context.installation.kind} harness context`)
  }
  return harnessCommand(context, adapter.launch({ ...opts, harnessContext: context }))
}

/**
 * The operator's shell. SHELL is the user's stated preference everywhere it's
 * set (including git-bash on Windows), read from the command environment the
 * caller hands in. Windows normally doesn't set it, and its COMSPEC is always
 * cmd.exe, which says nothing about the user: open PowerShell, as Windows
 * Terminal and VS Code do.
 */
export function shellLaunchCommand(opts: {
  cwd: string
  env?: Readonly<Record<string, string | undefined>>
}): ShellCommand<LaunchArgv> {
  const env = opts.env ?? process.env
  const shell = env.SHELL || (process.platform === 'win32' ? windowsDefaultShell(env) : '/bin/bash')
  return shellCommand({ cmd: shell, args: [], cwd: opts.cwd })
}

/**
 * PowerShell 7 when it is installed, else the Windows PowerShell every Windows ships, else
 * COMSPEC. Exported for tests.
 */
export function windowsDefaultShell(
  env: Readonly<Record<string, string | undefined>>,
  exists: (path: string) => boolean = existsSync,
): string {
  const programFiles = env.ProgramFiles ?? env.PROGRAMFILES ?? 'C:\\Program Files'
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows'
  for (const candidate of [
    join(programFiles, 'PowerShell', '7', 'pwsh.exe'),
    join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  ]) {
    if (exists(candidate)) return candidate
  }
  return env.COMSPEC || 'cmd.exe'
}

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentKind } from '@podium/model'
import { ISSUE_SYSTEM_POINTER, SPEC_SYSTEM_POINTER } from './issue-system-pointer.js'
import type { HarnessLaunchOptions, LaunchSpec } from './manifest.js'
import { harnessAdapterFor, harnessSupportsInitialPrompt } from './registry.js'

// Re-exported so daemon/launch consumers can import them alongside agentLaunchCommand.
export {
  harnessSupportsInitialPrompt as agentSupportsInitialPrompt,
  ISSUE_SYSTEM_POINTER,
  SPEC_SYSTEM_POINTER,
}

export type LaunchOptions = HarnessLaunchOptions
export type { LaunchSpec }

/**
 * Build the spawn command for an agent kind. Fresh vs resume is the only
 * difference; each harness's adapter is the single place that knows its CLI's
 * resume/model/effort flags, so the daemon stays agent-agnostic. The result
 * feeds straight into `spawnAgent`. The positional initial prompt only applies
 * to argv-capable agents (capabilities.argvPrompt); the adapters drop it
 * otherwise, and callers fall back to seeding the composer draft.
 */
export function agentLaunchCommand(kind: AgentKind, opts: LaunchOptions): LaunchSpec {
  if (kind === 'shell') {
    // SHELL is the user's stated preference everywhere it's set (including git-bash on
    // Windows). Windows normally doesn't set it, and its COMSPEC is always cmd.exe, which
    // says nothing about the user: open PowerShell, as Windows Terminal and VS Code do.
    const env = opts.env ?? process.env
    const shell =
      env.SHELL || (process.platform === 'win32' ? windowsDefaultShell(env) : '/bin/bash')
    return { cmd: shell, args: [], cwd: opts.cwd }
  }
  const adapter = harnessAdapterFor(kind)
  if (!adapter) throw new Error(`Unknown agent kind: ${String(kind)}`)
  return adapter.launch(opts)
}

/**
 * PowerShell 7 when it is installed, else the Windows PowerShell every Windows ships, else
 * COMSPEC. Exported for tests.
 */
export function windowsDefaultShell(
  env: NodeJS.ProcessEnv,
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

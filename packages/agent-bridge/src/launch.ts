import { type AgentKind, agentSupportsInitialPrompt } from '@podium/protocol'
import type { HarnessLaunchOptions, LaunchSpec } from './harness/adapter.js'
import { ISSUE_SYSTEM_POINTER, SPEC_SYSTEM_POINTER } from './harness/issue-system-pointer.js'
import { harnessAdapterFor } from './harness/registry.js'

// Re-exported so daemon/launch consumers can import them alongside agentLaunchCommand.
export { agentSupportsInitialPrompt, ISSUE_SYSTEM_POINTER, SPEC_SYSTEM_POINTER }

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
    const shell = process.env.SHELL || '/bin/bash'
    return { cmd: shell, args: [], cwd: opts.cwd }
  }
  const adapter = harnessAdapterFor(kind)
  if (!adapter) throw new Error(`Unknown agent kind: ${String(kind)}`)
  return adapter.launch(opts)
}

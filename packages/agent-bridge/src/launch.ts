import type { AgentKind, ResumeRef } from '@podium/protocol'

export interface LaunchOptions {
  /** Working directory the agent runs in (a project or worktree path). */
  cwd: string
  /** Present to resume an existing on-disk conversation; absent to start fresh. */
  resume?: ResumeRef
}

export interface LaunchSpec {
  cmd: string
  args: string[]
  cwd: string
}

/**
 * Build the spawn command for an agent kind. Fresh vs resume is the only
 * difference; this is the single place that knows each CLI's resume flag, so the
 * daemon stays agent-agnostic. The result feeds straight into `spawnAgent`.
 */
export function agentLaunchCommand(kind: AgentKind, opts: LaunchOptions): LaunchSpec {
  const { cwd, resume } = opts
  switch (kind) {
    case 'claude-code':
      return { cmd: 'claude', args: resume ? ['--resume', resume.value] : [], cwd }
    case 'codex':
      return { cmd: 'codex', args: resume ? ['resume', resume.value] : [], cwd }
    default: {
      const exhaustive: never = kind
      throw new Error(`Unknown agent kind: ${String(exhaustive)}`)
    }
  }
}

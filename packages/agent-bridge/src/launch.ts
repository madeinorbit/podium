import type { AgentKind, ResumeRef } from '@podium/protocol'
import { resolveCursorBin } from './cursor/cli.js'
import { resolveOpencodeBin } from './opencode/cli.js'

export interface LaunchOptions {
  /** Working directory the agent runs in (a project or worktree path). */
  cwd: string
  /** Present to resume an existing on-disk conversation; absent to start fresh. */
  resume?: ResumeRef
  /** Model override from settings; absent = the CLI's own default. */
  model?: string
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
  const { cwd, resume, model } = opts
  const modelArgs = model ? ['--model', model] : []
  switch (kind) {
    case 'claude-code':
      return {
        cmd: 'claude',
        args: [...(resume ? ['--resume', resume.value] : []), ...modelArgs],
        cwd,
      }
    case 'codex':
      return {
        cmd: 'codex',
        args: [...(resume ? ['resume', resume.value] : []), ...modelArgs],
        cwd,
      }
    case 'grok':
      return {
        cmd: 'grok',
        args: [...(resume ? ['--resume', resume.value] : []), ...modelArgs],
        cwd,
      }
    case 'opencode': {
      const modelFlag = model ? ['-m', model] : []
      return {
        cmd: resolveOpencodeBin(),
        args: [...(resume ? ['--session', resume.value] : []), ...modelFlag],
        cwd,
      }
    }
    case 'cursor': {
      const modelArgs = model ? ['--model', model] : []
      return {
        cmd: resolveCursorBin(),
        args: [...(resume ? ['--resume', resume.value] : []), ...modelArgs],
        cwd,
      }
    }
    case 'shell': {
      const shell = process.env.SHELL || '/bin/bash'
      return { cmd: shell, args: [], cwd }
    }
    default: {
      const exhaustive: never = kind
      throw new Error(`Unknown agent kind: ${String(exhaustive)}`)
    }
  }
}

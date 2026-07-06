import { type AgentKind, agentSupportsInitialPrompt, type ResumeRef } from '@podium/protocol'
import { resolveCursorBin } from './cursor/cli.js'
import { resolveOpencodeBin } from './opencode/cli.js'

// Re-exported so daemon/launch consumers can import it alongside agentLaunchCommand.
export { agentSupportsInitialPrompt }

/**
 * Always-on hint injected into interactive Claude Code's system prompt so the
 * agent knows the `podium issue` CLI exists and how to use it, even without a
 * hook-delivered `prime`. Concise and static (no per-session data): it points at
 * the tools, not a specific issue. Only claude-code gets this (the interactive
 * `claude` CLI supports `--append-system-prompt`); other agents rely on the
 * committed guide + hook-injected prime. See docs/agents/podium-issues.md.
 */
export const ISSUE_SYSTEM_POINTER =
  "This project uses Podium's issue tracker. You have a `podium issue` CLI. " +
  'Run `podium issue prime` for your current issue, workflow, and ready work. ' +
  'Track durable or discovered work as issues (`podium issue create ...`, link a follow-up with ' +
  '`podium issue dep-add --fromId <new> --toId <current> --type discovered-from`), not markdown TODO files. ' +
  '`podium issue ready` lists unblocked work; ' +
  '`podium issue claim`/`close` as you go. Editing an issue outside your assigned one needs `--outside-scope`. ' +
  'If this session is on the wrong issue (or a draft), re-home it: `podium issue attach --id <issue>` ' +
  'to join an existing issue, or `podium issue attach --subissue "<title>"` for a new piece of work.'

export interface LaunchOptions {
  /** Working directory the agent runs in (a project or worktree path). */
  cwd: string
  /** Present to resume an existing on-disk conversation; absent to start fresh. */
  resume?: ResumeRef
  /** Model override from settings; absent (or 'auto') = the CLI's own default. */
  model?: string
  /** Reasoning-effort override; absent (or 'auto') = the CLI's own default.
   *  Mapped per agent to its effort flag; agents without one (cursor) ignore it. */
  effort?: string
  /**
   * A first prompt to hand the agent at launch (e.g. an issue's description).
   * Delivered as a trailing positional argv token (`claude "<prompt>"`) for the
   * agents whose CLI consumes a positional prompt — claude-code, codex, grok.
   * This is the RACE-FREE path: the agent reads the prompt from argv at startup,
   * so there's no need to detect TUI readiness and type into a PTY that may not
   * have mounted its stdin reader yet. Ignored (no arg appended) for agents
   * without positional-prompt support; callers should fall back to seeding the
   * composer draft for those. Blank/whitespace-only prompts are ignored.
   */
  initialPrompt?: string
}

export interface LaunchSpec {
  cmd: string
  args: string[]
  cwd: string
}

/** 'auto' (or empty) is the sentinel for "no override" — the CLI decides. */
function isSet(value: string | undefined): value is string {
  return !!value && value !== 'auto'
}

/**
 * Map a reasoning-effort level to the CLI flag each agent understands. Verified
 * against each binary's `--help`: claude/grok take `--effort <level>`, codex takes
 * a reasoning-effort config override, opencode takes `--variant`. Cursor + shell
 * have no effort flag, so the effort is silently dropped there.
 */
function effortLaunchArgs(kind: AgentKind, effort: string | undefined): string[] {
  if (!isSet(effort)) return []
  switch (kind) {
    case 'claude-code':
    case 'grok':
      return ['--effort', effort]
    case 'codex':
      return ['-c', `model_reasoning_effort=${effort}`]
    case 'opencode':
      return ['--variant', effort]
    default:
      return []
  }
}

/**
 * Build the spawn command for an agent kind. Fresh vs resume is the only
 * difference; this is the single place that knows each CLI's resume flag, so the
 * daemon stays agent-agnostic. The result feeds straight into `spawnAgent`.
 */
export function agentLaunchCommand(kind: AgentKind, opts: LaunchOptions): LaunchSpec {
  const { cwd, resume, model, effort } = opts
  const modelArgs = isSet(model) ? ['--model', model] : []
  const effortArgs = effortLaunchArgs(kind, effort)
  // Trailing positional prompt for argv-capable agents (last, after all options).
  const promptArgs =
    agentSupportsInitialPrompt(kind) && opts.initialPrompt?.trim() ? [opts.initialPrompt] : []
  switch (kind) {
    case 'claude-code':
      return {
        cmd: 'claude',
        args: [
          ...(resume ? ['--resume', resume.value] : []),
          ...modelArgs,
          ...effortArgs,
          '--append-system-prompt',
          ISSUE_SYSTEM_POINTER,
          ...promptArgs,
        ],
        cwd,
      }
    case 'codex':
      return {
        cmd: 'codex',
        args: [
          ...(resume ? ['resume', resume.value] : []),
          ...modelArgs,
          ...effortArgs,
          ...promptArgs,
        ],
        cwd,
      }
    case 'grok':
      return {
        cmd: 'grok',
        args: [
          ...(resume ? ['--resume', resume.value] : []),
          ...modelArgs,
          ...effortArgs,
          ...promptArgs,
        ],
        cwd,
      }
    case 'opencode': {
      const modelFlag = isSet(model) ? ['-m', model] : []
      return {
        cmd: resolveOpencodeBin(),
        args: [...(resume ? ['--session', resume.value] : []), ...modelFlag, ...effortArgs],
        cwd,
      }
    }
    case 'cursor': {
      const modelArgs = isSet(model) ? ['--model', model] : []
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

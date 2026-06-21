export type HarnessAgentKind = 'claude-code' | 'codex' | 'grok' | 'opencode' | 'cursor'

export interface HarnessExecSpec {
  cmd: string
  args: string[]
}

/** Bin resolvers for agents whose executable path isn't a fixed name. */
export interface HarnessBins {
  opencode: () => string
  cursor: () => string
}

/** Claude Code is the only harness with a native flag to inject an extra system
 *  prompt (`--append-system-prompt`). Everything else gets it prepended. */
function supportsSystemFlag(agent: HarnessAgentKind): boolean {
  return agent === 'claude-code'
}

/**
 * Build the CLI command + args for one non-interactive ("full harness") agent
 * turn driving the superagent. Unlike a bare `claude -p <prompt>`, this injects
 * Podium's orchestrator system prompt — natively via `--append-system-prompt`
 * where the CLI supports it, otherwise prepended to the prompt — so the agent
 * runs as our orchestrator with its real tool belt rather than a context-free
 * one-shot. Pure and side-effect-free so the arg construction is unit-testable.
 */
export function buildHarnessExec(
  agent: HarnessAgentKind,
  opts: {
    prompt: string
    model?: string
    systemPrompt?: string
    /** Path to a written MCP config JSON (Claude `--mcp-config`). */
    mcpConfigPath?: string
    /** Tools pre-approved so they run headlessly without a permission prompt. */
    allowedTools?: string[]
  },
  bins: HarnessBins,
): HarnessExecSpec {
  const model = opts.model && opts.model !== 'auto' ? opts.model : undefined
  const modelArgs = (flag: string): string[] => (model ? [flag, model] : [])
  const sys = opts.systemPrompt?.trim() ? opts.systemPrompt.trim() : undefined
  // Prepend the system prompt for agents with no native flag; for Claude it rides
  // on --append-system-prompt instead, so the prompt itself stays unchanged.
  const prompt = sys && !supportsSystemFlag(agent) ? `${sys}\n\n---\n\n${opts.prompt}` : opts.prompt

  switch (agent) {
    case 'claude-code':
      return {
        cmd: 'claude',
        args: [
          '-p',
          ...(sys ? ['--append-system-prompt', sys] : []),
          ...modelArgs('--model'),
          // MCP gives the orchestrator Podium's own tools (list/start/steer agents);
          // --allowedTools pre-approves them (and read-only built-ins) so they run
          // without a permission prompt in headless print mode.
          ...(opts.mcpConfigPath ? ['--mcp-config', opts.mcpConfigPath] : []),
          ...(opts.allowedTools && opts.allowedTools.length > 0
            ? ['--allowedTools', opts.allowedTools.join(',')]
            : []),
          prompt,
        ],
      }
    case 'codex':
      return {
        cmd: 'codex',
        args: ['exec', '--skip-git-repo-check', ...modelArgs('--model'), prompt],
      }
    case 'opencode':
      return { cmd: bins.opencode(), args: ['run', ...modelArgs('-m'), prompt] }
    case 'cursor':
      return { cmd: bins.cursor(), args: ['-p', ...modelArgs('--model'), prompt] }
    default:
      return { cmd: 'grok', args: ['-p', ...modelArgs('--model'), prompt] }
  }
}

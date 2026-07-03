export type HarnessAgentKind = 'claude-code' | 'codex' | 'grok' | 'opencode' | 'cursor'

export interface HarnessExecSpec {
  cmd: string
  args: string[]
  /** Delivered on the child's stdin (then EOF). Claude takes the prompt here:
   *  its `--allowedTools` flag is VARIADIC (eats every following non-flag arg,
   *  including a trailing prompt positional — live incident on #84), and argv
   *  prompts also risk ARG_MAX with folded-in thread history. Agents without a
   *  stdin prompt get their prompt as a positional and an immediate EOF. */
  stdin?: string
}

/** Bin resolvers for agents whose executable path isn't a fixed name. */
export interface HarnessBins {
  opencode: () => string
  cursor: () => string
}

/**
 * Translate a Claude-shaped MCP config JSON into codex `-c` TOML overrides:
 * `mcp_servers."<name>".url="…"` plus `mcp_servers."<name>".http_headers={"k"="v"}`.
 * JSON string literals are valid TOML basic strings, so JSON.stringify quotes
 * every key segment and value safely. An unparseable config THROWS rather than
 * quietly yielding a tool-less run — the caller reports the failed turn, so the
 * tool loss is visible on the thread (never silent, even on this branch that
 * the server-composed config should make unreachable).
 */
function codexMcpArgs(mcpConfig: string | undefined): string[] {
  if (!mcpConfig) return []
  let servers: Record<string, { url?: string; headers?: Record<string, string> }>
  try {
    servers = (JSON.parse(mcpConfig) as { mcpServers?: typeof servers }).mcpServers ?? {}
  } catch {
    console.warn('[podium:superagent] malformed MCP config for codex — refusing a tool-less run')
    throw new Error('malformed MCP config for codex — refusing a tool-less harness run')
  }
  const args: string[] = []
  for (const [name, srv] of Object.entries(servers)) {
    if (!srv.url) continue
    args.push('-c', `mcp_servers.${JSON.stringify(name)}.url=${JSON.stringify(srv.url)}`)
    const headers = Object.entries(srv.headers ?? {})
    if (headers.length > 0) {
      const toml = headers.map(([k, v]) => `${JSON.stringify(k)}=${JSON.stringify(v)}`).join(',')
      args.push('-c', `mcp_servers.${JSON.stringify(name)}.http_headers={${toml}}`)
    }
  }
  return args
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
    /** The raw MCP config JSON ({ mcpServers: { name: { url, headers } } }).
     *  Codex has no config-file flag; its servers ride `-c` TOML overrides. */
    mcpConfig?: string
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
        ],
        // NO trailing prompt positional: --allowedTools is variadic and would
        // swallow it as junk tool rules, leaving claude promptless ("Input must
        // be provided either through stdin or as a prompt argument"). `-p` with
        // stdin is the documented headless mode and dodges ARG_MAX too.
        stdin: prompt,
      }
    case 'codex':
      return {
        cmd: 'codex',
        args: [
          'exec',
          '--skip-git-repo-check',
          ...modelArgs('--model'),
          // Podium's MCP servers as per-invocation config overrides: verified on
          // codex-cli 0.142.5 that `mcp_servers.<name>.url` + `.http_headers`
          // mount a streamable HTTP server with our identity headers attached.
          // Codex has no --allowedTools equivalent — allowedTools is ignored
          // here; the run rides `codex exec`'s own default read-only sandbox,
          // and MCP tool calls need no approval flag in exec mode.
          // Prompt as positional is safe here: `-c` is single-value (clap
          // `<key=value>`), no variadic flag precedes the positional. The
          // daemon closes stdin immediately, else codex would block appending
          // a `<stdin>` block from the never-EOF pipe.
          ...codexMcpArgs(opts.mcpConfig),
          prompt,
        ],
      }
    case 'opencode':
      return { cmd: bins.opencode(), args: ['run', ...modelArgs('-m'), prompt] }
    case 'cursor':
      return { cmd: bins.cursor(), args: ['-p', ...modelArgs('--model'), prompt] }
    default:
      return { cmd: 'grok', args: ['-p', ...modelArgs('--model'), prompt] }
  }
}

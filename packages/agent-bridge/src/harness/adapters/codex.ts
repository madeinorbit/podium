import { AGENT_CAPABILITIES } from '@podium/protocol'
import { fileChainSource, fileIdFor, recordToItemsForKind } from '@podium/transcript'
import { codexStateProvider, findCodexRolloutPath } from '../../agent-state/codex.js'
import { createCodexConversationProvider } from '../../discovery/providers/codex.js'
import { type HarnessAdapter, isSet, type TranscriptSourceInput } from '../adapter.js'

/**
 * Translate a Claude-shaped MCP config JSON into codex `-c` TOML overrides:
 * `mcp_servers."<name>".url="…"` plus `mcp_servers."<name>".http_headers={"k"="v"}`.
 * JSON string literals are valid TOML basic strings, so JSON.stringify quotes
 * every key segment and value safely. An unparseable config THROWS rather than
 * quietly yielding a tool-less run — the caller reports the failed turn, so the
 * tool loss is visible on the thread (never silent).
 */
function codexMcpArgs(mcpConfig: string | undefined, context: 'harness' | 'headless'): string[] {
  if (!mcpConfig) return []
  let servers: Record<string, { url?: string; headers?: Record<string, string> }>
  try {
    servers = (JSON.parse(mcpConfig) as { mcpServers?: typeof servers }).mcpServers ?? {}
  } catch {
    if (context === 'harness') {
      console.warn('[podium:superagent] malformed MCP config for codex — refusing a tool-less run')
      throw new Error('malformed MCP config for codex — refusing a tool-less harness run')
    }
    throw new Error('malformed MCP config for codex — refusing a tool-less headless turn')
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

// Codex stores no derivable per-cwd path; resolve the rollout from the resume
// value (state DB, then filename fallback). null/undefined → no chain.
async function chainPaths(input: TranscriptSourceInput): Promise<string[]> {
  if (!input.resumeValue) return []
  const path = await findCodexRolloutPath({
    resumeValue: input.resumeValue,
    ...(input.homeDir !== undefined ? { homeDir: input.homeDir } : {}),
  })
  return path ? [path] : []
}

export const codexAdapter: HarnessAdapter = {
  kind: 'codex',
  capabilities: AGENT_CAPABILITIES.codex,
  resumeKind: 'codex-thread',

  launch(opts) {
    return {
      cmd: 'codex',
      args: [
        ...(opts.resume ? ['resume', opts.resume.value] : []),
        ...(isSet(opts.model) ? ['--model', opts.model] : []),
        ...(isSet(opts.effort) ? ['-c', `model_reasoning_effort=${opts.effort}`] : []),
        ...(opts.initialPrompt?.trim() ? [opts.initialPrompt] : []),
      ],
      cwd: opts.cwd,
    }
  },

  exec(opts) {
    const model = opts.model && opts.model !== 'auto' ? opts.model : undefined
    const sys = opts.systemPrompt?.trim() ? opts.systemPrompt.trim() : undefined
    // No native extra-system-prompt flag — prepend it to the prompt.
    const prompt = sys ? `${sys}\n\n---\n\n${opts.prompt}` : opts.prompt
    return {
      cmd: 'codex',
      args: [
        'exec',
        '--skip-git-repo-check',
        ...(model ? ['--model', model] : []),
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
        ...codexMcpArgs(opts.mcpConfig, 'harness'),
        prompt,
      ],
    }
  },

  headless: {
    driver: 'codex-json',
    // First turn: codex mints the thread id, captured from the `--json` event
    // stream (`thread.started`); turns ≥2 thread on via `exec resume <id>`.
    resumeIdAllocation: 'stream-captured',
    buildExec(opts) {
      const model = opts.model && opts.model !== 'auto' ? opts.model : undefined
      const sys = opts.systemPrompt?.trim()
      const prompt = sys ? `${sys}\n\n---\n\n${opts.prompt}` : opts.prompt
      return {
        cmd: 'codex',
        args: [
          'exec',
          // Turns ≥2 thread onto the existing rollout; `resume` is a subcommand,
          // not a flag (verified codex-cli 0.142.5).
          ...(opts.resumeValue ? ['resume', opts.resumeValue] : []),
          '--json',
          '--skip-git-repo-check',
          ...(model ? ['--model', model] : []),
          ...(opts.effort ? ['-c', `model_reasoning_effort=${JSON.stringify(opts.effort)}`] : []),
          ...codexMcpArgs(opts.mcpConfig, 'headless'),
          // Prompt as positional is safe: no variadic flag precedes it (same
          // reasoning as exec above). The caller closes stdin immediately.
          prompt,
        ],
      }
    },
  },

  state: codexStateProvider,
  discovery: createCodexConversationProvider(),

  transcript: {
    storage: 'file-chain',
    chainPaths,
    async sourceFor(input) {
      const chain = (await chainPaths(input)).map((p) => ({ path: p, fileId: fileIdFor(p) }))
      return fileChainSource(chain, recordToItemsForKind('codex'))
    },
  },
}

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AGENT_CAPABILITIES } from '@podium/protocol'
import { fileChainSource, fileIdFor, recordToItemsForKind } from '@podium/transcript'
import {
  codexStateProvider,
  findCodexRolloutPath,
  observeCodexState,
} from '../../agent-state/codex.js'
import { createCodexConversationProvider } from '../../discovery/providers/codex.js'
import {
  accountIdentity,
  type HarnessAdapter,
  isSet,
  type TranscriptSourceInput,
} from '../adapter.js'
import { composeAgentInstructions } from '../instructions.js'

interface CodexAuthFile {
  tokens?: {
    access_token?: string
    refresh_token?: string
    id_token?: string
    account_id?: string
  }
}

function codexAuthPath(homeDir: string): string {
  const codexHome = process.env.CODEX_HOME?.trim() || join(homeDir, '.codex')
  return join(codexHome, 'auth.json')
}

function codexProfile(idToken: string | undefined): string | undefined {
  const payload = idToken?.split('.')[1]
  if (!payload) return undefined
  try {
    // Display metadata only: authentication still uses the original credential
    // and never trusts these unverified claims for authorization decisions.
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      email?: unknown
      name?: unknown
    }
    return accountIdentity(claims.name, claims.email)
  } catch {
    return undefined
  }
}

function maskedAccountId(accountId: string): string {
  return accountId.length <= 8 ? '••••' : `${accountId.slice(0, 4)}…${accountId.slice(-4)}`
}

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

  inventory: {
    binCandidates: (homeDir) => [join(homeDir, '.local', 'bin', 'codex'), 'codex'],
    detectLogin(homeDir) {
      try {
        const path = codexAuthPath(homeDir)
        if (!existsSync(path)) return { state: 'out' }
        const file = JSON.parse(readFileSync(path, 'utf8')) as CodexAuthFile
        const tokens = file.tokens
        if (!tokens?.access_token || !tokens.refresh_token) return { state: 'out' }
        const account =
          codexProfile(tokens.id_token) ??
          (tokens.account_id
            ? `ChatGPT · ${maskedAccountId(tokens.account_id)}`
            : 'ChatGPT subscription')
        return { state: 'in', account }
      } catch {
        return { state: 'out' }
      }
    },
  },

  launch(opts) {
    const instructions = composeAgentInstructions(opts.instructions)
    return {
      cmd: 'codex',
      args: [
        ...(opts.resume ? ['resume', opts.resume.value] : []),
        ...(isSet(opts.model) ? ['--model', opts.model] : []),
        ...(isSet(opts.effort) ? ['-c', `model_reasoning_effort=${opts.effort}`] : []),
        ...(instructions ? ['-c', `developer_instructions=${JSON.stringify(instructions)}`] : []),
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
      const instructions = [opts.systemPrompt, opts.contextPrompt]
        .map((part) => part?.trim())
        .filter(Boolean)
        .join('\n\n')
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
          // Codex exposes a native developer-instruction layer. Using it keeps
          // Podium's seed/focus blocks out of the transcript's user message.
          ...(instructions ? ['-c', `developer_instructions=${JSON.stringify(instructions)}`] : []),
          ...codexMcpArgs(opts.mcpConfig, 'headless'),
          // Prompt as positional is safe: no variadic flag precedes it (same
          // reasoning as exec above). The caller closes stdin immediately.
          opts.prompt,
        ],
      }
    },
  },

  state: codexStateProvider,

  // Codex state arrives on TWO channels: native hooks (codex ≥0.142, fast +
  // authoritative, the only source for PermissionRequest) via the daemon's
  // shared ingest, and this rollout observer (binding, titles, and the fallback
  // for codex builds/sessions without hooks). `bindHookThread` lets the hook
  // path pin the observer to the thread the hook payload names without
  // restarting a correctly-bound observer on every POST.
  observer(input, host) {
    // Codex creates its rollout lazily (often at the first prompt), so a
    // reattached observer must still be able to discover by cwd — floored at
    // the session's original spawn time so it can't latch onto an older
    // sibling's rollout. Spawn passes its own start; reattach the persisted one.
    const floor = input.startedAtMs ?? input.createdAtMs
    let boundThread: string | undefined
    const start = (
      resumeValue: string | undefined,
      startedAtMs: number | undefined,
    ): { stop(): void } =>
      observeCodexState({
        cwd: input.cwd,
        ...(resumeValue ? { resumeValue } : {}),
        ...(input.homeDir ? { homeDir: input.homeDir } : {}),
        ...(startedAtMs !== undefined ? { startedAtMs } : {}),
        onSession: (rolloutId, rolloutPath) => {
          boundThread = rolloutId
          host.onResumeValue(rolloutId)
          // Codex's rollout file carries both the conversation and state — the
          // same path the observer found feeds the chat tail.
          host.tailFile(rolloutPath)
        },
        // Codex's OSC terminal title is just the cwd basename (suppressed by
        // the daemon); the observer derives a real title from the thread instead.
        onTitle: (title) => host.onTitle(title),
        onEvents: (events) => host.onStateEvents(events),
      })
    // A resume/reattach passes the session's known codex-thread id so the
    // observer pins its OWN rollout instead of re-discovering by cwd+mtime
    // (which collapses sibling sessions in the same repo onto the newest
    // rollout). A fresh spawn passes undefined → discovery scoped by the floor.
    let inner = start(input.resumeValue, floor)
    return {
      stop: () => inner.stop(),
      bindHookThread(threadId) {
        // Deterministic binding: the hook names the thread this pane REALLY
        // runs, ending any discovery ambiguity (lazy rollout creation, cwd
        // siblings, a mid-session /new rolling to a fresh thread). Re-pin only
        // when the binding disagrees — every later POST is a cheap comparison.
        if (boundThread === threadId) return
        inner.stop()
        boundThread = threadId
        inner = start(threadId, undefined)
      },
    }
  },

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

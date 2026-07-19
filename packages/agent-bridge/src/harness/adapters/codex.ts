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
  type HarnessObservationLease,
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

/** Header names Podium uses to carry the MCP auth bearer. codex 0.144.5's rmcp
 *  Streamable-HTTP client must receive this as a FIRST-CLASS `bearer_token_env_var`
 *  (see below) — a raw `http_headers` bearer makes it attempt OAuth and die. */
const CODEX_AUTH_HEADERS = new Set(['x-podium-mcp-token', 'authorization'])

/** Deterministic per-server env var carrying the bearer token to codex. */
function bearerEnvVar(serverName: string): string {
  return `PODIUM_MCP_BEARER_${serverName.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`
}

/**
 * Translate a Claude-shaped MCP config JSON into codex `-c` TOML overrides:
 * `mcp_servers."<name>".url="…"`, the auth bearer via `bearer_token_env_var`, and
 * any remaining identity headers via `http_headers={"k"="v"}`. JSON string
 * literals are valid TOML basic strings, so JSON.stringify quotes every key
 * segment and value safely. An unparseable config THROWS rather than quietly
 * yielding a tool-less run — the caller reports the failed turn, so the tool
 * loss is visible on the thread (never silent).
 *
 * AUTH TRANSPORT (POD-1021): codex 0.144.5's rmcp Streamable-HTTP client opens a
 * URL server by probing for OAuth. If the bearer is smuggled as a plain
 * `http_headers` entry, codex doesn't recognise the server as statically
 * authenticated, runs OAuth discovery, finds none, and the transport worker
 * quits with `Auth(AuthorizationRequired)` — killing the whole turn. Declaring
 * the token via the first-class `bearer_token_env_var` field makes codex send
 * `Authorization: Bearer <token>` over plain POST and skip OAuth entirely. The
 * token rides an env var (returned here) rather than argv, which also keeps it
 * out of process listings. Podium's MCP route accepts either `x-podium-mcp-token`
 * or `Authorization: Bearer`, so the switch is transparent server-side.
 */
function codexMcpArgs(
  mcpConfig: string | undefined,
  context: 'harness' | 'headless',
): { args: string[]; env: Record<string, string> } {
  if (!mcpConfig) return { args: [], env: {} }
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
  const env: Record<string, string> = {}
  for (const [name, srv] of Object.entries(servers)) {
    if (!srv.url) continue
    args.push('-c', `mcp_servers.${JSON.stringify(name)}.url=${JSON.stringify(srv.url)}`)
    const headers = Object.entries(srv.headers ?? {})
    const auth = headers.find(([k]) => CODEX_AUTH_HEADERS.has(k.toLowerCase()))
    if (auth) {
      const envVar = bearerEnvVar(name)
      // codex prepends "Bearer " itself; strip any existing prefix.
      env[envVar] = auth[1].replace(/^Bearer\s+/i, '')
      args.push(
        '-c',
        `mcp_servers.${JSON.stringify(name)}.bearer_token_env_var=${JSON.stringify(envVar)}`,
      )
    }
    const rest = headers.filter(([k]) => !CODEX_AUTH_HEADERS.has(k.toLowerCase()))
    if (rest.length > 0) {
      const toml = rest.map(([k, v]) => `${JSON.stringify(k)}=${JSON.stringify(v)}`).join(',')
      args.push('-c', `mcp_servers.${JSON.stringify(name)}.http_headers={${toml}}`)
    }
  }
  return { args, env }
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
    // [spec:SP-fccf] Session identity never enters model-visible instructions.
    // Official hooks bind the stable Podium pane id to Codex's native thread id.
    const instructions = composeAgentInstructions(opts.instructions ?? [])
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
    const mcp = codexMcpArgs(opts.mcpConfig, 'harness')
    return {
      cmd: 'codex',
      args: [
        'exec',
        '--skip-git-repo-check',
        ...(model ? ['--model', model] : []),
        // Podium's MCP servers as per-invocation config overrides: verified on
        // codex-cli 0.144.5 that `mcp_servers.<name>.url` + `.bearer_token_env_var`
        // (+ `.http_headers` for identity) mount a streamable HTTP server over
        // plain POST. Codex has no --allowedTools equivalent — allowedTools is
        // ignored here; the run rides `codex exec`'s own default read-only
        // sandbox, and MCP tool calls need no approval flag in exec mode.
        // Prompt as positional is safe here: `-c` is single-value (clap
        // `<key=value>`), no variadic flag precedes the positional. The
        // daemon closes stdin immediately, else codex would block appending
        // a `<stdin>` block from the never-EOF pipe.
        ...mcp.args,
        prompt,
      ],
      ...(Object.keys(mcp.env).length > 0 ? { env: mcp.env } : {}),
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
      const mcp = codexMcpArgs(opts.mcpConfig, 'headless')
      return {
        cmd: 'codex',
        args: [
          'exec',
          // Turns ≥2 thread onto the existing rollout; `resume` is a subcommand,
          // not a flag (verified codex-cli 0.144.5).
          ...(opts.resumeValue ? ['resume', opts.resumeValue] : []),
          '--json',
          '--skip-git-repo-check',
          ...(model ? ['--model', model] : []),
          ...(opts.effort ? ['-c', `model_reasoning_effort=${JSON.stringify(opts.effort)}`] : []),
          // Codex exposes a native developer-instruction layer. Using it keeps
          // Podium's seed/focus blocks out of the transcript's user message.
          ...(instructions ? ['-c', `developer_instructions=${JSON.stringify(instructions)}`] : []),
          ...mcp.args,
          // Prompt as positional is safe: no variadic flag precedes it (same
          // reasoning as exec above). The caller closes stdin immediately.
          opts.prompt,
        ],
        ...(Object.keys(mcp.env).length > 0 ? { env: mcp.env } : {}),
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
    let observationLease = input.observationLease
    let boundThread = observationLease?.providerSessionId ?? input.resumeValue
    let pendingRebind: { rebindId: string; providerSessionId: string } | null = null
    const discovered = new Map<
      string,
      { path: string; confidence: 'exact' | 'heuristic' | undefined }
    >()
    const publishSession = (
      providerSessionId: string,
      path: string,
      confidence: 'exact' | 'heuristic' | undefined,
    ): void => {
      boundThread = providerSessionId
      host.onResumeValue(providerSessionId, confidence)
      host.tailFile(path)
    }
    const requestExactRebind = (
      providerSessionId: string,
      lease: HarnessObservationLease,
    ): void => {
      if (pendingRebind) return
      const rebindId = `codex:${lease.bindingVersion}:${lease.observerGeneration}:${providerSessionId}`
      pendingRebind = { rebindId, providerSessionId }
      host.onExactProviderRebind({
        nextProviderSessionId: providerSessionId,
        resumeKind: 'codex-thread',
        rebindId,
      })
    }
    const start = (
      resumeValue: string | undefined,
      startedAtMs: number | undefined,
    ): ReturnType<typeof observeCodexState> => {
      const lease = observationLease
      // Once the durable lease names a thread, resumeValue is the exact binding.
      // Process correlation remains useful only for legacy or initially-unbound
      // observers; allowing it to replace a leased thread would move the inner
      // observer before the exact rebind ack. [spec:SP-cdb2]
      const processBindingSessionId =
        !lease || lease.providerSessionId === null ? input.podiumSessionId : undefined
      return observeCodexState({
        cwd: input.cwd,
        ...(input.statTick ? { statTick: input.statTick } : {}),
        ...(processBindingSessionId ? { podiumSessionId: processBindingSessionId } : {}),
        ...(resumeValue ? { resumeValue } : {}),
        ...(input.homeDir ? { homeDir: input.homeDir } : {}),
        ...(startedAtMs !== undefined ? { startedAtMs } : {}),
        ...(lease && input.podiumSessionId
          ? {
              causal: {
                podiumSessionId: input.podiumSessionId,
                providerSessionId: lease.providerSessionId,
                observerGeneration: lease.observerGeneration,
                bindingVersion: lease.bindingVersion,
                acceptedCheckpoint: lease.acceptedCheckpoint,
                onObservation: (observation) => host.onObservation(observation),
                onLivePollComplete: (cursor) => host.onLiveObservationCycle?.(cursor),
                onRebindRequired: (providerSessionId) =>
                  requestExactRebind(providerSessionId, lease),
              },
            }
          : {}),
        onSession: (rolloutId, rolloutPath, confidence) => {
          discovered.set(rolloutId, { path: rolloutPath, confidence })
          const activeLease = observationLease
          if (activeLease && activeLease.providerSessionId !== rolloutId) {
            requestExactRebind(rolloutId, activeLease)
            return
          }
          // Only the accepted binding may move the durable resume ref and tail.
          publishSession(rolloutId, rolloutPath, confidence)
        },
        // Codex's OSC terminal title is just the cwd basename (suppressed by
        // the daemon); the observer derives a real title from the thread instead.
        onTitle: (title) => host.onTitle(title),
        onEvents: (events) => host.onStateEvents(events),
      })
    }
    // A resume/reattach passes the session's known codex-thread id so the
    // observer pins its OWN rollout instead of re-discovering by cwd+mtime
    // (which collapses sibling sessions in the same repo onto the newest
    // rollout). A fresh spawn passes undefined → discovery scoped by the floor.
    let inner = start(input.resumeValue, floor)
    return {
      stop: () => inner.stop(),
      onObservationAck(ack) {
        inner.onObservationAck(ack)
      },
      onProviderRebindAck(ack) {
        const priorLease = observationLease
        const pending = pendingRebind
        if (
          !priorLease ||
          !pending ||
          ack.provider !== 'codex' ||
          (input.podiumSessionId !== undefined && ack.sessionId !== input.podiumSessionId) ||
          ack.priorObserverGeneration !== priorLease.observerGeneration ||
          ack.priorBindingVersion !== priorLease.bindingVersion ||
          ack.rebindId !== pending.rebindId ||
          ack.nextProviderSessionId !== pending.providerSessionId ||
          (ack.result === 'accepted' && ack.providerSessionId !== pending.providerSessionId)
        )
          return
        pendingRebind = null
        observationLease = {
          provider: 'codex',
          providerSessionId: ack.providerSessionId,
          observerGeneration: ack.observerGeneration,
          bindingVersion: ack.bindingVersion,
          acceptedCheckpoint: ack.checkpoint,
        }
        const leaseChanged =
          priorLease?.providerSessionId !== observationLease.providerSessionId ||
          priorLease.observerGeneration !== observationLease.observerGeneration ||
          priorLease.bindingVersion !== observationLease.bindingVersion
        if (!leaseChanged) return
        inner.stop()
        boundThread = ack.providerSessionId ?? undefined
        inner = start(ack.providerSessionId ?? undefined, ack.providerSessionId ? undefined : floor)
        if (!ack.providerSessionId) return
        const accepted = discovered.get(ack.providerSessionId)
        if (accepted) {
          publishSession(ack.providerSessionId, accepted.path, accepted.confidence)
        }
      },
      bindHookThread(threadId) {
        // Deterministic binding: the hook names the thread this pane REALLY
        // runs, ending any discovery ambiguity (lazy rollout creation, cwd
        // siblings, a mid-session /new rolling to a fresh thread). Re-pin only
        // when the binding disagrees — every later POST is a cheap comparison.
        if (boundThread === threadId) return
        const activeLease = observationLease
        if (activeLease && activeLease.providerSessionId !== threadId) {
          requestExactRebind(threadId, activeLease)
          return
        }
        inner.stop()
        boundThread = threadId
        inner = start(threadId, undefined)
        const accepted = discovered.get(threadId)
        if (accepted) {
          publishSession(threadId, accepted.path, accepted.confidence)
        }
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

  // Codex login goes through auth.openai.com (loopback redirect to :1455);
  // chatgpt.com / platform.openai.com opens are plain links. Unknown hosts
  // fall to the generic heuristic.
  classifyBrowserOpen(url) {
    const host = url.hostname.toLowerCase()
    if (host === 'auth.openai.com') return { intent: 'login' }
    if (host === 'chatgpt.com' || host === 'platform.openai.com') return { intent: 'link' }
    return undefined
  },
}

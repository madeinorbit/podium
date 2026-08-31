import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { createLogger } from '@podium/logger'
import { codexRecordToItems, codexRuntime } from '@podium/transcript'
import {
  codexStateProvider,
  findCodexRolloutPath,
  observeCodexState,
  resolvePinnedCodexRollout,
} from '../agent-state/codex.js'
import { withStateChannel } from '../agent-state/types.js'
import {
  compareCodexAuthFreshness,
  readFreshnessFromAuthContents,
  readIdentityFromAuthContents,
} from '../codex-auth-identity.js'
import { CodexCredentialAbsenceGrace } from '../codex-credential-absence-grace.js'
import { createCodexConversationProvider } from '../discovery/providers/codex.js'
import { composeAgentInstructions } from '../instructions.js'
import {
  type AgentManifest,
  accountIdentity,
  type HarnessEnvironment,
  fileTranscript,
  type HarnessObservationLease,
  isSet,
  promptArgv,
  selectRuntimeDriver,
  supported,
  type TranscriptSourceInput,
  unsupported,
} from '../manifest.js'

const log = createLogger('harness:codex')

interface CodexAuthFile {
  tokens?: {
    access_token?: string
    refresh_token?: string
    id_token?: string
    /** UNBRANDED BY DECISION: a provider account id, not a server-minted Podium AccountId. */
    account_id?: string
  }
}

function codexAuthPath(homeDir: string, env: HarnessEnvironment = process.env): string {
  const codexHome = env.CODEX_HOME?.trim() || join(homeDir, '.codex')
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

/** UNBRANDED BY DECISION: a provider account id, not a server-minted Podium AccountId. */
function maskedAccountId(accountId: string): string {
  return accountId.length <= 8 ? '••••' : `${accountId.slice(0, 4)}…${accountId.slice(-4)}`
}

/** Header names Podium uses to carry the MCP auth bearer. codex 0.144.5's rmcp
 *  Streamable-HTTP client must receive this as a FIRST-CLASS `bearer_token_env_var`
 *  (see below) — a raw `http_headers` bearer makes it attempt OAuth and die. */
const CODEX_AUTH_HEADERS = new Set(['x-podium-mcp-token', 'authorization'])

const codexCredentialAbsenceGrace = new CodexCredentialAbsenceGrace()

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
/**
 * EXPORTED FOR THE APP-SERVER DRIVER (POD-1761 W6), not widened for it.
 *
 * The `-c` mechanism below is the one verified against codex 0.144.5, and the
 * app-server child mounts MCP servers exactly the same way an `exec` run does —
 * so the driver's daemon host calls THIS rather than growing a second
 * translation that would drift from it on the first field Codex renames. The
 * `context` argument is what distinguishes their error text and nothing else.
 */
export function codexMcpArgs(
  mcpConfig: string | undefined,
  context: 'harness' | 'headless' | 'app-server',
): { args: string[]; env: Record<string, string> } {
  if (!mcpConfig) return { args: [], env: {} }
  let servers: Record<string, { url?: string; headers?: Record<string, string> }>
  try {
    servers = (JSON.parse(mcpConfig) as { mcpServers?: typeof servers }).mcpServers ?? {}
  } catch {
    if (context === 'headless') {
      throw new Error('malformed MCP config for codex — refusing a tool-less headless turn')
    }
    log.warn('malformed MCP config for codex — refusing a tool-less run', { context })
    throw new Error(`malformed MCP config for codex — refusing a tool-less ${context} run`)
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
export function codexTranscriptPlacement(
  home: string,
  relativeDir: string | undefined,
  filename: string,
): string {
  const safeDir = (relativeDir ?? '').split(/[\\/]+/u).filter((part) => part && part !== '..')
  return join(home, '.codex', 'sessions', ...safeDir, basename(filename))
}

export const codexManifest: AgentManifest = {
  kind: 'codex',
  displayName: 'Codex',
  capabilities: {
    argvPrompt: true,
    effortFlag: 'codex-config',
    systemPromptFlag: false,
    newSessionIdFlag: false,
    quota: true,
    cloud: true,
    composerScrape: true,
    oscTitle: false,
    subagentModelEnv: false,
    promptModeHints: false,
    handoff: true,
    mcp: 'full',
    hookInstall: 'global-env',
    observationProvider: 'codex',
    observationProtocol: 'codex-exact',
    submitVerification: false,
    composerReadiness: 'on-bind',
    rawFirstTurn: false,
    exclusiveInteractiveResume: true,
    promptTitleFallback: false,
    mcpConfigTransport: 'inline',
    // Measured against the real 0.150.1 TUI (POD-1733): one Esc mid-turn prints
    // "Conversation interrupted". At an idle prompt it arms "esc again to edit
    // previous message" instead of exiting the process, so the server can send
    // it without the old Ctrl-C idle guard.
    interruptKey: 'esc',
    interruptQuitsWhenIdle: false,
  },
  resumeKind: 'codex-thread',
  environment: {
    removeInherited: [],
    instanceHome: { variable: 'CODEX_HOME', relativeDir: '.codex' },
  },

  inventory: {
    executable: { names: ['codex'], versionArgs: ['--version'] },
    loginCommandProbe: unsupported('Codex login detection still uses its guarded local auth file'),
    loginCommand: supported({ cmd: 'codex', args: ['login'] }),
    loginIdentity: supported((homeDir, env?: HarnessEnvironment) => {
      try {
        return readIdentityFromAuthContents(readFileSync(codexAuthPath(homeDir, env), 'utf8'))
      } catch {
        return undefined
      }
    }),
    portableCredential: supported({
      files: ['.codex/auth.json'],
      compareFreshness: compareCodexAuthFreshness,
    }),
    // Codex's own precedence, in order: OPENAI_API_KEY, CODEX_API_KEY,
    // CODEX_ACCESS_TOKEN — each ahead of the ChatGPT login in `auth.json`.
    // The app-server host strips a WIDER set (`STRIPPED_CODEX_CREDENTIALS`,
    // `@podium/agent-runtime`), reaching org and base-url as well; those redirect
    // a session rather than re-authenticate it, and this field is only about
    // which account answers.
    /**
     * WHY THE LIST EXISTS: codex PREFERS an inherited API key over the stored
     * ChatGPT login. A daemon carries whatever the operator's shell had, so
     * without the strip a session bills an API account while the operator
     * believes they are demonstrating subscription auth — invisibly, with a
     * working session as the evidence.
     *
     * `OPENAI_BASE_URL` is here though it is not a credential: it redirects the
     * session to a different provider entirely, which is the same silent
     * substitution wearing a different name.
     *
     * THE LAST THREE ARRIVED FROM `STRIPPED_CODEX_CREDENTIALS` (POD-2823). That
     * constant was declared beside the app-server version gate and this array
     * was declared here, and the two had already drifted: every codex spawn that
     * read the MANIFEST — the PTY path, the login probes — was leaving
     * `OPENAI_ORGANIZATION`, `OPENAI_ORG_ID` and `OPENAI_BASE_URL` in the child's
     * environment, while the app-server path stripped them. Same question, two
     * homes, different answers. This is now the only home; the constant reads it.
     *
     * THE STRIP IS THE MECHANISM, NOT THE PROOF. The app-server driver
     * separately asks the server which credential it actually chose
     * (`getAuthStatus`), because codex resolves them from several places and a
     * strip only proves what WE did.
     */
    foreignCredentialEnv: [
      'OPENAI_API_KEY',
      'CODEX_API_KEY',
      'CODEX_ACCESS_TOKEN',
      'OPENAI_ORGANIZATION',
      'OPENAI_ORG_ID',
      'OPENAI_BASE_URL',
    ],
    detectLogin(homeDir, env?: HarnessEnvironment) {
      const path = codexAuthPath(homeDir, env)
      let contents: string
      try {
        contents = readFileSync(path, 'utf8')
      } catch {
        // auth.json is replaced in place. A missing file under an existing
        // .codex directory is a write in progress; a missing directory is a
        // settled structural absence and must be reported immediately.
        return codexCredentialAbsenceGrace.missing(path, existsSync(dirname(path)))
      }
      let file: CodexAuthFile
      try {
        file = JSON.parse(contents) as CodexAuthFile
      } catch {
        return codexCredentialAbsenceGrace.present(path, { state: 'out' })
      }
      const tokens = file.tokens
      if (!tokens?.access_token || !tokens.refresh_token) {
        return codexCredentialAbsenceGrace.present(path, { state: 'out' })
      }
      const account =
        codexProfile(tokens.id_token) ??
        (tokens.account_id
          ? `ChatGPT · ${maskedAccountId(tokens.account_id)}`
          : 'ChatGPT subscription')
      const identity = readIdentityFromAuthContents(contents)
      const freshness = readFreshnessFromAuthContents(contents)
      return codexCredentialAbsenceGrace.present(path, {
        state: 'in',
        account,
        ...(identity ? { identity } : {}),
        ...(freshness !== undefined ? { freshness } : {}),
      })
    },
  },

  launch(opts) {
    // [spec:SP-fccf] Session identity never enters model-visible instructions.
    // Official hooks bind the stable Podium pane id to Codex's native thread id.
    const instructions = composeAgentInstructions(opts.instructions ?? [])
    return {
      cmd: 'codex',
      args: [
        // Codex prompts when a resumed thread's recorded cwd differs from the
        // directory it was launched in. That is normal after a cross-machine
        // handoff: the repository was cloned under a different absolute path.
        // -C is Codex's supported, invocation-scoped choice of the CURRENT
        // directory, so the imported session resumes unattended without
        // persisting a user-wide resume_cwd preference.
        ...(opts.resume ? ['resume', '-C', opts.cwd, opts.resume.value] : []),
        ...(isSet(opts.model) ? ['--model', opts.model] : []),
        ...(isSet(opts.effort) ? ['-c', `model_reasoning_effort=${opts.effort}`] : []),
        ...(instructions ? ['-c', `developer_instructions=${JSON.stringify(instructions)}`] : []),
        // Codex's workspace-write sandbox denies network — including LOOPBACK — and
        // Podium hands every agent a CLI that reaches the daemon over
        // http://127.0.0.1:<relay>. Without this, `podium …` dies with a bare
        // connection refusal for any command the user has not separately approved
        // (approval escalates it out of the sandbox). That asymmetry is what made
        // `podium offer` / `podium worktree` look broken while an already-approved
        // `podium issue` in the same session worked fine.
        '-c',
        'sandbox_workspace_write.network_access=true',
        // `--` ends clap's option parsing; without it a prompt starting with `-`
        // dies as "unexpected argument" before the TUI ever opens [POD-1317].
        // Keep this last — a later arg would be parsed as another positional.
        ...promptArgv(opts.initialPrompt),
      ],
      cwd: opts.cwd,
    }
  },

  exec: supported((opts) => {
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
  }),

  // The one harness where the server family is the default for EVERY auth mode:
  // ChatGPT subscription auth works headless (`~/.codex/auth.json` serves `exec`
  // and `app-server` alike), so there is no auth mode that forces the terminal.
  runtime: {
    server: supported({
      driverId: 'codex-app-server',
      kind: 'jsonrpc',
      spawn: ['codex', 'app-server'],
      /**
       * A PRIVATE PER-SESSION UNIX LISTENER, SHARED WITH THE STOCK TUI.
       *
       * The audit-era stdio host was a valid private engine path, but it could
       * not support `codex resume --remote`. The pinned 0.147.0 listener carries
       * JSON-RPC as WebSocket text frames over Unix and accepts multiple clients,
       * so Podium's driver and the stock TUI now share one app-server process.
       *
       * The socket lives below the instance state root in a 0700 directory and
       * is mode 0600. Those filesystem permissions are the local authentication
       * boundary, so a separate correlation secret is neither accepted by this
       * transport nor required.
       */
      transport: 'unix-socket',
      requiresPerSessionSecret: false,
      // PINNED AGAINST RECORDED FIXTURES, not guessed (W6). Every shape the
      // driver reads was captured from a live 0.147.0 app-server and replays in
      // `packages/agent-runtime/src/drivers/codex/__fixtures__`. The 0.150.1
      // generated bindings and real subscription live suite were compared on
      // 2026-08-29 (POD-3093); `manifest-axis.test.ts` keeps this advertised
      // range equal to the runtime gate.
      versionRange: supported('>=0.147 <0.151'),
      /**
       * `codex resume --remote <socket>` — the stock TUI, joined to the
       * app-server this session is already running.
       *
       * BUILT FROM THIS MANIFEST'S OWN `launch()`, not restated. How codex is
       * told which thread to reopen (`resume -C <cwd> <threadId>`, and the
       * `-C` reason recorded there) is one fact, and a second copy of it here
       * would drift the way this epic keeps finding second copies drift. What
       * is genuinely extra is `--remote`: the address of the per-session Unix
       * listener the TUI dials DIRECTLY.
       *
       * THAT DIRECT DIAL IS ALSO A TEARDOWN OBLIGATION. The stock TUI holds its
       * own writer to the listener, so a client left alive after the control
       * lease is released could push queued keystrokes past the lease gate. The
       * daemon closes every client terminal on release for exactly this reason
       * — unconditionally, so the obligation cannot be lost by asking which
       * harness this is.
       */
      clientTerminal: supported({
        labelToken: 'cx',
        /**
         * NEVER PARKED: the obligation the block above states. The stock TUI
         * holds its own writer to the per-session Unix listener, so a client
         * left warm after the control lease is released could push queued
         * keystrokes straight past the daemon's lease gate. Dropping the
         * daemon's handle would not revoke that writer; only ending the process
         * does.
         */
        parkOnRelease: false,
        launch: ({ cwd, conversation, endpoint }) => {
          const spec = codexManifest.launch({
            cwd,
            resume: { kind: 'codex-thread', value: conversation },
          })
          return {
            ...spec,
            args: [...spec.args, ...(endpoint.address ? ['--remote', endpoint.address] : [])],
          }
        },
      }),
    }),
    embedded: unsupported('Codex ships a server, not a library to host in-process'),
    // The permanent fallback: a protocol break degrades Codex sessions to the
    // terminal driver instead of stranding them (spec §3, churn stance).
    terminal: { driverId: 'generic-pty', sendProof: ['transcript-echo'] },
    // App-server is the default for every LOGGED-IN Codex auth mode when the
    // version probe admits it. A logged-out session needs the PTY's interactive
    // login affordance; the terminal driver also remains the permanent
    // protocol-churn fallback.
    select: (ctx) =>
      selectRuntimeDriver(
        ctx,
        ctx.auth === 'logged-out' ? ['generic-pty'] : ['codex-app-server', 'generic-pty'],
      ),
  },
  headless: supported({
    driver: 'codex-json',
    outputFormat: 'codex-jsonl',
    // First turn: codex mints the thread id, captured from the `--json` event
    // stream (`thread.started`); turns ≥2 thread on via `exec resume <id>`.
    resumeIdAllocation: 'stream-captured',
    noTools: 'unsupported',
    buildExec: supported((opts) => {
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
    }),
  }),

  state: supported(codexStateProvider),
  stateChannels: [
    {
      source: 'hook',
      confidence: 1,
      mechanism: 'Codex native lifecycle hooks (including PermissionRequest)',
    },
    {
      source: 'poll',
      confidence: 0.7,
      mechanism: 'Codex rollout JSONL tail, reconciled with hooks inside this manifest',
      fallbackWhen: 'hooks are absent or the rollout supplies the durable boundary',
    },
  ],

  // Codex state arrives on TWO channels: native hooks (codex ≥0.142, fast +
  // authoritative, the only source for PermissionRequest) via the daemon's
  // shared ingest, and this rollout observer (binding, titles, and the fallback
  // for codex builds/sessions without hooks). `bindHookThread` lets the hook
  // path pin the observer to the thread the hook payload names without
  // restarting a correctly-bound observer on every POST.
  observer: supported((input, host) => {
    // Codex creates its rollout lazily (often at the first prompt), so a
    // reattached observer must still be able to discover by cwd — floored at
    // the session's original spawn time so it can't latch onto an older
    // sibling's rollout. Spawn passes its own start; reattach the persisted one.
    const floor = input.startedAtMs ?? input.createdAtMs
    let observationLease = input.observationLease
    let boundThread = observationLease?.providerSessionId ?? input.resumeValue
    /** UNBRANDED BY DECISION: a provider/harness-native session id, not a Podium SessionId. */
    let pendingRebind: { rebindId: string; providerSessionId: string; lastSentAt: number } | null =
      null
    const discovered = new Map<
      string,
      { path: string; confidence: 'exact' | 'heuristic' | undefined }
    >()
    const publishSession = (
      /** UNBRANDED BY DECISION: a provider/harness-native session id, not a Podium SessionId. */
      providerSessionId: string,
      path: string,
      confidence: 'exact' | 'heuristic' | undefined,
    ): void => {
      boundThread = providerSessionId
      host.onResumeValue(providerSessionId, confidence)
      host.tailFile(path)
    }
    const requestExactRebind = (
      /** UNBRANDED BY DECISION: a provider/harness-native session id, not a Podium SessionId. */
      providerSessionId: string,
      lease: HarnessObservationLease,
    ): void => {
      if (pendingRebind) {
        if (
          pendingRebind.providerSessionId === providerSessionId &&
          Date.now() - pendingRebind.lastSentAt >= 2_000
        ) {
          pendingRebind.lastSentAt = Date.now()
          host.onExactProviderRebind({
            nextProviderSessionId: providerSessionId,
            resumeKind: 'codex-thread',
            rebindId: pendingRebind.rebindId,
          })
        }
        return
      }
      const rebindId = `codex:${lease.bindingVersion}:${lease.observerGeneration}:${providerSessionId}`
      pendingRebind = { rebindId, providerSessionId, lastSentAt: Date.now() }
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
        onEvents: (events) => host.onStateEvents(withStateChannel(events, 'poll')),
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
        if (!leaseChanged) {
          if (ack.result === 'rejected') {
            pendingRebind = { ...pending, lastSentAt: Date.now() }
            host.onExactProviderRebind({
              nextProviderSessionId: pending.providerSessionId,
              resumeKind: 'codex-thread',
              rebindId: pending.rebindId,
            })
          }
          return
        }
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
  }),

  discovery: createCodexConversationProvider(),

  handoffTranscript: supported({
    transcriptPlacement: ({ homeDir, filename, relativeDir }) =>
      codexTranscriptPlacement(homeDir, relativeDir, filename),
    async transcriptForExport({ homeDir, resumeValue }) {
      const found = await resolvePinnedCodexRollout(resumeValue, homeDir)
      if (!found) throw new Error('Codex transcript not found')
      const rel = relative(join(homeDir, '.codex', 'sessions'), dirname(found.path))
      if (rel.startsWith('..')) throw new Error('Codex transcript is outside the sessions root')
      return { path: found.path, ...(rel ? { relativeDir: rel } : {}) }
    },
  }),

  transcript: supported(fileTranscript(chainPaths, codexRecordToItems, codexRuntime)),

  // Codex login goes through auth.openai.com (loopback redirect to :1455);
  // chatgpt.com / platform.openai.com opens are plain links. Unknown hosts
  // fall to the generic heuristic.
  classifyBrowserOpen: supported((url) => {
    const host = url.hostname.toLowerCase()
    if (host === 'auth.openai.com') return { intent: 'login' }
    if (host === 'chatgpt.com' || host === 'platform.openai.com') return { intent: 'link' }
    return undefined
  }),
}

import { resolveOpencodeBin } from '../opencode/cli.js'
import { join } from 'node:path'
import {
  type OpencodeMessagePartRow,
  sliceItemsByAnchor,
  stampOpencodeItems,
  type TranscriptSource,
} from '@podium/transcript'
import { observeOpencodeState, opencodeStateProvider } from '../agent-state/opencode.js'
import { withStateChannel } from '../agent-state/types.js'
import { createOpencodeConversationProvider } from '../discovery/providers/opencode.js'
import { composeAgentInstructions } from '../instructions.js'
import {
  type AgentManifest,
  isSet,
  selectRuntimeDriver,
  supported,
  unsupported,
} from '../manifest.js'
import { detectOpencodeLogin } from '../opencode/auth.js'
import {
  loadOpencodeTranscriptTail,
  openOpencodeDb,
  opencodeDbPathForSession,
} from '../opencode/db.js'

/**
 * Source for opencode. opencode stores transcript "parts" in SQLite ordered by
 * `(time_updated ASC, id ASC)`. A single session's parts are bounded (≤8000, the
 * `loadOpencodeTranscriptTail` cap), so loading them in one indexed query is
 * cheap and IS the bounded read — there is no per-call full-DB scan beyond this
 * one session's capped part list. We then build the full ordered item list and
 * index-slice it in memory, exactly matching `readTranscriptSlice`'s semantics.
 */
/** UNBRANDED BY DECISION: a provider/harness-native session id, not a Podium SessionId. */
export function opencodeDbSource(input: {
  sessionId: string
  homeDir?: string
  databasePath?: string
}): TranscriptSource {
  return {
    readSlice: async (opts) => {
      if (opts.limit <= 0) return { items: [], hasMore: false }
      const db = openOpencodeDb(input.homeDir, input.databasePath)
      if (!db) return { items: [], hasMore: false }
      let rows: OpencodeMessagePartRow[]
      try {
        rows = loadOpencodeTranscriptTail(db, input.sessionId)
      } catch {
        return { items: [], hasMore: false }
      } finally {
        db.close()
      }
      // ASC by (time_updated, id); each part expands to 0..N stamped items in
      // intra-part order, so `all` is the session's full transcript in total order.
      const all = stampOpencodeItems(rows, input.sessionId)
      return sliceItemsByAnchor(all, opts)
    },
  }
}

export const opencodeManifest: AgentManifest = {
  kind: 'opencode',
  displayName: 'opencode',
  capabilities: {
    argvPrompt: false,
    effortFlag: 'variant',
    systemPromptFlag: false,
    newSessionIdFlag: false,
    quota: false,
    cloud: false,
    composerScrape: false,
    oscTitle: true,
    subagentModelEnv: false,
    promptModeHints: false,
    handoff: false,
    mcp: 'none',
    hookInstall: 'none',
    observationProvider: 'none',
    observationProtocol: 'generic',
    submitVerification: false,
    composerReadiness: 'on-bind',
    rawFirstTurn: false,
    exclusiveInteractiveResume: false,
    promptTitleFallback: false,
    mcpConfigTransport: 'none',
    // UNMEASURED (POD-1214): no provider is connected on the host this was
    // written on, so no turn could be started to abort. Esc is the documented
    // key and the pre-POD-1214 behaviour, so this declaration changes nothing
    // for opencode until someone can run the probe.
    interruptKey: 'esc',
    interruptQuitsWhenIdle: false,
  },
  resumeKind: 'opencode-session',
  environment: { removeInherited: [] },

  inventory: {
    executable: {
      names: ['opencode'],
      fallbackCandidates: (machineHome) => [join(machineHome, '.opencode', 'bin', 'opencode')],
      versionArgs: ['--version'],
    },
    // DELIBERATELY a bare name, unlike every other cmd in this file: the daemon binds
    // this one to the current generation's verified executable and command environment
    // (apps/daemon/src/control/session.ts, above bindHarnessLaunch). Resolving here
    // would duplicate that snapshot and let login drift from the executable the rest of
    // the launch uses. Not an oversight — POD-2914.
    loginCommand: supported({ cmd: 'opencode', args: ['auth', 'login'] }),
    loginCommandProbe: unsupported(
      'OpenCode login detection still uses its local authentication database',
    ),
    loginIdentity: unsupported('OpenCode does not expose a stable local account identity yet'),
    portableCredential: unsupported('OpenCode credential portability is not supported yet'),
    // The longest list of the five because opencode is the multi-provider CLI:
    // its config's `{env:VAR}` substitution and per-provider defaults prefer any
    // inherited key over the credential `opencode auth login` stored. Hoisted
    // here from the daemon's opencode server host, which has stripped these
    // since POD-2059 and now reads them off the manifest like every other kind.
    foreignCredentialEnv: [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'OPENAI_API_KEY',
      'OPENROUTER_API_KEY',
      'GEMINI_API_KEY',
      'GOOGLE_GENERATIVE_AI_API_KEY',
      'GROQ_API_KEY',
      'XAI_API_KEY',
      'MISTRAL_API_KEY',
      'DEEPSEEK_API_KEY',
    ],
    detectLogin: detectOpencodeLogin,
  },

  launch(opts) {
    const databasePath = opencodeDbPathForSession({
      homeDir: opts.homeDir,
      podiumSessionId: opts.podiumSessionId,
      resumeValue: opts.resume?.value,
    })
    const base = {
      cmd: resolveOpencodeBin(undefined, opts.env),
      args: [
        ...(opts.resume ? ['--session', opts.resume.value] : []),
        ...(isSet(opts.model) ? ['-m', opts.model] : []),
        ...(isSet(opts.effort) ? ['--variant', opts.effort] : []),
      ],
      cwd: opts.cwd,
      ...(databasePath ? { env: { OPENCODE_DB: databasePath } } : {}),
    }
    const instructions = composeAgentInstructions(opts.instructions)
    if (!instructions) return base
    if (!opts.runtimeDir)
      throw new Error('opencode launch requires an instruction runtime directory')
    const instructionPath = join(opts.runtimeDir, 'podium-instructions.md')
    let config: Record<string, unknown>
    try {
      config = JSON.parse(
        opts.env?.OPENCODE_CONFIG_CONTENT ?? process.env.OPENCODE_CONFIG_CONTENT ?? '{}',
      ) as Record<string, unknown>
    } catch {
      throw new Error('malformed OPENCODE_CONFIG_CONTENT — refusing to discard existing config')
    }
    const configuredInstructions = Array.isArray(config.instructions)
      ? config.instructions.filter((item): item is string => typeof item === 'string')
      : []
    return {
      ...base,
      env: {
        ...(base.env ?? {}),
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          ...config,
          instructions: [...configuredInstructions, instructionPath],
        }),
      },
      files: [{ path: instructionPath, contents: instructions }],
    }
  },

  exec: supported((opts) => {
    const model = opts.model && opts.model !== 'auto' ? opts.model : undefined
    const sys = opts.systemPrompt?.trim() ? opts.systemPrompt.trim() : undefined
    const prompt = sys ? `${sys}\n\n---\n\n${opts.prompt}` : opts.prompt
    return {
      cmd: resolveOpencodeBin(undefined, opts.env),
      args: [
        'run',
        ...(model ? ['-m', model] : []),
        ...(opts.effort && opts.effort !== 'auto' ? ['--variant', opts.effort] : []),
        prompt,
      ],
    }
  }),

  // The PILOT server driver (W5): the simplest protocol to client — HTTP +
  // OpenAPI 3.1 + SSE — and the intended host for background executors on
  // non-Claude/non-Codex models.
  runtime: {
    server: supported({
      driverId: 'opencode-server',
      kind: 'http-sse',
      // THE DAEMON PICKS THE PORT and substitutes it here. `--port 0` works, but
      // reading back which port opencode chose means scraping its stdout banner,
      // and a binding that depends on a log line breaks when the log line does.
      spawn: ['opencode', 'serve', '--port', '<daemon-picked>', '--hostname', '127.0.0.1'],
      // Loopback TCP, so a per-session secret is MANDATORY rather than advisory:
      // every local process and user can reach a loopback port, and this one
      // fronts a credentialed agent (spec §6). W5 verified the mechanism against
      // a live server: HTTP Basic from `OPENCODE_SERVER_USERNAME` /
      // `OPENCODE_SERVER_PASSWORD` in the child's ENV — never argv — and a
      // client without it gets 401 on every route, `/global/health` included.
      transport: 'loopback-tcp',
      requiresPerSessionSecret: true,
      openapiPath: '/doc',
      // PINNED AGAINST RECORDED FIXTURES, not guessed (W5). Every shape the
      // driver reads was captured from 1.18.16 and replays in
      // `packages/agent-runtime/src/drivers/opencode/__fixtures__`; the gate that
      // enforces this range is `gateOpencodeVersion`, and widening it means
      // re-recording those fixtures first.
      versionRange: supported('>=1.18 <1.25'),
      /**
       * `opencode attach <url> --session <id>` — the stock TUI, pointed at the
       * loopback server this session is already running.
       *
       * NOT `launch()`. The interactive spawn STARTS a conversation; this JOINS
       * one that a headless server already owns, which is a different verb with
       * a different argv, and the only place either shape is written down.
       *
       * `--session` IS WHAT MAKES IT AN ATTACH. Without it the TUI opens a
       * different conversation on the same server — a screen showing someone
       * else's chat, which is worse than a refusal.
       *
       * THE SECRET RIDES IN THE ENV, NEVER ARGV, exactly as `spawn` above says
       * for the server half. `requiresPerSessionSecret` is true for this
       * transport, so the endpoint always carries credentials and a client
       * without them gets 401 on every route.
       */
      clientTerminal: supported({
        labelToken: 'oc',
        /**
         * PARKED ON A SWITCH BACK TO CHAT, NOT KILLED (POD-3045).
         *
         * `opencode attach` reaches its engine over the same authenticated
         * loopback HTTP the driver uses, and the only thing that can type into
         * it is the daemon's own client handle. Dropping that handle already
         * revokes the writer the control lease cares about, so the process does
         * not have to die for the lease to mean something — which is the
         * distinction codex's `parkOnRelease: false` is making right next door.
         *
         * KILLING IT COST THE CLI ITS KEYBOARD. Every switch into Native then
         * cold-started this TUI, and opencode's own startup DISCARDS whatever
         * arrives at stdin part-way through it: typed at ~1.2–1.5s after the
         * client PTY exists — which is exactly when a viewer who just switched
         * types — the bytes are swallowed and never echo, while the fresh
         * interface paints tens of KB and makes the terminal look alive. A
         * parked master is past that window, so the reconnect adopts a TUI that
         * is already listening, and it keeps its scrollback because an adopted
         * generation is not reset.
         */
        parkOnRelease: true,
        launch: ({ cwd, conversation, endpoint, env }) => ({
          cmd: resolveOpencodeBin(undefined, env),
          args: ['attach', endpoint.address ?? '', '--session', conversation],
          cwd,
          env: {
            ...(endpoint.username ? { OPENCODE_SERVER_USERNAME: endpoint.username } : {}),
            ...(endpoint.secret ? { OPENCODE_SERVER_PASSWORD: endpoint.secret } : {}),
          },
        }),
      }),
    }),
    serverAlternatives: [
      {
        driverId: 'opencode2-server',
        kind: 'http-sse',
        spawn: ['opencode2', 'serve', '--port', '<daemon-picked>', '--hostname', '127.0.0.1'],
        transport: 'loopback-tcp',
        requiresPerSessionSecret: true,
        openapiPath: '/openapi.json',
        versionRange: supported('=0.0.0-beta-18743'),
        clientTerminal: supported({
          labelToken: 'oc2',
          parkOnRelease: true,
          launch: ({ cwd, conversation, endpoint }) => ({
            cmd: 'opencode2',
            args: ['mini', '--server', endpoint.address ?? '', '--session', conversation],
            cwd,

            env: {
              ...(endpoint.secret ? { OPENCODE_SERVER_PASSWORD: endpoint.secret } : {}),
            },
          }),
        }),
      },
    ],
    embedded: unsupported('opencode ships a server, not a library to host in-process'),
    terminal: {
      driverId: 'generic-pty',
      sendProof: ['transcript-echo'],
      lifecycleFromState: true,
    },
    // The server is the default whenever its version probe admits this machine
    // AND inventory says the harness is logged in. The PTY owns interactive
    // login, so a logged-out default must land there instead of starting a
    // headless server that has no login affordance.
    select: (ctx) =>
      selectRuntimeDriver(
        ctx,
        ctx.auth === 'logged-out'
          ? ['generic-pty']
          : ['opencode-server', 'opencode2-server', 'generic-pty'],
      ),
  },
  headless: supported({
    driver: 'resume-exec',
    outputFormat: 'opencode-jsonl',
    // First turn has no id (opencode mints ses_… internally; captured from the
    // --format json event stream); later turns pin with -s.
    resumeIdAllocation: 'stream-captured',
    noTools: 'unsupported',
    buildExec: supported((opts) => {
      const model = opts.model && opts.model !== 'auto' ? opts.model : undefined
      const sys = opts.systemPrompt?.trim()
      const context = opts.contextPrompt?.trim()
      const prompt = [sys, context, opts.prompt].filter(Boolean).join('\n\n---\n\n')
      return {
        cmd: resolveOpencodeBin(undefined, opts.env),
        args: [
          'run',
          '--format',
          'json',
          ...(opts.resumeValue ? ['-s', opts.resumeValue] : []),
          ...(model ? ['-m', model] : []),
          ...(opts.effort && opts.effort !== 'auto' ? ['--variant', opts.effort] : []),
          prompt,
        ],
      }
    }),
  }),

  state: supported(opencodeStateProvider),
  stateChannels: [
    {
      source: 'poll',
      confidence: 0.7,
      mechanism: 'OpenCode SQLite session/message polling',
    },
  ],

  // No hook channel and no file to tail (SQLite store): the observer polls the
  // DB, discovers the session, and pushes live transcript items itself. Items
  // are already cursor-stamped (stampOpencodeItems), so the live delta carries
  // the same cursors the on-demand read produces.
  observer: supported((input, host) => {
    const obs = observeOpencodeState({
      cwd: input.cwd,
      ...(input.podiumSessionId ? { podiumSessionId: input.podiumSessionId } : {}),
      ...(input.statTick ? { statTick: input.statTick } : {}),
      ...(input.resumeValue ? { resumeValue: input.resumeValue } : {}),
      ...(input.homeDir ? { homeDir: input.homeDir } : {}),
      ...(input.startedAtMs !== undefined ? { startedAtMs: input.startedAtMs } : {}),
      onSession: (opencodeSessionId) => host.onResumeValue(opencodeSessionId),
      onModel: (model, effort) => host.onModel?.(model, effort),
      onEvents: (events) => host.onStateEvents(withStateChannel(events, 'poll')),
      onTranscriptItems: (items, reset) => host.onTranscriptItems(items, reset),
    })
    return { stop: () => obs.stop() }
  }),

  discovery: createOpencodeConversationProvider(),

  transcript: supported({
    // SQLite-backed — no file chain; the DB adapter serves the same cursor
    // contract as the chain reader.
    storage: 'sqlite',
    recordToItems: unsupported('opencode maps typed SQLite rows rather than native JSONL records'),
    recordRuntime: unsupported('opencode reports no model, effort or context use in its records'),
    chainPaths: unsupported('opencode stores transcripts in SQLite — there are no files to chain'),
    async sourceFor(input) {
      // No resume value → nothing to read; hand back an inert empty source so
      // the caller need not special-case it.
      if (!input.resumeValue) {
        return { readSlice: async () => ({ items: [], hasMore: false }) }
      }
      const databasePath = opencodeDbPathForSession({
        homeDir: input.homeDir,
        podiumSessionId: input.podiumSessionId,
        resumeValue: input.resumeValue,
      })
      return opencodeDbSource({
        sessionId: input.resumeValue,
        ...(input.homeDir !== undefined ? { homeDir: input.homeDir } : {}),
        ...(databasePath ? { databasePath } : {}),
      })
    },
  }),

  handoffTranscript: unsupported('cross-machine handoff is not supported for opencode sessions'),

  classifyBrowserOpen: unsupported(
    'no catalogued opencode login/link domains yet — the daemon generic redirect_uri heuristic decides (POD-738)',
  ),
}

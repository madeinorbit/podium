import { randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { trpcServer } from '@hono/trpc-server'
import { loadConfig } from '@podium/core/config'
import { startLoopMetrics } from '@podium/core/loop-metrics'
import { MIN_SUPPORTED_VERSION, WIRE_VERSION } from '@podium/protocol'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { clientAuthGuard, isRequestAuthed, registerAuthRoute } from './auth-route'
import { applyEnvPassword, hasPassword } from './auth-store'
import { registerAssetRoute } from './file-asset-route'
import { OPERATOR } from './issue-authz'
import type { IssueTrpc } from './issue-client'
import { CompositeMcpProvider, IssueToolProvider } from './issue-mcp'
import { readOrCreateDaemonSecret, stateDir } from './local-machine'
import { registerMcpRoute } from './mcp-route'
import { probeAllModels } from './model-probe'
import { SessionRegistry } from './relay'
import { RepoRegistry } from './repo-registry'
import { appRouter } from './router'
import { registerSetupRoute } from './setup-route'
import { registerWebStatic } from './static-web'
import { SessionStore } from './store'
import { SuperagentService } from './superagent'
import { readOwnDaemonMachineId, UpstreamSync } from './upstream'
import { UpstreamForwarder } from './upstream-forwarder'
import { attachWebSockets } from './wsServer'

/** Adapt an in-process tRPC `createCaller` caller to the `IssueTrpc` HTTP-client shape the
 *  shared issue command registry calls (`.<router>.<proc>.mutate|query(input)`). Both `.mutate`
 *  and `.query` map to a direct caller invocation — no HTTP round-trip, no login-cookie gate. */
export function callerAsIssueTrpc(caller: ReturnType<typeof appRouter.createCaller>): IssueTrpc {
  const rec = caller as unknown as Record<
    string,
    Record<string, (i: unknown) => Promise<unknown>> | undefined
  >
  const invoke = (router: string, proc: string, input: unknown): Promise<unknown> => {
    const fn = rec[router]?.[proc]
    if (!fn) throw new Error(`no such issue procedure: ${router}.${proc}`)
    return fn(input)
  }
  const procProxy = (router: string) =>
    new Proxy(
      {},
      {
        get: (_t, proc) => {
          if (typeof proc !== 'string') return undefined
          const call = (input: unknown) => invoke(router, proc, input)
          return { mutate: call, query: call }
        },
      },
    )
  return new Proxy(
    {},
    { get: (_t, router) => (typeof router === 'string' ? procProxy(router) : undefined) },
  ) as unknown as IssueTrpc
}

/**
 * Thrown (as a rejection) by {@link startServer} when the chosen port is already
 * bound — typically a second `podium` fighting the systemd podium-server for :18787.
 * A typed, port-carrying error lets the CLI print friendly guidance instead of leaking
 * a raw EADDRINUSE stack trace.
 */
export class PortInUseError extends Error {
  readonly code = 'EADDRINUSE' as const
  constructor(
    readonly port: number,
    options?: { cause?: unknown },
  ) {
    super(`port ${port} is already in use`, options)
    this.name = 'PortInUseError'
  }
}

/** True for a failed-listen "address in use" error, whether ours or a raw runtime errno. */
export function isAddressInUseError(err: unknown): boolean {
  if (err instanceof PortInUseError) return true
  return (
    typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'EADDRINUSE'
  )
}

export interface ServerHandle {
  port: number
  registry: SessionRegistry
  /**
   * The persistent same-host shared secret the bundled local daemon presents (as its
   * `hello` token) to authenticate as the local machine. Exposed so the in-process
   * daemon (host.ts) can pass it straight through without re-reading the file.
   */
  bootstrapToken: string
  close(): Promise<void>
}

/**
 * Resolve the interface to bind. Defaults to loopback (127.0.0.1) so a fresh/open-source
 * install is NOT reachable from the LAN/internet out of the box — reaching the server lets
 * a caller drive agents that hold the user's OAuth creds and a shell. Exposing it on the
 * network is a deliberate opt-in via PODIUM_HOST (e.g. 0.0.0.0), and should be paired with
 * a login password (see the open-exposure warning in startServer).
 */
export function resolveBindHost(
  opts: { host?: string },
  env: NodeJS.ProcessEnv = process.env,
): string {
  return opts.host ?? env.PODIUM_HOST ?? '127.0.0.1'
}

/** Whether a bind host stays on the local machine (no network exposure). */
export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost'
}

/** Machine-readable version probe — distinct from /health (which stays plaintext "ok"). */
export function registerVersionRoute(app: Hono): void {
  app.get('/version', (c) =>
    c.json({
      wireVersion: WIRE_VERSION,
      minSupportedVersion: MIN_SUPPORTED_VERSION,
      appVersion: process.env.PODIUM_APP_VERSION ?? 'dev',
    }),
  )
}

export async function startServer(
  opts: { port?: number; host?: string } = {},
): Promise<ServerHandle> {
  // Headless seam: a non-interactive deploy can set the login password via PODIUM_PASSWORD.
  // One-shot (won't overwrite an existing one); must run before the open-exposure check below.
  await applyEnvPassword()
  const store = new SessionStore()
  // The transcript lake lives in the state dir next to podium.db (transcript-mirror
  // spec §2.1). Passing the dir opts the registry into mirroring; tests that construct
  // SessionRegistry without it produce no mirror traffic.
  const registry = new SessionRegistry(store, undefined, {
    mirrorLakeDir: join(stateDir(), 'transcripts'),
    // Live model enumeration shells out to the agent CLIs, so it's only wired in the
    // real process; tests get the empty default and never spawn a CLI. The claude list
    // matches the agent's auth: an Anthropic API key (env or the existing
    // `apiKeys.anthropic` setting) for API-based Claude, else the OAuth login — no new
    // setting. Read fresh each refresh so a settings change takes effect.
    modelProbe: () =>
      probeAllModels({
        claude: {
          apiKey:
            process.env.ANTHROPIC_API_KEY || store.getSettings().apiKeys.anthropic || undefined,
        },
      }),
  })
  // The persistent same-host shared secret, read (or created 0600) from the state dir.
  // The server hashes it into the local machine's stored credential below; the bundled
  // local daemon reads the SAME file (or, in-process, gets this value via ServerHandle)
  // and presents it as its `hello` token — so the local daemon authenticates with no
  // pairing step and no per-boot token race.
  const bootstrapToken = readOrCreateDaemonSecret()
  // Provision the local machine NOW, at startup: register it with the server-owned
  // credential (sha256 of the shared secret) and adopt any pre-existing `'__local__'`
  // rows onto it — so a single-machine install's sessions/repos are attributed and
  // visible regardless of whether/when the daemon connects. This is the structural guard
  // against the regression where data vanished because no daemon ever registered. The
  // same-host daemon then authenticates through the normal hello path (wsServer).
  registry.ensureLocalMachine(hostname(), bootstrapToken)
  // Node⇄hub sync (docs/spec/node-hub-sync.md): when config.json carries `upstream`,
  // this server is a NODE and mirrors its hub's fleet through the thin-client
  // protocol. No upstream config = the constructor never runs = zero new behavior.
  let upstreamSync: UpstreamSync | undefined
  let upstreamForwarder: UpstreamForwarder | undefined
  const upstreamConfig = loadConfig().upstream
  if (upstreamConfig) {
    const ownMachineId = readOwnDaemonMachineId()
    if (ownMachineId) registry.setUpstreamOwnMachineIds([ownMachineId])
    // P7b write path (docs/spec/node-hub-issues.md §2.2): issue mutations targeting
    // viaHub issues forward to the hub with the SAME token, durably queued while it
    // is unreachable. Drain triggers: enqueue (forwarder-internal), flat retry
    // (forwarder-internal), and upstream (re)connect (onConnected below).
    upstreamForwarder = new UpstreamForwarder({
      url: upstreamConfig.url,
      token: upstreamConfig.token,
      store,
      onQueueChanged: () => registry.upstreamOutboxChanged(),
    })
    registry.setUpstreamForwarder(upstreamForwarder)
    const forwarder = upstreamForwarder
    upstreamSync = new UpstreamSync({
      url: upstreamConfig.url,
      token: upstreamConfig.token,
      mirror: registry,
      store,
      onConnected: () => void forwarder.drain(),
    })
    upstreamSync.start()
  }
  const repos = new RepoRegistry(registry, store)
  const superagent = new SuperagentService(registry, repos, store)
  // The daemon issue-relay seam: run a relayed agent op through a capability-scoped tRPC
  // caller so the issueCapabilityGuard middleware enforces the agent's subtree scope. Injected
  // here (not in relay.ts) to keep relay.ts free of the appRouter import cycle.
  registry.makeIssueCaller = (capability, overrideScope) =>
    appRouter.createCaller({
      registry,
      repos,
      superagent,
      capability,
      overrideScope,
    }) as unknown as {
      [router: string]: Record<string, (i: unknown) => Promise<unknown>> | undefined
    }
  const app = new Hono()
  app.get('/health', (c) => c.text('ok'))
  registerVersionRoute(app)
  // The setup UI fetches /setup/config from the desktop webview, whose origin (tauri://localhost)
  // differs from the local server — same cross-origin case as /trpc. Without CORS the fetch is
  // blocked and SetupGate's catch() silently skips onboarding. Must precede the route handler.
  // Gate the human-client data plane (/trpc, /files) behind the login session whenever a
  // password is configured; open otherwise (loopback / all-in-one, or the user opted out).
  // The static SPA shell, /auth/*, GET /setup/config, /health and /version stay open so the
  // login screen can load. Setup WRITES live under /trpc (setup.*), so they're covered by the
  // /trpc guard below. The /daemon link and /mcp keep their own credentials. Guards are
  // registered BEFORE their handlers so Hono runs them first.
  const guard = clientAuthGuard({ store })
  app.use('/setup/*', cors())
  registerSetupRoute(app)
  // Human-client login (web/desktop UI). Same cross-origin reason as /setup: the desktop
  // webview's origin differs from the server in the all-in-one case. Login itself is
  // same-origin in the supported network topologies; the password store gates it.
  app.use('/auth/*', cors())
  registerAuthRoute(app, { store })
  app.use('/files/*', guard)
  registerAssetRoute(app, registry)
  // In-process MCP server exposing the superagent's orchestrator tools to a
  // harness-backed superagent (Claude via --mcp-config). Token-gated.
  // One `podium` MCP surface composes the superagent's tools (first, so they win
  // name collisions) with the native issue-tracker tools.
  const mcpToken = randomUUID()
  const issueTools = new IssueToolProvider()
  const mcpProvider = new CompositeMcpProvider([superagent, issueTools])
  // Calls dispatch through the superagent (NOT the composite): its tool belt already
  // bridges the issue tools, so the concierge confirmed-gate and thread provenance
  // wrap issue_* tools too — the exact same path the API tool loop takes (issue #67).
  // Specs still come from the composite (superagent excludes the bridged issue specs).
  registerMcpRoute(
    app,
    {
      mcpToolSpecs: () => mcpProvider.mcpToolSpecs(),
      callMcpTool: (name, args, threadId) => superagent.callMcpTool(name, args, threadId),
    },
    mcpToken,
    // The per-thread token each harness invocation's mcp-config carries (issue #67).
    { resolveThread: (token) => superagent.threadForMcpToken(token) },
  )
  app.use('/trpc/*', cors())
  app.use('/trpc/*', guard)
  app.use(
    '/trpc/*',
    trpcServer({
      router: appRouter,
      // Everyone who reaches /trpc is the OPERATOR: the login session (clientAuthGuard
      // above) already authenticated the human, so the tracker grants full authority — no
      // separate tracker credential. Constrained agents don't come through here; they are
      // relayed via their daemon and carry their own capability (agent integration).
      createContext: () => ({ registry, repos, superagent, capability: OPERATOR }),
    }),
  )

  // Serve the built web UI for external clients (browser/phone/other desktop). The
  // packaged headless bundle sets PODIUM_WEB_DIR; a source run defaults to apps/web/dist.
  // In a `bun build --compile` binary import.meta.url is not a file:// URL, so guard the
  // default — an unset PODIUM_WEB_DIR there simply means "API only", never a crash.
  let webDir = process.env.PODIUM_WEB_DIR
  if (!webDir) {
    try {
      webDir = fileURLToPath(new URL('../../web/dist', import.meta.url))
    } catch {
      webDir = ''
    }
  }
  if (webDir) registerWebStatic(app, webDir)

  const host = resolveBindHost(opts)
  // If we're reachable off-box but no login password is set, the data plane is wide open
  // to anyone who can route to this host. Surface that loudly rather than failing silently.
  if (!isLoopbackHost(host) && !hasPassword()) {
    console.warn(
      `[podium] server bound to ${host} (network-reachable) with NO login password set — ` +
        'anyone who can reach this host can control your agents and shell. ' +
        'Set a password in setup, or bind to 127.0.0.1.',
    )
  }

  const requestedPort = opts.port ?? 0
  return new Promise<ServerHandle>((resolve, reject) => {
    // serve() from @hono/node-server registers no 'error' handler of its own. A failed
    // listen() (e.g. the port is already held by the systemd podium-server) then surfaces
    // differently per runtime: Bun throws synchronously out of serve(); Node emits an
    // async 'error' event on the underlying server. Left unhandled, either becomes a
    // swallowed uncaughtException while this promise hangs forever. Catch BOTH and turn
    // them into a clean rejection, disposing the half-built store so we don't leak a DB
    // handle or its flush timer. `settled` guards against a post-listen socket 'error'
    // being mistaken for a bind failure (and against double-settling).
    let settled = false
    const failListen = (err: unknown): void => {
      if (settled) return
      settled = true
      upstreamSync?.stop()
      upstreamForwarder?.stop()
      registry.dispose()
      store.close()
      reject(
        isAddressInUseError(err)
          ? new PortInUseError(requestedPort, { cause: err })
          : (err as Error),
      )
    }

    let server: ReturnType<typeof serve>
    try {
      server = serve({ fetch: app.fetch, port: requestedPort, hostname: host }, (info) => {
        if (settled) return
        settled = true
        // The harness agent runs on the same host (single-machine), so loopback
        // reaches this MCP route. Now that the port is known, point it there.
        superagent.setMcpEndpoint(
          `http://127.0.0.1:${info.port}/mcp`,
          mcpToken,
          mcpProvider.mcpToolSpecs().map((s) => s.name),
        )
        // The in-process MCP issue surface is the trusted superagent orchestrator. It calls the
        // router DIRECTLY (not the cookie-gated HTTP /trpc, which would 401 it) as the OPERATOR.
        // The shared command registry expects an IssueTrpc client (.<router>.<proc>.mutate/query);
        // adapt a createCaller caller to that shape. This is also the seam for per-agent
        // capabilities later: pass a constrained capability instead of OPERATOR.
        const caller = appRouter.createCaller({ registry, repos, superagent, capability: OPERATOR })
        issueTools.setClient(callerAsIssueTrpc(caller))
        // Bridge the issue tools into the superagent's API tool loop (issue #64):
        // concierge (and global) threads drive the tracker through the same
        // in-process OPERATOR caller. Constraining this to an agent capability is
        // future work (same seam as above).
        superagent.setIssueTools(issueTools)
        const ws = attachWebSockets(server as unknown as Server, registry, {
          // Same gate as the HTTP guard: open unless a password is set, then require a valid
          // session cookie on the upgrade request.
          authorizeClient: (req) => !hasPassword() || isRequestAuthed(store, req.headers.cookie),
        })
        if (process.env.PODIUM_LOOP_PROFILE) startLoopMetrics({ label: 'server' })
        resolve({
          port: info.port,
          registry,
          bootstrapToken,
          close: () =>
            ws.close().then(
              () =>
                new Promise<void>((res) => {
                  ;(server as unknown as Server).close(() => {
                    // Stop the upstream sync loop + outbox drain BEFORE the store
                    // closes — a late cursor/issue/outbox write against a closed DB
                    // would throw.
                    upstreamSync?.stop()
                    upstreamForwarder?.stop()
                    // Persist the last dirty activity timestamps while the DB is still
                    // open, then stop the periodic flush timer (so a tick can't fire an
                    // upsertSession against a closed DB), and only then close the store.
                    registry.flushActivity()
                    registry.dispose()
                    store.close()
                    res()
                  })
                }),
            ),
        })
      })
      // Node surfaces a failed listen() as an async 'error' event (Bun throws above).
      ;(server as unknown as Server).on('error', failListen)
    } catch (err) {
      failListen(err)
    }
  })
}

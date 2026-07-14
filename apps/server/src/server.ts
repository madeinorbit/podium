import { randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { trpcServer } from '@hono/trpc-server'
import { MIN_SUPPORTED_VERSION, WIRE_VERSION } from '@podium/protocol'
import { loadConfig } from '@podium/runtime/config'
import { startLoopMetrics } from '@podium/runtime/loop-metrics'
import { readOwnDaemonMachineId, UpstreamForwarder, UpstreamSync } from '@podium/sync'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { clientAuthGuard, isRequestAuthed, registerAuthRoute } from './auth-route'
import { applyEnvPassword, hasPassword } from './auth-store'
import { createCloudRuntimeProviderFromEnv } from './cloud-runtime'
import { registerAssetRoute } from './file-asset-route'
import { PairingManager } from './hub/pairing'
import { OPERATOR } from './issue-authz'
import { IssueToolProvider } from './issue-mcp'
import { readOrCreateDaemonSecret, stateDir } from './local-machine'
import { registerMcpRoute } from './mcp-route'
import { probeAllModels } from './model-probe'
import { SuperagentService } from './modules/superagent'
import type { PodiumPlugin } from './plugins'
import { SessionRegistry, upstreamMirrorFor } from './relay'
import { RepoRegistry } from './repo-registry'
import { resolveServerRole, type ServerRoleConfig } from './roles'
import { appRouter } from './router'
import { registerSetupRoute } from './setup-route'
import { registerMobileRouting, registerWebStatic } from './static-web'
import { SessionStore } from './store'
import { attachWebSockets } from './wsServer'

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
  opts: {
    port?: number
    host?: string
    role?: Partial<ServerRoleConfig>
    /** Build-time extensions (the cloud seam — plugins.ts). OSS ships none. */
    plugins?: PodiumPlugin[]
  } = {},
): Promise<ServerHandle> {
  // Headless seam: a non-interactive deploy can set the login password via PODIUM_PASSWORD.
  // One-shot (won't overwrite an existing one); must run before the open-exposure check below.
  await applyEnvPassword()
  // Role composition (roles.ts): which optional module groups this process
  // activates. Explicit opts win; else `upstream` in config.json makes this a
  // NODE (hub surfaces off); else the historical all-in-one shape: core + hub.
  const config = loadConfig()
  const role = resolveServerRole(opts.role, config)
  const store = new SessionStore()
  // The transcript lake lives in the state dir next to podium.db (transcript-mirror
  // spec §2.1). Passing the dir opts the registry into mirroring; tests that construct
  // SessionRegistry without it produce no mirror traffic.
  const registry = new SessionRegistry(store, undefined, {
    mirrorLakeDir: join(stateDir(), 'transcripts'),
    // Inbound daemon pairing is a HUB capability, injected here (the composition
    // root) so core (relay/machines) never imports hub/pairing — see roles.ts.
    // Node role = no manager = `pair` handshakes rejected, minting throws; the
    // local daemon's `hello` path is untouched.
    ...(role.hub ? { pairing: new PairingManager() } : {}),
    // Live model enumeration shells out to the agent CLIs, so it's only wired in the
    // real process; tests get the empty default and never spawn a CLI. The claude list
    // matches the agent's auth: an Anthropic API key (env or the existing
    // `apiKeys.anthropic` setting) for API-based Claude, else the OAuth login — no new
    // setting. Read fresh each refresh so a settings change takes effect.
    // TODO(#251-followup): fold this env+settings-row dual-source (and the other
    // settings-coupled env reads: PODIUM_WEB_DIR/PODIUM_MOBILE_WEB_DIR bundle-path
    // fallbacks below, PODIUM_HOST/PODIUM_PASSWORD, PODIUM_LOOP_PROFILE, PODIUM_CLOUD_*)
    // into the server-side layer of the @podium/runtime/config resolver.
    modelProbe: () =>
      probeAllModels({
        claude: {
          apiKey:
            process.env.ANTHROPIC_API_KEY ||
            store.settings.getSettings().apiKeys.anthropic ||
            undefined,
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
  registry.modules.machines.ensureLocalMachine(hostname(), bootstrapToken)
  // Node⇄hub sync (docs/spec/node-hub-sync.md): when config.json carries `upstream`,
  // this server is a NODE and mirrors its hub's fleet through the thin-client
  // protocol. No upstream config = the constructor never runs = zero new behavior.
  let upstreamSync: UpstreamSync | undefined
  let upstreamForwarder: UpstreamForwarder | undefined
  const upstreamConfig = config.upstream
  if (upstreamConfig) {
    const ownMachineId = readOwnDaemonMachineId()
    if (ownMachineId) registry.modules.sessions.setUpstreamOwnMachineIds([ownMachineId])
    // P7b write path (docs/spec/node-hub-issues.md §2.2): issue mutations targeting
    // viaHub issues forward to the hub with the SAME token, durably queued while it
    // is unreachable. Drain triggers: enqueue (forwarder-internal), flat retry
    // (forwarder-internal), and upstream (re)connect (onConnected below).
    upstreamForwarder = new UpstreamForwarder({
      url: upstreamConfig.url,
      token: upstreamConfig.token,
      store: store.sync,
      onQueueChanged: () => registry.modules.upstreamIssues.outboxChanged(),
      // A queued mutation the hub definitively rejects must be SURFACED, not just
      // logged (#25): durable issue.upstream_rejected event + overlay retirement.
      onPoisoned: (proc, input, message) =>
        registry.modules.upstreamIssues.mutationRejected(proc, input, message),
    })
    registry.modules.upstreamIssues.setForwarder(upstreamForwarder)
    const forwarder = upstreamForwarder
    upstreamSync = new UpstreamSync({
      url: upstreamConfig.url,
      token: upstreamConfig.token,
      mirror: upstreamMirrorFor(registry.modules),
      store: store.settings,
      onConnected: () => void forwarder.drain(),
    })
    upstreamSync.start()
  }
  const repos = new RepoRegistry(registry, store)
  const superagent = new SuperagentService(registry.modules, repos, store)
  const cloud = createCloudRuntimeProviderFromEnv()
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
  const guard = clientAuthGuard({ store: store.auth })
  app.use('/setup/*', cors())
  registerSetupRoute(app)
  // Human-client login (web/desktop UI). Same cross-origin reason as /setup: the desktop
  // webview's origin differs from the server in the all-in-one case. Login itself is
  // same-origin in the supported network topologies; the password store gates it.
  app.use('/auth/*', cors())
  registerAuthRoute(app, { store: store.auth })
  app.use('/files/*', guard)
  registerAssetRoute(app, { readAsset: (a) => registry.modules.rpc.readAsset(a) })
  // In-process MCP server exposing the superagent's orchestrator tools to a
  // harness-backed superagent (Claude via --mcp-config). Token-gated.
  // One `podium` MCP surface composes the superagent's tools (first, so they win
  // name collisions) with the native issue-tracker tools.
  const mcpToken = randomUUID()
  const issueTools = new IssueToolProvider()
  // Both specs AND calls dispatch through the superagent: its tool belt bridges the
  // issue tools, so the concierge confirmed-gate and thread provenance wrap issue_*
  // tools too — the exact same path the API tool loop takes (issue #67). Specs must
  // come from the same path so the advertised schemas carry the gate's `confirmed`
  // param (a composite serving the issue provider's raw specs hid it, and
  // schema-strict harness clients stripped the flag — the gate was unsatisfiable).
  registerMcpRoute(
    app,
    {
      mcpToolSpecs: (threadId) => superagent.mcpToolSpecs(threadId),
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
      // Error funnel: every failed /trpc call leaves a server-side trace (proc +
      // code + message — no payloads). Without this, 500s (INTERNAL_SERVER_ERROR)
      // were completely invisible in the server log.
      onError: ({ error, path, type }) => {
        console.warn(
          `[trpc] ${type} ${path ?? '<unknown>'} failed: ${error.code} — ${error.message}`,
        )
      },
      // Everyone who reaches /trpc is the OPERATOR: the login session (clientAuthGuard
      // above) already authenticated the human, so the tracker grants full authority — no
      // separate tracker credential. Constrained agents don't come through here; they are
      // relayed via their daemon and carry their own capability (agent integration).
      createContext: () => ({
        registry,
        repos,
        superagent,
        cloud,
        capability: OPERATOR,
        modules: registry.modules,
        // Hub-only procs (machines fleet admin + pairing) 404 when the hub
        // role is off — see the hubProc guard in router.ts.
        role,
      }),
    }),
  )

  // Build-time extensions (plugins.ts — the cloud seam): registered after every
  // core surface so a plugin can't shadow one, and BEFORE the static SPA
  // catch-alls below so plugin routes are reachable at all. Awaited in order;
  // a failing plugin aborts startup loudly rather than half-composing.
  for (const plugin of opts.plugins ?? []) {
    await plugin.register({ hono: app, modules: registry.modules, bus: registry.bus, config, role })
  }

  // Serve the built web UIs for external clients (browser/phone/other desktop). The
  // packaged headless bundle sets PODIUM_WEB_DIR; source runs default to apps/web/dist,
  // and the Expo mobile web build defaults to apps/mobile/dist under /mobile.
  // In a `bun build --compile` binary import.meta.url is not a file:// URL, so guard the
  // defaults — an unset dir there simply means "API only" for that SPA, never a crash.
  let mobileWebDir = process.env.PODIUM_MOBILE_WEB_DIR
  if (!mobileWebDir) {
    try {
      mobileWebDir = fileURLToPath(new URL('../../mobile/dist', import.meta.url))
    } catch {
      mobileWebDir = ''
    }
  }
  const expoMobileServed = mobileWebDir
    ? registerWebStatic(app, mobileWebDir, { basePath: '/mobile' })
    : false
  registerMobileRouting(app, { expoMobileServed })

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
        // The in-process MCP issue surface is the trusted superagent orchestrator. It calls
        // the issue command registry DIRECTLY (not the cookie-gated HTTP /trpc, which would
        // 401 it) as the OPERATOR — router-equal authz, no router caller involved. This is
        // also the seam for per-agent capabilities later: pass a constrained capability
        // instead of OPERATOR.
        issueTools.setClient(registry.issueCommands.asIssueTrpc(OPERATOR))
        // Bridge the issue tools into the superagent's API tool loop (issue #64):
        // concierge (and global) threads drive the tracker through the same
        // in-process OPERATOR caller. Constraining this to an agent capability is
        // future work (same seam as above). Must precede setMcpEndpoint so the
        // allowed-tool name list below includes the bridged issue tools.
        superagent.setIssueTools(issueTools)
        // The harness agent runs on the same host (single-machine), so loopback
        // reaches this MCP route. Now that the port is known, point it there.
        superagent.setMcpEndpoint(
          `http://127.0.0.1:${info.port}/mcp`,
          mcpToken,
          superagent.mcpToolSpecs().map((s) => s.name),
        )
        const ws = attachWebSockets(server as unknown as Server, registry, {
          // Same gate as the HTTP guard: open unless a password is set, then require a valid
          // session cookie on the upgrade request.
          authorizeClient: (req) =>
            !hasPassword() || isRequestAuthed(store.auth, req.headers.cookie),
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
                    registry.modules.sessions.flushActivity()
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

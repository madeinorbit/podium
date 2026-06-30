import { randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import { hostname } from 'node:os'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { trpcServer } from '@hono/trpc-server'
import { startLoopMetrics } from '@podium/core/loop-metrics'
import { WIRE_VERSION } from '@podium/protocol'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { clientAuthGuard, isRequestAuthed, registerAuthRoute } from './auth-route'
import { hasPassword } from './auth-store'
import { registerAssetRoute } from './file-asset-route'
import { readOrCreateDaemonSecret } from './local-machine'
import { registerMcpRoute } from './mcp-route'
import { SessionRegistry } from './relay'
import { RepoRegistry } from './repo-registry'
import { appRouter } from './router'
import { registerSetupRoute } from './setup-route'
import { registerWebStatic } from './static-web'
import { SessionStore } from './store'
import { SuperagentService } from './superagent'
import { attachWebSockets } from './wsServer'

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
      appVersion: process.env.PODIUM_APP_VERSION ?? 'dev',
    }),
  )
}

export async function startServer(
  opts: { port?: number; host?: string } = {},
): Promise<ServerHandle> {
  const store = new SessionStore()
  const registry = new SessionRegistry(store)
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
  const repos = new RepoRegistry(registry, store)
  const superagent = new SuperagentService(registry, repos, store)
  const app = new Hono()
  app.get('/health', (c) => c.text('ok'))
  registerVersionRoute(app)
  // The setup UI fetches /setup/config from the desktop webview, whose origin (tauri://localhost)
  // differs from the local server — same cross-origin case as /trpc. Without CORS the fetch is
  // blocked and SetupGate's catch() silently skips onboarding. Must precede the route handler.
  // Gate the human-client data plane (/trpc, /files) and the mutating setup POST behind
  // the login session whenever a password is configured; open otherwise (loopback /
  // all-in-one, or the user opted out). The static SPA shell, /auth/*, GET /setup/config,
  // /health and /version stay open so the login screen can load. The /daemon link and
  // /mcp keep their own credentials. Guards are registered BEFORE their handlers so Hono
  // runs them first.
  const guard = clientAuthGuard({ store })
  app.use('/setup/*', cors())
  app.on('POST', '/setup/config', guard)
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
  const mcpToken = randomUUID()
  registerMcpRoute(app, superagent, mcpToken)
  app.use('/trpc/*', cors())
  app.use('/trpc/*', guard)
  app.use(
    '/trpc/*',
    trpcServer({ router: appRouter, createContext: () => ({ registry, repos, superagent }) }),
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

  return new Promise<ServerHandle>((resolve) => {
    const server = serve({ fetch: app.fetch, port: opts.port ?? 0, hostname: host }, (info) => {
      // The harness agent runs on the same host (single-machine), so loopback
      // reaches this MCP route. Now that the port is known, point it there.
      superagent.setMcpEndpoint(`http://127.0.0.1:${info.port}/mcp`, mcpToken)
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
  })
}

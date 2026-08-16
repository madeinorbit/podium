import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { trpcServer } from '@hono/trpc-server'
import { createLogger } from '@podium/logger'
import { asMachineId, FIRST_ADMIN_USER_ID } from '@podium/model'
import { type LocalDaemonLink, MIN_SUPPORTED_VERSION, type MobileWebIdentity, PeerHelloReply, type UpdateTarget, WIRE_VERSION, wireSchemaDigest } from '@podium/protocol'
import { type ControlMessage } from '@podium/protocol/daemon'
import { loadConfig, resolveDevArtifactOrigin, resolveInstanceId } from '@podium/runtime/config'
import { ensureInstanceStateIdentity } from '@podium/runtime/instance'
import {
  readOrCreateDaemonSecret,
  readOrCreateLocalMachineId,
  stateDir,
} from '@podium/runtime/local-machine'
import { startLoopMetrics } from '@podium/runtime/loop-metrics'
import {
  formatTopQueries,
  queryAttributionTotals,
  queryCallerStacks,
  resetQueryAttribution,
} from '@podium/runtime/sqlite'
import {
  attributeTasks,
  formatTopTasks,
  resetTaskAttribution,
  taskAttributionCoverage,
  taskAttributionTotals,
} from '@podium/runtime/task-attribution'
import { prepareLedgerBoot } from '@podium/sync'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import {
  clientAuthGuard,
  isSecureRequest,
  maintainClientCredentialByHash,
  registerAuthRoute,
  resolveClientCredential,
  requestUserId,
  type ClientCredentialHeaders,
} from './auth-route'
import { captureServerBuildVersion } from './build-version'
import { createCloudRuntimeProviderFromEnv } from './cloud-runtime'
import { userCommandPrincipal } from './command-principal'
import { openEnrollmentLedger } from './enrollment-ledger'
import { registerArtifactRoute } from './file-artifact-route'
import { registerAssetRoute } from './file-asset-route'
import {
  createDaemonAcceptor,
  receiveDaemonFrame,
  recordHelloBuild,
} from './gateway/peer-handshake'
import { attachWebSockets, type NativeServer, serveNative } from './gateway/ws-server'
import { PairingManager } from './hub/pairing'
import { applyEnvFirstAdminPassword, retireInstancePassword } from './instance-password-migration'
import { IssueToolProvider } from './issue-mcp'
import { registerMcpRoute } from './mcp-route'
import { MobilePairingManager } from './mobile-pairing'
import { registerMobilePairingRoutes } from './mobile-pairing-route'
import { registerMaintenanceRoute } from './modules/maintenance/route'
import { MaintenanceService } from './modules/maintenance/service'
import { MessagingService } from './modules/messaging'
import { DEPLOYMENT, perf } from './modules/perf/registry'
import {
  assertWritableServerBoot,
  reconcileSafeServerTransferBoot,
} from './modules/server-transfer/journal'
import { PortableStateFence } from './modules/server-transfer/portable-fence'
import { SuperagentService } from './modules/superagent'
import { DEVELOPMENT_SOURCE_ROOT } from './modules/updates/dev-bundle'
import { wireDevBundlePublisher } from './modules/updates/dev-publisher-wiring'
import { readOrCreateUpdateSigningKey } from './modules/updates/signing-key'
import { createSourceRedeployRequest } from './modules/updates/source-redeploy'
import type { PodiumPlugin } from './plugins'
import { SessionRegistry } from './relay'
import { MachineRepoDiscovery } from './repo-discovery'
import {
  authReadinessBoundary,
  isHostLocalRequest,
  isHostSetupBootstrap,
  readinessBoundary,
} from './readiness-boundary'
import { registerReadinessRoute } from './readiness-route'
import { RepoRegistry } from './repo-registry'
import { compressHttpResponse } from './response-compression'
import { resolveServerRole, type ServerRoleConfig } from './roles'
import { appRouter } from './router'
import { registerSetupRoute } from './setup-route'
import { createServerReadiness } from './server-readiness'
import { closeServerFast } from './shutdown'
import { registerDesktopWebStatic, registerMobileRouting, registerWebStatic } from './static-web'
import { SessionStore } from './store'
import { wireTelemetry } from './telemetry'
import { reportParkedUpstreamMutations } from './upstream-retirement'
import {
  describeBundle,
  gradeWebBundle,
  servedWebIdentity,
  servedWebSourceDigest,
} from './web-bundle-stamp'

const log = createLogger('server:http')
// Separate namespaces so an operator can turn the loop profiler up
// (PODIUM_LOG='server:loop=debug') without also turning up request logging.
const loopLog = createLogger('server:loop')
const repoDiscoveryLog = createLogger('server:repo-discovery')

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
  instanceId: string
  port: number
  registry: SessionRegistry
  /**
   * The persistent same-host shared secret the bundled local daemon presents (as its
   * `hello` token) to authenticate as the local machine. Exposed so the in-process
   * daemon (host.ts) can pass it straight through without re-reading the file.
   */
  bootstrapToken: string
  /**
   * In-process daemon seam [POD-196]: hands the all-in-one daemon a direct
   * message channel so per-frame traffic skips the loopback WebSocket + JSON +
   * schema re-validation. Only the composition root wires this; remote daemons
   * keep the authenticated WS path.
   */
  localDaemonLink: LocalDaemonLink
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

/**
 * Where a built website lives: the packaged headless bundle's env var, else the
 * source checkout's dist.
 *
 * ONE SPELLING PER WEBSITE. Both dirs are now read by more than the route that
 * serves them — `/version` reports the phone dist's identity and the update
 * context reports the desktop's — and "where is the phone website" answered in
 * three places is two answers waiting to disagree with the one that serves it.
 *
 * In a `bun build --compile` binary `import.meta.url` is not a file:// URL, so
 * the source default is guarded: an unresolvable dir means "API only" for that
 * SPA, never a crash.
 */
function distDir(declared: string | undefined, sourceRelative: string): string {
  if (declared) return declared
  try {
    return fileURLToPath(new URL(sourceRelative, import.meta.url))
  } catch {
    return ''
  }
}

/** The desktop shell (`vite build`), served at `/`. */
function desktopWebDir(env: NodeJS.ProcessEnv = process.env): string {
  return distDir(env.PODIUM_WEB_DIR, '../../web/dist')
}

/** The phone shell (`expo export -p web`), served at `/mobile`. */
function phoneWebDir(env: NodeJS.ProcessEnv = process.env): string {
  return distDir(env.PODIUM_MOBILE_WEB_DIR, '../../mobile/dist')
}

/** Local-first setup is valid only when both the launcher asks and the server stays off-network. */
export function shouldAdvertiseLocalSetupDefault(
  opts: { host?: string; localSetupDefault?: boolean },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return opts.localSetupDefault === true && isLoopbackHost(resolveBindHost(opts, env))
}

/** Machine-readable version probe — distinct from /health (which stays plaintext "ok"). */
export function registerVersionRoute(
  app: Hono,
  deps: {
    /** Deployment identity resolved once by the process entry point. */
    instanceId: string
    /**
     * The grade of the visibility policy this server actually runs (POD-376).
     *
     * ON THE PRE-BOOT PROBE, and that placement is the decision. The client must
     * resolve its replica-path flag BEFORE it constructs a replica or opens a
     * socket, so the answer has to be available at the one request it already
     * makes first. Advertising it on a frame instead would be too late: the flag
     * would already have chosen a path, and "correct it afterwards" means the
     * wrong path ran.
     *
     * Optional so a caller assembling a server without a feed edge (unit tests,
     * the version-route suite) keeps working; ABSENT is reported as
     * `device-unscoped` because that is the state of a server with no scoped feed
     * at all, and it is also the answer the client treats as permissive — a
     * default that had to be the other way would be a gate whose refusing arm
     * fires on every stripped-down deployment.
     */
    visibilityGrade?: () => string
    updateTarget?: () => UpdateTarget | undefined
    appVersion?: () => string
    /**
     * The phone website on disk, so Update can tell whether the phone is on this
     * commit (POD-1980). Read per request, like the target: the export is built
     * by a separate unit that may finish long after this server booted.
     *
     * Optional, and OMITTED when absent rather than reported as `{present:false}`,
     * so a server assembled without it (the version-route suite) is indistinguishable
     * from one whose phone export is missing — both mean "nothing to say here".
     */
    mobileWeb?: () => MobileWebIdentity
  },
): void {
  app.get('/version', (c) => {
    let target: UpdateTarget | undefined
    try {
      target = deps.updateTarget?.()
    } catch {
      target = undefined
    }
    let mobileWeb: MobileWebIdentity | undefined
    try {
      mobileWeb = deps.mobileWeb?.()
    } catch {
      mobileWeb = undefined
    }
    return c.json({
      wireVersion: WIRE_VERSION,
      minSupportedVersion: MIN_SUPPORTED_VERSION,
      /**
       * Structural fingerprint of this server's message schemas. Alongside the
       * wire version, it lets clients report build drift without treating it as
       * a hard compatibility decision.
       */
      wireSchemaDigest: wireSchemaDigest(),
      appVersion: deps.appVersion?.() ?? process.env.PODIUM_APP_VERSION ?? 'dev',
      instanceId: deps.instanceId,
      feedScoping: deps.visibilityGrade?.() ?? 'device-unscoped',
      ...(target ? { target } : {}),
      ...(mobileWeb?.present ? { mobileWeb } : {}),
    })
  })
}

function proxyHopsFromEnv(env: Record<string, string | undefined>): number {
  const raw = env.PODIUM_TRUSTED_PROXY_HOPS
  if (raw === undefined || raw === '') return 0
  return /^\d+$/.test(raw) ? Number(raw) : Number.NaN
}

function tlsFromEnv(
  env: Record<string, string | undefined>,
): { key: string; cert: string } | undefined {
  const keyFile = env.PODIUM_TLS_KEY_FILE
  const certFile = env.PODIUM_TLS_CERT_FILE
  if (!keyFile && !certFile) return undefined
  if (!keyFile || !certFile) {
    throw new Error('PODIUM_TLS_KEY_FILE and PODIUM_TLS_CERT_FILE must be configured together')
  }
  return {
    key: readFileSync(keyFile, 'utf8'),
    cert: readFileSync(certFile, 'utf8'),
  }
}

export async function startServer(
  opts: {
    port?: number
    host?: string
    role?: Partial<ServerRoleConfig>
    /** Build-time extensions (the cloud seam — plugins.ts). OSS ships none. */
    plugins?: PodiumPlugin[]
    /** Keep `/` on the web shell while still serving Expo at `/mobile` (browser harness). */
    redirectPhoneRootToMobile?: boolean
    /**
     * Exact number of right-appending reverse-proxy hops trusted for forwarding headers.
     * Zero ignores them. A positive value requires the backend listener to be reachable only
     * through that proxy chain; direct access would violate the operator-declared boundary.
     */
    trustedProxyHops?: number
    /** Direct TLS material. Env alternatives are PODIUM_TLS_KEY_FILE/PODIUM_TLS_CERT_FILE. */
    tls?: { key: string; cert: string }
    /** Advertise the safe local all-in-one first-run default to loopback web clients. */
    localSetupDefault?: boolean
  } = {},
): Promise<ServerHandle> {
  const configuredProxyHops = opts.trustedProxyHops ?? proxyHopsFromEnv(process.env)
  if (
    !Number.isSafeInteger(configuredProxyHops) ||
    configuredProxyHops < 0 ||
    configuredProxyHops > 16
  ) {
    throw new Error('trustedProxyHops must be an integer between 0 and 16')
  }
  const trustedProxyHops = configuredProxyHops
  const tls = opts.tls ?? tlsFromEnv(process.env)
  const appVersion = captureServerBuildVersion()
  const instanceId = resolveInstanceId()
  ensureInstanceStateIdentity({ instanceId })
  // Role composition (roles.ts): which optional module groups this process
  // activates. Explicit opts win; else the H1 shape, core + hub.
  const config = loadConfig()
  const host = resolveBindHost(opts)
  const role = resolveServerRole(opts.role)
  // WHO THIS HOST IS, read (or minted) once, before anything can write a row. Every
  // other consumer in the process takes it from here — the store carries it to the
  // repos aggregate, `MachinesService` takes it as a dep, and the maintenance realm
  // and in-process daemon link below name this same value. The split-mode daemon
  // reads the same file in its own process; all-in-one is handed it in memory.
  const hostMachineId = readOrCreateLocalMachineId()
  const updateSigningKey = readOrCreateUpdateSigningKey()
  reconcileSafeServerTransferBoot(stateDir())
  assertWritableServerBoot(stateDir())
  const portableStateFence = new PortableStateFence()
  const store = new SessionStore(undefined, asMachineId(hostMachineId))
  // RETIRING THE INSTANCE PASSWORD (POD-1554), before anything can serve a login and
  // before the open-exposure check below. Order matters between these two: the legacy
  // hash in auth.json is the operator's REAL password and wins, so it is moved into the
  // first admin's credential first; the PODIUM_PASSWORD seam then finds a credential and
  // stays the no-op it has always been on an instance that already has one.
  await retireInstancePassword({ users: store.users })
  await applyEnvFirstAdminPassword({ users: store.users })
  // IS LOGIN REQUIRED — composed ONCE and passed to every gate, so the guard, the login
  // route, the status route and the exposure warning cannot answer it differently.
  const credentialsRequired = (): boolean =>
    !loadConfig().auth?.openMode && store.users.hasPerUserCredentials()
  const mobilePairing = new MobilePairingManager()
  // Readiness gate [spec:SP-c29e]: a bloated change log is fully pruned in
  // bounded, yielding units before SessionRegistry constructs its Ledger and
  // folds/reconciles the retained rows. The server does not listen meanwhile.
  const bootPrune = await prepareLedgerBoot({
    repo: store.sync,
    now: Date.now,
    onPruneMetrics: (metrics) => {
      perf.record('phase', 'changeLogPrune.boot.total', metrics.totalDurationMs, DEPLOYMENT)
      perf.record(
        'phase',
        'changeLogPrune.boot.maxSlice',
        metrics.maxUninterruptedSliceMs,
        DEPLOYMENT,
      )
    },
  })
  if (bootPrune.metrics.exceededPlacementThreshold) {
    log.warn('boot retention exceeded the placement threshold — candidate for janitor placement', {
      durationMs: bootPrune.metrics.totalDurationMs,
    })
  }
  // The transcript lake lives in the state dir next to podium.db (transcript-mirror
  // spec §2.1). Passing the dir opts the registry into mirroring; tests that construct
  // SessionRegistry without it produce no mirror traffic.
  const registry = new SessionRegistry(store, undefined, {
    instanceId,
    // The server's baked product label is the Phase 1 target identity. The richer
    // release-manifest descriptor remains an optional /version publication seam.
    targetVersion: () => appVersion,
    mirrorLakeDir: join(stateDir(), 'transcripts'),
    portableStateFence,
    // Enrollment ledger (POD-1114, D19.4): pairing root + append-only enrollment,
    // owner and revocation at the state-root tier, outside podium.db. Opened
    // before service construction so pair/hello/revoke share one durability domain.
    enrollment: openEnrollmentLedger(stateDir(), portableStateFence),
    // Inbound daemon pairing is a HUB capability, injected here (the composition
    // root) so core (relay/machines) never imports hub/pairing — see roles.ts.
    // Node role = no manager = `pair` handshakes rejected, minting throws; the
    // local daemon's `hello` path is untouched.
    ...(role.hub ? { pairing: new PairingManager() } : {}),
    updatePubkey: () => updateSigningKey.publicKey,
    // Live model enumeration is only wired in the real process; tests get the empty
    // default and nothing is ever asked of a daemon.
    // TODO(#251-followup): fold the remaining settings-coupled env reads
    // (PODIUM_WEB_DIR/PODIUM_MOBILE_WEB_DIR bundle-path fallbacks below,
    // PODIUM_HOST/PODIUM_PASSWORD, PODIUM_LOOP_PROFILE, PODIUM_CLOUD_*) into the
    // server-side layer of the @podium/runtime/config resolver. The model probe's
    // own env+settings dual-source is gone: it reads the DAEMON host's env now.
    //
    // WHERE THE PROBE RUNS IS WHICH MACHINE IT DESCRIBES (POD-1466).
    //
    // The probe only ever sees the agent CLIs installed on the host executing it,
    // so EVERY machineId — including this host's — is answered by that machine's
    // own daemon (`modelProbeRequest`, settled by the request correlator; `{}` on
    // timeout, which the catalog reads as "keep the last-good snapshot"). The
    // server used to shell out locally for every machineId, which served its own
    // models as if they were the remote machine's.
    //
    // Uniform rather than "local host in-process, remote via daemon": the host's
    // daemon is the same box, so the local branch would have bought nothing but a
    // second code path — and it is what kept apps/server importing @podium/harness
    // to drive agent CLIs, which the dependency boundary forbids for good reason.
    // The one behaviour it carried is noted at the daemon handler: the claude list
    // now resolves auth from the DAEMON host (its ANTHROPIC_API_KEY, else its
    // Claude Code login) rather than the server's `apiKeys.anthropic` secret —
    // which is also the auth the agents on that machine actually run under.
    modelProbe: (machineId) => registry.modules.rpc.modelProbe(machineId),
  })
  // Resolve release authorities before serving the fleet read model. Failures are
  // captured as per-channel unavailable reasons; startup remains operational.
  await Promise.all([
    registry.modules.updates.refreshTarget('edge'),
    registry.modules.updates.refreshTarget('stable'),
  ])

  // The persistent same-host shared secret, read (or created 0600) from the state dir.
  // The server hashes it into the local machine's stored credential below; the bundled
  // local daemon reads the SAME file (or, in-process, gets this value via ServerHandle)
  // and presents it as its `hello` token — so the local daemon authenticates with no
  // pairing step and no per-boot token race.
  const bootstrapToken = readOrCreateDaemonSecret()
  // Provision THIS HOST as a machine NOW, at startup: register it under the id read
  // above with the server-owned credential (sha256 of the shared secret), and fold any
  // pre-POD-318 rows onto that id in one transaction. Rows are therefore attributed
  // from the first write, regardless of whether/when the daemon connects — the
  // structural guard against the regression where data vanished because no daemon ever
  // registered. The same-host daemon then authenticates through the normal hello path
  // (wsServer) presenting this same id.
  registry.modules.machines.ensureHostMachine(hostname(), bootstrapToken)
  // RETIRED at POD-309: the node⇄hub dialer (`UpstreamSync`) and the issue write
  // forwarder (`UpstreamForwarder`) were constructed here when config.json carried an
  // `upstream` block. Federation is deferred, not cancelled ([spec:SP-0371], ADR 5 D1);
  // what survives it is the SEAM — authority/feed identity, outbox attribution,
  // the reserved node-peer caps, and kernel ports with no transport baked in —
  // none of which is wired from this composition root.
  //
  // Anything an operator had QUEUED in `upstream_outbox` when this build lands is
  // parked, not discarded: `reportParkedUpstreamMutations` is the operator-visible
  // half of that (ADR 5 D8: "silent discard of poison/pending work is forbidden").
  reportParkedUpstreamMutations(store.sync, store.events)
  // Opt-in telemetry [spec:SP-f933]. The server is the sole emitter (D10).
  // Wiring is unconditional and consent is read fresh per record/flush (D4/D9),
  // so this collects NOTHING until a tier is explicitly on — and takes effect
  // without a restart when it is.
  const telemetry = wireTelemetry({
    bus: registry.modules.bus,
    machineCount: () => registry.modules.machines.listMachines().length,
  })
  const repos = new RepoRegistry(registry, store)
  // Tiered per-machine repo discovery (POD-787) [spec:SP-3701]: probes + shallow walks
  // on machine.connected (never awaited by the attach path), deep sweep on explicit ask.
  const repoDiscovery = new MachineRepoDiscovery({
    listRepos: () => store.repos.listRepos(),
    addRepo: (path, machineId, originUrl) => store.repos.addRepo(path, machineId, originUrl),
    removeRepo: (path, machineId) => store.repos.removeRepo(path, machineId),
    // Liveness probed on the MACHINE (POD-1498), never inferred from scan coverage:
    // browseDirs answers from that daemon's own filesystem, and a directory that is
    // gone comes back without a listing. Any failure to answer is treated as "cannot
    // tell" by the caller, which then declines to heal.
    pathExists: async (path, machineId) => {
      const res = await registry.modules.rpc.browseDirs(path, {}, machineId)
      return Boolean(res.listing)
    },
    scanRepos: (roots, opts, machineId) => registry.modules.rpc.scanRepos(roots, opts, machineId),
    machineName: (id) => registry.modules.machines.machineName(id),
    localMachineId: asMachineId(hostMachineId),
    log: (message) => repoDiscoveryLog.info(message),
  })
  // Automatic connect-scan orchestration RETIRED from the bus path [POD-925]:
  // janitor issues connect-scan commands; deep scans stay interactive via API.
  const superagent = new SuperagentService(registry.modules, repos, store)
  // Messaging-app bridge [spec:SP-5d81]: two-way Telegram chat with the
  // superagent, riding the notification bot config. configure() is a no-op
  // until a bot token + chat id are set; settings.changed re-arms it live.
  const messaging = new MessagingService({
    bus: registry.modules.bus,
    // Outbound routing is derived from the authenticated binding table, never
    // from one ambient operator/global chat id. Zero or ambiguous routes fail closed.
    routing: {
      chatIdForUser: (userId) => {
        const routes = store.telegramBindings.listForUser(userId)
        return routes.length === 1 ? routes[0]?.chatId : undefined
      },
      // POD-419: the bot token is server-only material; the chat id stays routing.
    },
    telegramBotToken: () => store.secrets.getOrEmpty('notifications.telegramBotToken'),
    superagent,
    issues: registry.modules.issues,
    sessions: registry.modules.sessions,
    topics: store.messagingTopics,
    sessionIssueId: (sessionId) => registry.modules.sessions.getSessionIssueId(sessionId),
    // Issue-topic entry recap [spec:SP-62c3]: last messages from the bound
    // superagent (or btw origin) session transcript.
    topicRecap: {
      getSuperagentThread: (threadId) => store.superagent.getSuperagentThread(threadId),
      readTranscript: (input) =>
        registry.modules.rpc.readTranscript(input, { kind: 'system', id: 'answer-delivery' }),
    },
    telegramSetupPending: () => registry.modules.settings.hasPendingTelegramSetup(),
    // The binding table, read live per message: an inbound chat resolves to the
    // user that bound it, or to nobody and is refused (ADR 3 Amendment 1 D22).
    telegramBindings: store.telegramBindings,
  })
  messaging.configure()
  const cloud = createCloudRuntimeProviderFromEnv()
  const devArtifactToken = randomUUID()
  let boundPort = opts.port ?? 0
  const developmentSourceRoot = process.env.PODIUM_HOME ? undefined : DEVELOPMENT_SOURCE_ROOT
  const requestCoordinatorRestart = developmentSourceRoot
    ? createSourceRedeployRequest({ instanceId })
    : undefined
  const devPublisher = wireDevBundlePublisher({
    sourceRoot: developmentSourceRoot,
    instanceId,
    artifactOrigin: developmentSourceRoot ? resolveDevArtifactOrigin(config) : undefined,
    localArtifactOrigin: () => `http://127.0.0.1:${boundPort}`,
    hasRemoteManagedMachines: () =>
      store.machines
        .listMachines()
        .some((machine) => machine.id !== hostMachineId && machine.podiumManaged),
    artifactToken: devArtifactToken,
    setTarget: (target) => registry.modules.updates.setTarget(target),
    setTargetUnavailable: (reason) => registry.modules.updates.setTargetUnavailable('dev', reason),
    signingKey: updateSigningKey.privateKey,
    locks: registry.modules.locks,
  })

  const requestPeerAddresses = new WeakMap<Request, string>()
  const readiness = createServerReadiness({
    bootConfig: config,
    hasLiveAgentMachine: () => registry.modules.machines.onlineMachineIds().length > 0,
  })
  const app = new Hono()
  app.get('/health', (c) => c.text('ok'))
  devPublisher.registerRoute(app)
  registerVersionRoute(app, {
    instanceId,
    appVersion: () => appVersion,
    // Straight through to the Authority, which delegates to the policy object it
    // was constructed with. No copy on the path (POD-376).
    visibilityGrade: () => registry.modules.funnel.visibilityGrade(),
    updateTarget: () => {
      void devPublisher.requestBuild(false).catch(() => {})
      return devPublisher.publishTarget() ?? registry.modules.updates.target()
    },
    mobileWeb: () => servedWebIdentity(phoneWebDir()),
  })
  registerMaintenanceRoute(app, {
    // The maintenance realm is THIS HOST's credential, named by its real id rather
    // than by a constant that stood for it.
    authenticateToken: (token) => store.machines.getMachineByToken(hostMachineId, token),
    service: new MaintenanceService(store, registry.modules.funnel, {
      issues: registry.modules.issues,
      sessions: registry.modules.sessions,
      automations: registry.modules.automations,
      // Read per handshake, never captured: a settings flip must reach the next
      // lease, not wait for a server restart (POD-564).
      worktreeGcPolicy: () => store.settings.getSettings().worktreeGc,
      liveSessionIds: () =>
        new Set(
          registry.modules.sessions
            .listSessions()
            .filter((s) => s.status !== 'exited' && s.status !== 'hibernated')
            .map((s) => s.sessionId),
        ),
      stewardTick: () => registry.runStewardTick(),
      connectScan: (machineId) => {
        void repoDiscovery.scan(machineId, { deep: false })
      },
      localMachineId: asMachineId(hostMachineId),
    }),
  })
  // The setup UI fetches /setup/config from the desktop webview, whose origin (tauri://localhost)
  // differs from the local server — same cross-origin case as /trpc. Without CORS the fetch is
  // blocked and SetupGate's catch() silently skips onboarding. Must precede the route handler.
  // Gate the human-client data plane (/trpc, /files) behind the login session whenever a
  // password is configured; open otherwise (loopback / all-in-one, or the user opted out).
  // The static SPA shell, /auth/*, GET /setup/config, /health and /version stay open so the
  // login screen can load. Setup WRITES live under /trpc (setup.*), so they're covered by the
  // /trpc guard below. The /daemon link and /mcp keep their own credentials. Guards are
  // registered BEFORE their handlers so Hono runs them first.
  const requestPrincipal = (headers: ClientCredentialHeaders) => {
    const userId =
      requestUserId(store.auth, headers.cookieHeader, Date.now(), headers.authorizationHeader) ??
      (!credentialsRequired() ? FIRST_ADMIN_USER_ID : undefined)
    if (userId === undefined) return undefined
    const account = store.users.get(userId)
    return account ? userCommandPrincipal(userId, account.role) : undefined
  }
  const guard = clientAuthGuard({
    store: store.auth,
    users: store.users,
    loginRequired: credentialsRequired,
    trustedProxyHops,
  })
  const boundary = readinessBoundary({ readiness, isHostLocal: isHostLocalRequest })
  app.use('/setup/*', cors())
  app.use('/readiness', cors())
  registerReadinessRoute(app, readiness)
  registerSetupRoute(app, {
    readiness,
    // A source launcher is not enough on its own: PODIUM_HOST=0.0.0.0 is an explicit
    // reachability choice, so that server must retain password/reachability setup.
    localSetupDefault: shouldAdvertiseLocalSetupDefault(opts),
  })
  // Human-client login (web/desktop UI). Same cross-origin reason as /setup: the desktop
  // webview's origin differs from the server in the all-in-one case. Login itself is
  // same-origin in the supported network topologies; the password store gates it.
  app.use('/auth/*', cors())
  app.use('/auth/*', authReadinessBoundary(readiness))
  let revokeConnectedMobileSession: (credentialId: string) => void = () => {}
  registerAuthRoute(app, {
    store: store.auth,
    users: store.users,
    // One principal resolver for every human-client transport. The status route
    // reports this result; it does not recreate the open/dev bootstrap fallback.
    resolveUserId: (headers) =>
      readiness().dataPlane === 'available' ? requestPrincipal(headers)?.user : undefined,
    loginRequired: credentialsRequired,
    trustedProxyHops,
    readiness,
    onCredentialRevoked: (tokenHash) => revokeConnectedMobileSession(tokenHash),
  })
  registerMobilePairingRoutes(app, {
    store: store.auth,
    pairing: mobilePairing,
    serverIdentity: () => ({ publicUrl: loadConfig().publicUrl, instanceId }),
    loginRequired: credentialsRequired,
    // Pairing and device management require a real credential. Open-mode's
    // synthetic first-admin principal must never authorize session mutation.
    resolveUserId: (headers) =>
      requestUserId(store.auth, headers.cookieHeader, Date.now(), headers.authorizationHeader),
    trustedProxyHops,
    requestPeerAddress: (request) => requestPeerAddresses.get(request),
    onCredentialRevoked: (tokenHash) => revokeConnectedMobileSession(tokenHash),
  })
  app.use('/files/*', boundary)
  app.use('/files/*', guard)
  registerAssetRoute(app, { readAsset: (a) => registry.modules.rpc.readAsset(a) })
  // Permanent artifact snapshots ([spec:SP-0fc9] #441) — server-local, no daemon hop.
  registerArtifactRoute(app, registry.modules.issueArtifacts)
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
  app.use('/trpc/*', boundary)
  app.use('/trpc/*', async (c, next) => {
    // A host-local first run must remain possible when PODIUM_PASSWORD already
    // provisioned a credential. Login itself is not a bootstrap surface, so the
    // exact setup allowlist bypasses the ordinary login guard only while blocked.
    if (isHostSetupBootstrap(readiness(), c.req.path, c.req.raw)) return next()
    return guard(c, next)
  })
  app.use(
    '/trpc/*',
    trpcServer({
      router: appRouter,
      // Error funnel: every failed /trpc call leaves a server-side trace (proc +
      // code + message — no payloads). Without this, 500s (INTERNAL_SERVER_ERROR)
      // were completely invisible in the server log.
      onError: ({ error, path, type }) => {
        log.warn('tRPC procedure failed', {
          callType: type,
          path: path ?? '<unknown>',
          code: error.code,
          reason: error.message,
        })
      },
      // Everyone who reaches /trpc is the OPERATOR: the login session (clientAuthGuard
      // above) already authenticated the human, so the tracker grants full authority — no
      // separate tracker credential. Constrained agents don't come through here; they are
      // relayed via their daemon and carry their own capability (agent integration).
      createContext: (_request, hono) => {
        const bootstrapAccount = isHostSetupBootstrap(readiness(), hono.req.path, hono.req.raw)
          ? store.users.get(FIRST_ADMIN_USER_ID)
          : undefined
        const principal =
          requestPrincipal({
            cookieHeader: hono.req.header('cookie'),
            authorizationHeader: hono.req.header('authorization'),
          }) ??
          (bootstrapAccount
            ? userCommandPrincipal(FIRST_ADMIN_USER_ID, bootstrapAccount.role)
            : undefined)
        if (principal === undefined) throw new Error('authenticated account is unavailable')
        return {
          registry,
          repos,
          discovery: repoDiscovery,
          superagent,
          cloud,
          principal,
          capability: principal.capability,
          // The accounts repository, WITHOUT which every credential write refuses.
          // `auth.*` is per-account since POD-1554, so `familyState` forwards this to
          // InstanceService and `requireAccountStore` throws 'account store unavailable'
          // when it is missing — which is what setup.complete-with-password,
          // auth.setPassword and auth.setLoginRequired all did while it went unset.
          // `Context.users` is optional (a server assembled without a store serves no
          // login at all), so omitting it here type-checks and fails only at runtime.
          users: store.users,
          // The SAME composed predicate the guard, the login route and pairing get, for the
          // reason given where it is defined: those four must never answer "is login
          // required" differently. Unset, `auth.status` fell back to `?? false` and reported
          // login as OFF over tRPC no matter how many credentials existed.
          loginRequired: credentialsRequired,
          modules: registry.modules,
          // Only so telemetry.preview can show the REAL report [spec:SP-f933];
          // consent lives in config.json and is never read through the context.
          telemetry,
          // Hub-only procs (machines fleet admin + pairing) 404 when the hub
          // role is off — see the hubProc guard in router.ts.
          role,
          ...(requestCoordinatorRestart ? { requestCoordinatorRestart } : {}),
          // The web build is the server's own step now, not a systemd unit to
          // restart (POD-1985) — but the context shape is unchanged, so the
          // Update panel's "the website is behind" path still just calls this.
          ...(devPublisher.requestWebRebuild
            ? { requestWebRebuild: devPublisher.requestWebRebuild }
            : {}),
          ...(devPublisher.enabled
            ? {
                requestDestBundle: () => devPublisher.requestBuild(true),
                updatePreparation: devPublisher.preparation,
              }
            : {}),
          servedWebDigest: () => servedWebSourceDigest(desktopWebDir()),
          // The phone website is the other half of the same install. Update
          // compares it against the same target commit and rebuilds it through
          // the same build step (POD-1980).
          servedMobileWeb: () => servedWebIdentity(phoneWebDir()),
        }
      },
    }),
  )

  // Build-time extensions (plugins.ts — the cloud seam): registered after every
  // core surface so a plugin can't shadow one, and BEFORE the static SPA
  // catch-alls below so plugin routes are reachable at all. Awaited in order;
  // a failing plugin aborts startup loudly rather than half-composing.
  for (const plugin of opts.plugins ?? []) {
    await plugin.register({ hono: app, modules: registry.modules, bus: registry.bus, config, role })
  }

  // Serve the built web UIs for external clients (browser/phone/other desktop) —
  // see desktopWebDir/phoneWebDir for where each dist comes from.
  const mobileWebDir = phoneWebDir()
  // Routing first so its /mobile fallback middleware owns the dist-absent case;
  // presence is probed per request (the mobile dist may be exported after boot).
  const mobileIndex = mobileWebDir ? join(mobileWebDir, 'index.html') : ''
  registerMobileRouting(app, {
    expoMobilePresent: () => mobileIndex !== '' && existsSync(mobileIndex),
    redirectPhoneRoot: opts.redirectPhoneRootToMobile ?? true,
    operatorEntryAvailable: () => readiness().dataPlane === 'available',
  })
  // crossOriginIsolated: expo-sqlite web needs SharedArrayBuffer for durable
  // OPFS persistence (POD-541). Without these headers the replica degrades to
  // in-memory and offline deep links paint "Task not found."
  if (mobileWebDir) {
    registerWebStatic(app, mobileWebDir, {
      basePath: '/mobile',
      lazy: true,
      crossOriginIsolated: true,
    })
  }

  const webDir = desktopWebDir()
  if (webDir) {
    registerDesktopWebStatic(app, webDir)
    // Say it at boot as well as in the page. The person who redeploys is looking
    // at a terminal, not at the app — POD-1610 survived a night of rebuilding
    // because nothing on the build path ever mentioned the web dist at all.
    const bundle = describeBundle(gradeWebBundle(webDir))
    if (bundle) log.warn(bundle, { webDir })
  }

  // If we're reachable off-box but no login password is set, the data plane is wide open
  // to anyone who can route to this host. Surface that loudly rather than failing silently.
  if (!isLoopbackHost(host) && !credentialsRequired()) {
    log.warn(
      'server is network-reachable with NO login required — anyone who can reach this host can control your agents and shell; set a password in setup, or bind to 127.0.0.1',
      { host },
    )
  }

  const requestedPort = opts.port ?? 0
  return new Promise<ServerHandle>((resolve, reject) => {
    let settled = false
    const failListen = (err: unknown): void => {
      if (settled) return
      settled = true
      messaging.stop()
      registry.dispose()
      store.close()
      reject(
        isAddressInUseError(err)
          ? new PortInUseError(requestedPort, { cause: err })
          : (err as Error),
      )
    }

    const ws = attachWebSockets(registry, {
      readinessForClient: readiness,
      validateClientCredential: (credentialId) =>
        maintainClientCredentialByHash(store.auth, credentialId) !== undefined,
      principalForClient: (request) => {
        if (
          request.headers.has('authorization') &&
          !isSecureRequest(
            request.url,
            request.headers.get('x-forwarded-proto') ?? undefined,
            trustedProxyHops,
          )
        ) {
          return undefined
        }
        const headers = {
          cookieHeader: request.headers.get('cookie') ?? undefined,
          authorizationHeader: request.headers.get('authorization') ?? undefined,
        }
        const credential = resolveClientCredential(store.auth, headers)
        const principal = requestPrincipal(headers)
        if (!principal) return undefined
        const userRole = store.users.roleOf(principal.user)
        if (!userRole) return undefined
        return {
          userId: principal.user,
          userRole,
          ...(credential ? { credentialId: credential.tokenHash } : {}),
        }
      },
    })
    revokeConnectedMobileSession = (sessionId) => ws.revokeClientCredential(sessionId)

    let server: Pick<NativeServer<never>, 'port' | 'stop'>
    try {
      server = serveNative({
        port: requestedPort,
        hostname: host,
        ...(tls ? { tls } : {}),
        websocket: ws.websocket,
        async fetch(request, nativeServer) {
          const peerAddress = nativeServer.requestIP?.(request)?.address
          if (peerAddress) requestPeerAddresses.set(request, peerAddress)
          const upgrade = ws.handleRequest(request, nativeServer as never)
          if (upgrade !== null) return upgrade
          const headers = new Headers(request.headers)
          if (peerAddress) headers.set('x-podium-peer-address', peerAddress)
          else headers.delete('x-podium-peer-address')
          const observedRequest = new Request(request, { headers })
          return compressHttpResponse(request, await app.fetch(observedRequest))
        },
      })
    } catch (err) {
      void ws.close()
      failListen(err)
      return
    }

    settled = true
    boundPort = server.port
    void devPublisher.requestBuild(true).catch(() => {})
    // The in-process MCP issue surface is the trusted superagent orchestrator. It calls
    // the issue command registry DIRECTLY (not the cookie-gated HTTP /trpc, which would
    // 401 it) as the OPERATOR — router-equal authz, no router caller involved. This is
    // also the seam for per-agent capabilities later: pass a constrained capability
    // instead of OPERATOR.
    issueTools.setClientResolver((threadId) => {
      const ownerUserId = superagent.threadOwner(threadId)
      const account = ownerUserId ? store.users.get(ownerUserId) : undefined
      if (!ownerUserId || !account) throw new Error('MCP thread owner is unavailable')
      return registry.issueCommands.asIssueTrpc(
        userCommandPrincipal(ownerUserId, account.role).capability,
      )
    })
    // Bridge the issue tools into the superagent's API tool loop (issue #64):
    // concierge (and global) threads drive the tracker through the same
    // in-process OPERATOR caller. Constraining this to an agent capability is
    // future work (same seam as above). Must precede setMcpEndpoint so the
    // allowed-tool name list below includes the bridged issue tools.
    superagent.setIssueTools(issueTools)
    // The harness agent runs on the same host (single-machine), so loopback
    // reaches this MCP route. Now that the port is known, point it there.
    superagent.setMcpEndpoint(
      `http://127.0.0.1:${server.port}/mcp`,
      mcpToken,
      superagent.mcpToolSpecs().map((s) => s.name),
    )
    // Server-side stall reporter (POD-600): a lightweight analog of the
    // daemon's reportLongTick — starved-vs-busy classification + heap/RSS,
    // no activity counters (this process does no PTY work).
    if (process.env.PODIUM_LOOP_PROFILE) {
      // POD-1630: the per-second window that scopes SQL attribution to the
      // stall rather than to all of uptime — the same cadence the daemon's
      // loop-attribution uses, and for the same reason.
      // POD-1931: the SAME question one level out. Query attribution names the
      // statements; this names the SCHEDULED CALLBACKS, which is where the rest
      // of a stall lives — after the query-shaped costs were fixed, the phases
      // and statements together accounted for barely a third of the blocked
      // time. Installed before the subsystems schedule anything, so their timers
      // are wrapped at creation.
      attributeTasks()
      const attributionWindow = setInterval(() => {
        resetQueryAttribution()
        resetTaskAttribution()
      }, 1000)
      attributionWindow.unref?.()
      // POD-1653: the window above answers "what stalled this second"; a bench
      // run asks "what ran over the last minute, and WHO issued it". Both
      // retentions already exist (queryAttributionTotals / queryCallerStacks)
      // but nothing could read them out of a live process. SIGUSR2 is that
      // reader — inert unless profiling is on, and it only prints.
      process.on('SIGUSR2', () => {
        const out = [...queryAttributionTotals()]
          .sort((a, b) => b[1].count - a[1].count)
          .slice(0, 15)
          .map(([sql, c]) => `${c.count}x/${c.wallMs.toFixed(0)}ms/${c.rows}rows ${sql}`)
        loopLog.warn('query totals', { totals: out })
        loopLog.warn('task totals', {
          totals: [...taskAttributionTotals()]
            .sort((a, b) => b[1].wallMs - a[1].wallMs)
            .slice(0, 20)
            .map(
              ([label, c]) =>
                `${c.count}x/${c.wallMs.toFixed(0)}ms/max${c.maxMs.toFixed(0)} ${label}`,
            ),
        })
        for (const [key, samples] of queryCallerStacks()) {
          loopLog.warn('query caller stacks', {
            query: key,
            samples: samples.slice(0, 3).map((s) => ({ count: s.count, stack: s.stack })),
          })
        }
      })
      startLoopMetrics({
        // The sole record of a server stall — the probe reports here and logs
        // nothing itself, so every field lands on one queryable record (POD-1932).
        onLongTick: (ms, classification) => {
          const mu = process.memoryUsage()
          // The stall reporter could name the COST but never the CAUSE; the
          // tRPC and phase counters could not fill the gap because the work
          // is not on either path. The top statements are that missing name.
          const sql = formatTopQueries()
          // ...and the work that runs NO statement, which is most of what is
          // left. `taskCoverage` is reported next to it on purpose: the top
          // tasks are only worth reading against how much of the tick they
          // actually cover, or the largest named thing gets mistaken for the
          // cause again.
          const tasks = formatTopTasks()
          const taskCoverage = taskAttributionCoverage(ms)
          loopLog.warn('server event-loop stall', {
            durationMs: ms,
            heapUsedBytes: mu.heapUsed,
            rssBytes: mu.rss,
            // Each classification number its own NUMBER field: a query can ask
            // "which stalls were starved" only if the verdict is a field.
            ...(classification
              ? {
                  ownCpuMs: classification.ownCpuMs,
                  runqueueWaitMs: classification.runqueueWaitMs,
                  stallVerdict: classification.verdict,
                }
              : {}),
            ...(sql ? { sql } : {}),
            ...(tasks ? { tasks, taskCoverage } : {}),
          })
        },
      })
    }
    // In-process daemon link [POD-196]: the local-machine equivalent of
    // wireDaemonSocket, minus serialization. It still drives the SAME
    // acceptor and daemonSecret strategy. Composition-root reachability is
    // not proof of machine identity and grants no ambient `use` (M4).
    // queueMicrotask keeps delivery async so neither side re-enters the
    // other's call stack (the ordering the WS transport implied).
    const localDaemonLink: LocalDaemonLink = {
      attachPortableState: (control) => registry.attachLocalDaemonPortableState(control),
      attach: ({ hello, deliver }) => {
        const acceptor = createDaemonAcceptor({
          machines: registry.modules.machines,
          connectionId: `local-daemon-${randomUUID()}`,
        })
        const outcome = receiveDaemonFrame(acceptor, JSON.stringify(hello))
        if (outcome.kind !== 'established') {
          const reply =
            outcome.kind === 'rejected'
              ? PeerHelloReply.parse(outcome.reply)
              : { type: 'peerHelloRejected' as const, reason: 'unexpected-frame' as const }
          return { established: false as const, reply }
        }
        const { principal } = outcome
        recordHelloBuild(registry.modules.machines, outcome.machineId, {
          build: outcome.build,
          caps: outcome.offeredCaps,
          at: new Date().toISOString(),
        })
        const send = (msg: ControlMessage): void => queueMicrotask(() => deliver(msg))
        registry.gateway.attachDaemon(principal, send)
        return {
          established: true as const,
          reply: PeerHelloReply.parse(outcome.reply),
          machineId: principal.machine,
          // `inventoryReport` used to be special-cased at both socket call
          // sites; it is a row in the gateway's routing table now, so this
          // link routes the WHOLE daemon union through one seam.
          deliver: (msg) => queueMicrotask(() => registry.gateway.routeDaemonFrame(principal, msg)),
          close: () => registry.gateway.detachDaemon(principal, send),
        }
      },
    }
    resolve({
      port: server.port,
      instanceId,
      registry,
      bootstrapToken,
      localDaemonLink,
      // Deterministic fast shutdown (POD-611): terminate WS intake, persist
      // state unconditionally, THEN force-close lingering http sockets —
      // see closeServerFast for the full ordering rationale. Step order
      // below matters: sync/outbox loops stop before the store closes (a
      // late write against a closed DB would throw), dirty activity
      // timestamps flush while the DB is open, registry.dispose() stops the
      // periodic flush timer, and only then does the store close.
      close: () =>
        closeServerFast({
          closeWebSockets: () => ws.close(),
          server,
          persist: [
            ['messaging.stop', () => messaging.stop()],
            // Stop the flush timer + unsubscribe. Deliberately NOT awaiting a
            // final network flush: shutdown is a user-visible latency path
            // (POD-611 made it deterministic and fast), and a report is worth
            // less than a fast stop. The queue is durable — it goes next boot.
            ['telemetry.stop', () => telemetry.stop()],
            // Release the per-origin client log descriptors. The sink writes
            // synchronously, so nothing is buffered and this loses no records —
            // it closes fds a long-lived process would otherwise hold.
            ['logs.close', () => registry.modules.logs.close()],
            ['sessions.flushActivity', () => registry.modules.sessions.flushActivity()],
            ['registry.dispose', () => registry.dispose()],
            ['store.close', () => store.close()],
          ],
        }),
    })
  })
}

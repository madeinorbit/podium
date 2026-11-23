import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { trpcServer } from '@hono/trpc-server'
import type { WorkspaceIdentity } from '@podium/identity'
import { createLogger } from '@podium/logger'
import { asMachineId, asUserId, controlPlaneAvailable } from '@podium/model'
import {
  CAP_TERMINAL_INPUT_BINARY_V1,
  CAP_TERMINAL_OUTPUT_BINARY_V1,
  CLIENT_WIRE_VERSION,
  type DaemonPtyInputBatch,
  type LocalDaemonLink,
  MIN_CLIENT_WIRE_VERSION,
  type MobileWebIdentity,
  PeerHelloReply,
  type ServedWebIdentity,
  SIGN_IN_ENDED_CLOSE,
  type UpdateTarget,
  wireSchemaDigest,
} from '@podium/protocol'
import type { ControlMessage } from '@podium/protocol/daemon'
import {
  deleteLegacyInstancePasswordFile,
  hashPassword,
  readLegacyInstancePasswordHash,
} from '@podium/runtime/auth-store'
import {
  assertAppUrlCompatible,
  loadConfig,
  resolveAllowedOrigins,
  resolveAppUrl,
  resolveConnectBaseUrl,
  resolveConnectProbeKeys,
  resolveDevArtifactOrigin,
  resolveFileStorage,
  resolveInstanceId,
  resolveMode,
  resolveProfileOnStall,
  resolveProfileStallMs,
  resolvePublicUrl,
  resolveServerProcessRoles,
  resolveTranscriptLake,
  resolveUpdateFeedPolling,
  resolveUpdateScope,
  type ServerProcessRole,
} from '@podium/runtime/config'
import { PODIUM_CONNECT_PROBE_KEYS } from '@podium/runtime/connect-keys'
import { installationPublicKeyWire } from '@podium/runtime/installation-identity'
import { ensureInstanceStateIdentity } from '@podium/runtime/instance'
import { readOrCreateLocalMachineId, stateDir } from '@podium/runtime/local-machine'
import {
  addLoopAccounting,
  type LoopAccountingHandle,
  startLoopAccounting,
} from '@podium/runtime/loop-accounting'
import { createLoopMinuteSink, type LoopMinuteFileSink } from '@podium/runtime/loop-minute-sink'
import { atLeast, loopProfileLevel, reportLoopProfileWarning } from '@podium/runtime/loop-profile'
import {
  createProfileCapture,
  type LoopProfileCapture,
  takeProfileRequest,
} from '@podium/runtime/loop-profile-capture'
import { loadSupervisorState } from '@podium/runtime/machine-supervisor'
import {
  clearParentOutcome,
  readParentOutcome,
  requestParentEnrollment,
} from '@podium/runtime/parent-control'
import {
  drainHeavyStatementReads,
  formatQueryCost,
  queryAttributionSnapshot,
} from '@podium/runtime/query-attribution'
import { applyPublicUrl } from '@podium/runtime/setup'
import {
  formatTopQueries,
  queryAttributionTotals,
  queryCallerStacks,
  resetQueryAttribution,
} from '@podium/runtime/sqlite'
import { createStallWatch, type StallWatch } from '@podium/runtime/stall-watch'
import {
  attributeTasks,
  formatTopTasks,
  resetTaskAttribution,
  taskAttributionCoverage,
  taskAttributionTotals,
} from '@podium/runtime/task-attribution'
import { listenUserSocket, serverControlSocketPath } from '@podium/runtime/user-socket'
import { prepareLedgerBoot } from '@podium/sync'
import { Hono } from 'hono'
import { registerAdminRoutes } from './admin-routes'
import { clientAuthGuard, registerAuthRoute } from './auth-route'
import { bootStage } from './boot-timing'
import { captureServerBuildVersion, serverBuildSourceDigest } from './build-version'
import { createCloudRuntimeProviderFromEnv } from './cloud-runtime'
import { userCommandPrincipal } from './command-principal'
import { controlSocketHandler } from './control-socket'
import {
  edgeWorkspaceBinding,
  registerArtifactRoute,
  workspaceArtifacts,
} from './file-artifact-route'
import { registerAssetRoute } from './file-asset-route'
import { createServerFileStorage } from './file-storage'
import { adoptStagedFirstAdminPassword, applyEnvFirstAdminPassword } from './first-admin-password'
import { daemonLinkFactsOf, IN_PROCESS_DAEMON_LINK } from './gateway/daemon-link-kind'
import {
  createDaemonAcceptor,
  prepareDaemonFrame,
  recordHelloBuild,
} from './gateway/peer-handshake'
import {
  attachWebSockets,
  HTTP_IDLE_TIMEOUT_S,
  type NativeServer,
  serveNative,
  type WsHandle,
} from './gateway/ws-server'
import type { HostMachine } from './host-machine'
import { hostSignIns } from './host-sign-ins'
import { isAllowedHttpOrigin, podiumCors } from './http-cors'
import { httpsSignInWarning, registerHttpsRequiredPage } from './https-required'
import { PairingManager } from './hub/pairing'
import { MemberHasNoAccount, memberCredentials } from './identity/member-credentials'
import { createMemberOfRequest, refusalAnswer } from './identity/member-of-request'
import {
  type MembershipCatchUpScheduler,
  startMembershipCatchUp,
} from './identity/membership-catch-up'
import { replicaBoundaryOf } from './identity/replica-boundary'
import {
  type IdentitySeam,
  openServerIdentity,
  type ServerIdentity,
} from './identity/server-identity'
import { IssueToolProvider } from './issue-mcp'
import { registerLocateProofRoute } from './locate-proof-route'
import { registerMcpRoute } from './mcp-route'
import { memberLinks } from './member-links'
import { registerMemberRoutes } from './member-routes'
import {
  convertArtifactKeys,
  convertPendingUploadRecords,
} from './migrations/artifact-key-conversion'
import { ConvertingLake } from './migrations/lake-parts-conversion'
import { registerMobilePairingRoutes } from './mobile-pairing-route'
import { connectClient } from './modules/connect/client'
import { ConnectPublisher } from './modules/connect/publisher'
import { connectScanThroughEffect } from './modules/fleet/discovery-effects'
import { registerMaintenanceRoute } from './modules/maintenance/route'
import { MaintenanceService } from './modules/maintenance/service'
import { directSessionPort, MessagingService } from './modules/messaging'
import { DEPLOYMENT, perf } from './modules/perf/registry'
import { serverMoveAuthorization } from './modules/server-transfer/authorization'
import {
  assertWritableServerBoot,
  legacyTransferInProgress,
  reconcileSafeServerTransferBoot,
  serverTransferBootMode,
} from './modules/server-transfer/journal'
import {
  serverMoveCommitEvidenceHook,
  serverMoveFaultHook,
} from './modules/server-transfer/operation'
import { PortableStateFence } from './modules/server-transfer/portable-fence'
import {
  readNewestTargetPromotionMetadata,
  readPromotedTargetMetadata,
} from './modules/server-transfer/target-status'
import { SuperagentService } from './modules/superagent'
import { DEVELOPMENT_SOURCE_ROOT, fleetHeadlessPlatforms } from './modules/updates/dev-bundle'
import {
  isRemoteUpdateConsumer,
  wireDevBundlePublisher,
} from './modules/updates/dev-publisher-wiring'
import { resolveDevelopmentRuntime } from './modules/updates/development-runtime'
import {
  createInstalledCoordinatorRestart,
  createInstalledCoordinatorUpdate,
} from './modules/updates/installed-restart'
import { startLocalUpdateParticipant } from './modules/updates/local-participant'
import type { UpdateReality } from './modules/updates/operation'
import type { ChannelFeed } from './modules/updates/release-target'
import type { ServerPlacement } from './modules/updates/service'
import { readOrCreateDevArtifactToken } from './modules/updates/signing-key'
import { createSourceRedeployRequest } from './modules/updates/source-redeploy'
import {
  refreshTargetsOnBoot,
  startTargetRefresh,
  timerSchedule,
} from './modules/updates/target-refresh'
import { updateOperationContext, websiteDigestReader } from './modules/updates/trpc'
import { originRefusalReporter } from './origin-refusal'
import type { PodiumPlugin } from './plugins'
import { privateResourceAccess } from './private-resources'
import {
  authReadinessBoundary,
  isHostLocalRequest,
  isHostSetupBootstrap,
  readinessBoundary,
} from './readiness-boundary'
import { registerReadinessRoute } from './readiness-route'
import { SessionRegistry } from './relay'
import { RepoRegistry } from './repo-registry'
import { clientAddressForRequest } from './request-scheme'
import { compressHttpResponse } from './response-compression'
import { resolveServerRole, type ServerRoleConfig } from './roles'
import { appRouter } from './router'
import { SELF_HOSTED_WORKSPACE_ID } from './self-hosted-workspace'
import { type ServerCapabilities, type ServerMode, serverCapabilities } from './server-mode'
import { createServerReadiness } from './server-readiness'
import { adoptLegacyHostMachine, completePreauthorizedSetup } from './setup-enrollment'
import { registerSetupRoute } from './setup-route'
import { closeServerFast } from './shutdown'
import { createSignInCarryOver, type SignInCarryOver } from './sign-in-carry-over'
import { registerSignInRoutes } from './sign-in-routes'
import { registerDesktopWebStatic, registerMobileRouting, registerWebStatic } from './static-web'
import { StoreDatabase, storeLocation, storeMigratesAtBoot, storeWakeUpOptions } from './store'
import { syncFeedPrincipal } from './sync/route-support'
import { registerSyncRoutes } from './sync/routes'
import type { SyncWorkerClient } from './sync-worker/worker-client'
import { wireTelemetry } from './telemetry'
import { logProcedureFailure } from './trpc'
import { TunnelHealthStore } from './tunnel-health'
import { updateParticipantSkip, updateParticipantSkipNote } from './update-participant-skip'
import { reportParkedUpstreamMutations } from './upstream-retirement'
import {
  describeBundleDiagnostic,
  gradeWebBundle,
  servedWebIdentity,
  servedWebSourceDigest,
} from './web-bundle-stamp'
import { registerWellKnownRoute } from './well-known-route'
import {
  boundMemberOfRequest,
  boundWorkspaceOf,
  createWorkspaceEdge,
  hostedWorkspaceId,
  maybeBoundServedWorkspaceOf,
  routedPath,
  selfCallUrl,
} from './workspace-edge'

const log = createLogger('server:http')
// Separate namespaces so an operator can turn the loop profiler up
// (PODIUM_LOG='server:loop=debug') without also turning up request logging.
const loopLog = createLogger('server:loop')
/**
 * The served-website identity. `server:updates` rather than `server:http`,
 * because the reader is somebody following an update end to end and this is the
 * server's side of "the assets under this page were replaced" (POD-3224).
 */
const versionLog = createLogger('server:updates')

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
  /** Server-owned bootstrap producer; undefined while starting or in unit-test hosts. */
  syncWorker(): SyncWorkerClient | undefined
  instanceId: string
  port: number
  registry: SessionRegistry
  /**
   * The identity this server signs people in with and resolves requests
   * through: built on its own database, or handed in by a hosted root.
   */
  identity: WorkspaceIdentity
  /** What this server's mode allows, derived once at boot (server-mode.ts). */
  capabilities: ServerCapabilities
  /**
   * The sign-in carry-over (POD-6751): present on a server that built its own
   * identity core and can write its store. For the hourly sweep and for tests.
   */
  signInCarryOver?: SignInCarryOver
  /** True when this process exposes only durable server-move recovery APIs. */
  recoveryOnly: boolean
  /** Server-owned maintenance channel credential; never accepted for machine authentication. */
  maintenanceToken: string
  /**
   * In-process daemon seam [POD-196]: hands the all-in-one daemon a direct
   * message channel so per-frame traffic skips the loopback WebSocket + JSON +
   * schema re-validation. Only the composition root wires this; remote daemons
   * keep the authenticated WS path. A daemon link is the `sync` role's, so a
   * process without it has none.
   */
  localDaemonLink?: LocalDaemonLink
  /** The roles this process runs (POD-7332): `api`, `sync`, `worker`. */
  roles: ReadonlySet<ServerProcessRole>
  /**
   * The listeners and loops this process started, by name, as they start: some
   * start after the handle resolves. It reports what the roles turned on;
   * nothing decides behaviour from it.
   */
  started(): ReadonlySet<string>
  /**
   * This process's event-loop accounting, absent at profile level `off`. It is
   * on the handle because the perf snapshot is assembled from the composition
   * root and the rings live in the process, not in the store.
   */
  loopAccounting?: LoopAccountingHandle
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
    /** Stable hosted workspace registry identity, when this server is workspace-bound. */
    workspaceId?: () => string | undefined
    /** The installation's durable identity (PDM-51). Optional so a route
     *  assembled without one (the version-route suite) answers as before. */
    installationId?: string
    /**
     * The installation's wire-form public key (POD-4533), advertised next to
     * the id so a client that resolved a locator record can confirm the
     * candidate is the installation it paired with — id AND key must both
     * match before the URL is adopted. Public by design: every mobile client
     * already receives it in its pairing envelope. Both-or-neither with the
     * id; an old caller passing only the id answers exactly as before.
     */
    installationPublicKey?: string
    /**
     * The Connect link that always lands on this server (POD-5921), while
     * Connect publishing is on. Public like the id it is built from; `podium
     * status` and setup print it for the operator to bookmark.
     */
    stableLink?: () => string | undefined
    /**
     * The grade of the visibility policy this server actually runs (POD-376).
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
    /**
     * May answer asynchronously: on a development server, naming the target
     * means reading HEAD, and this process serves every client of the instance
     * — so that git call is off its event loop (POD-2048).
     */
    updateTarget?: () => UpdateTarget | undefined | Promise<UpdateTarget | undefined>
    appVersion?: () => string
    /** Source identity of this server process, independent of its display version. */
    sourceDigest?: () => string | undefined
    /** Whether this process owns an installed package or a source checkout. */
    installKind?: () => 'installed' | 'source'
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
    /**
     * The desktop website on disk — the one a browser pointed at this origin is
     * running (POD-2721).
     *
     * Read per request, and for the same reason the phone's is: this server can
     * be handed a new dist without restarting, and an identity captured at boot
     * would keep naming the build it replaced. That freshness is the whole
     * point — an open page asks this to find out its own assets have moved.
     *
     * Reported even when `present` is false, unlike `mobileWeb`: "there is no
     * website here" is an answer a page can use (it is not being served by this
     * server), whereas silence is not.
     */
    web?: () => ServedWebIdentity
    /** Parent health gate + settings: is the local daemon connected? */
    daemonConnected?: () => boolean
    /**
     * Where the web UI is served from, when it is not this server (PDM-26).
     *
     * On the PRE-BOOT probe for the same reason `feedScoping` is: a client that
     * has to go somewhere else for its UI must learn that from the one request
     * it already makes first, not from a frame it can only receive after it has
     * loaded a page this origin does not have. Absent means "here", which is
     * every self-hosted install.
     */
    appUrl?: () => string | undefined
    /** Janitor co-host status for DEGRADED projection [POD-2505]. */
    janitor?: () =>
      | {
          state: 'running' | 'degraded' | 'stopped'
          reason?: string
          /** Advance token the parent's watchdog reads (§8, gap 9). */
          progressVersion?: number
        }
      | undefined
  },
): void {
  /**
   * WHAT THIS SERVER IS SERVING, LOGGED WHEN IT MOVES (POD-3224, question 11).
   *
   * `/version` is read once every 30 s by every open tab and once a second while
   * an update runs, so logging the response would be the loudest line in the
   * process. What is worth a record is the CHANGE: the served identity moving is
   * the exact event that makes every already-loaded page stale, and it is the
   * fact `assets === 'replaced'` on the client is derived from. One line per
   * release, on the server, is what lets a stale-page report be lined up against
   * the moment the dist under it was replaced.
   *
   * Held in a closure rather than compared against a stored row: this is a
   * property of THIS PROCESS's disk as it currently reads, and a successor
   * legitimately reports its own first read as a change.
   */
  let servedIdentity: string | undefined
  const noteServed = (
    appVersion: string,
    sourceDigest: string | undefined,
    web: ServedWebIdentity | undefined,
    mobileWeb: MobileWebIdentity | undefined,
  ): void => {
    const signature = [
      appVersion,
      sourceDigest ?? '',
      web?.present === true ? (web.bundle ?? '') : 'absent',
      web?.digest ?? '',
      mobileWeb?.present === true ? (mobileWeb.digest ?? '') : 'absent',
    ].join('|')
    if (signature === servedIdentity) return
    const first = servedIdentity === undefined
    servedIdentity = signature
    versionLog.info(first ? 'serving' : 'served identity changed', {
      appVersion,
      ...(sourceDigest ? { sourceDigest } : {}),
      webPresent: web?.present === true,
      ...(web?.bundle ? { webBundle: web.bundle } : {}),
      ...(web?.digest ? { webDigest: web.digest } : {}),
      mobileWebPresent: mobileWeb?.present === true,
      ...(mobileWeb?.digest ? { mobileWebDigest: mobileWeb.digest } : {}),
    })
  }

  app.get('/version', async (c) => {
    let target: UpdateTarget | undefined
    try {
      target = await deps.updateTarget?.()
    } catch {
      target = undefined
    }
    let mobileWeb: MobileWebIdentity | undefined
    try {
      mobileWeb = deps.mobileWeb?.()
    } catch {
      mobileWeb = undefined
    }
    let web: ServedWebIdentity | undefined
    try {
      web = deps.web?.()
    } catch {
      web = undefined
    }
    const sourceDigest = deps.sourceDigest?.()
    noteServed(
      deps.appVersion?.() ?? process.env.PODIUM_APP_VERSION ?? 'dev',
      sourceDigest,
      web,
      mobileWeb,
    )
    const daemonConnected = deps.daemonConnected?.() === true
    const janitor = deps.janitor?.()
    const components = {
      ...(janitor ? { janitor } : {}),
      daemon: { state: daemonConnected ? ('connected' as const) : ('disconnected' as const) },
    }
    return c.json({
      wireVersion: CLIENT_WIRE_VERSION,
      minSupportedVersion: MIN_CLIENT_WIRE_VERSION,
      /**
       * Structural fingerprint of this server's message schemas. Alongside the
       * wire version, it lets clients report build drift without treating it as
       * a hard compatibility decision.
       */
      wireSchemaDigest: wireSchemaDigest(),
      appVersion: deps.appVersion?.() ?? process.env.PODIUM_APP_VERSION ?? 'dev',
      ...(sourceDigest ? { sourceDigest } : {}),
      ...(deps.installKind ? { installKind: deps.installKind() } : {}),
      instanceId: deps.instanceId,
      ...(deps.workspaceId?.() ? { workspaceId: deps.workspaceId() } : {}),
      ...(deps.installationId ? { installationId: deps.installationId } : {}),
      ...(deps.installationId && deps.installationPublicKey
        ? { installationPublicKey: deps.installationPublicKey }
        : {}),
      ...(deps.appUrl?.() ? { appUrl: deps.appUrl() } : {}),
      ...(deps.stableLink?.() ? { stableLink: deps.stableLink() } : {}),
      feedScoping: deps.visibilityGrade?.() ?? 'device-unscoped',
      daemonConnected,
      components,
      ...(target ? { target } : {}),
      ...(mobileWeb?.present ? { mobileWeb } : {}),
      ...(web ? { web } : {}),
    })
  })
}

function proxyHopsFromEnv(env: Record<string, string | undefined>): number {
  const raw = env.PODIUM_TRUSTED_PROXY_HOPS
  if (raw === undefined || raw === '') return 0
  return /^\d+$/.test(raw) ? Number(raw) : Number.NaN
}

/** A loopback-bound Podium can only receive network traffic through a local
 *  proxy, so trust that one hop by default. This makes a newly saved Tailscale
 *  Serve or Funnel setup work without a restart or a second environment setting.
 *  Explicit options and env configuration always win, including zero. */
export function resolveTrustedProxyHops(
  explicit: number | undefined,
  env: Record<string, string | undefined>,
  bindHost: string,
): number {
  if (explicit !== undefined) return explicit
  if (env.PODIUM_TRUSTED_PROXY_HOPS !== undefined && env.PODIUM_TRUSTED_PROXY_HOPS !== '') {
    return proxyHopsFromEnv(env)
  }
  return isLoopbackHost(bindHost) ? 1 : 0
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

/** How often expired invitations and one-time codes are deleted. */
const IDENTITY_SWEEP_INTERVAL_MS = 60 * 60 * 1000

export async function startServer(
  opts: {
    port?: number
    host?: string
    /**
     * HOSTED OR SELF-HOSTED (server-mode.ts): the one place a composition root
     * says which. Absent: self-hosted. Hosted has no machine of its own and
     * turns off every shortcut that trusts this computer.
     */
    mode?: ServerMode
    /** False when this server has no fleet machine of its own. Default: the local install. */
    hostMachine?: false
    role?: Partial<ServerRoleConfig>
    /**
     * THE PARTS THIS PROCESS RUNS (POD-7332; POD-6954 design 4.1): any of
     * `api` (the HTTP app), `sync` (client sync sockets and daemon links) and
     * `worker` (the janitor and every background job). Absent:
     * PODIUM_SERVER_ROLES, else all of them, which is every self-hosted server.
     * A role this process does not run opens none of its listeners or loops.
     * `room` is reserved for POD-7313; migrating is `podium server migrate`.
     */
    roles?: readonly string[]
    /** Build-time extensions (the cloud seam — plugins.ts). OSS ships none. */
    plugins?: PodiumPlugin[]
    /**
     * THE WORKSPACE THIS PROCESS LOADS. Hosted: required; the store, the files
     * and the identity open this id, and a request is bound to it at the edge
     * (workspace-edge.ts). Self-hosted: a label a router in front of the
     * server may route by (pairing commands carry it); the store holds
     * `local`.
     */
    workspaceId?: string
    /** Hosted: the loaded workspace's slug, which a request's selector may name. */
    workspaceSlug?: string
    /**
     * THE IDENTITY SEAM (docs/design/people-and-sign-in.md, section 3). Absent,
     * which is every self-hosted server: the server builds the identity core on
     * its own database. Present: a hosted composition root hands the server the
     * workspace half of a core it built on Postgres. A function, because the
     * member rows port exists only after the server has opened its store.
     */
    identity?: IdentitySeam
    /** Fake only the membership timer; database and transport behavior stays real. */
    membershipCatchUpSchedulerForTests?: MembershipCatchUpScheduler
    /**
     * Tests only: the ids of the members this server mints when it built its
     * own identity core, so a fixture's members have ids a test can name.
     */
    newMemberIdForTests?: () => string
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
    /**
     * Whether this process mirrors daemon transcripts into the lake (PDM-26).
     *
     * A composition root that knows its own storage story may state it directly;
     * otherwise it is resolved from PODIUM_TRANSCRIPT_LAKE → config.transcriptLake
     * → 'on', which is every install that exists today.
     */
    transcriptLake?: 'on' | 'off'
    /**
     * TEST ONLY. Replaces the janitor worker client so server tests never spawn
     * a thread (PDM-27). It is not an opt-out: absent means the real client, and
     * every server process hosts a janitor. Production callers must not set it.
     */
    janitorWorkerForTests?: import('./janitor-host').StartJanitorWorkerFn
  } = {},
): Promise<ServerHandle> {
  const rehearsal = process.env.PODIUM_REHEARSAL === '1'
  const config = loadConfig()
  // WHICH PARTS THIS PROCESS RUNS (POD-7332), decided before anything opens:
  // an unknown role fails the boot here. Each listener, timer and loop below
  // asks `runs`, and names itself in `started` when it starts.
  const roles = resolveServerProcessRoles(opts.roles, process.env)
  const runs = { api: roles.has('api'), sync: roles.has('sync'), worker: roles.has('worker') }
  const started = new Set<string>()
  // A promoted server's durable listen contract outranks the target daemon's
  // process environment; an explicit caller option still wins.
  const host = resolveBindHost({
    ...opts,
    ...(opts.host === undefined ? { host: config.bindHost } : {}),
  })
  if (rehearsal && (!['127.0.0.1', '::1'].includes(host) || process.env.PODIUM_CONNECT !== 'off')) {
    throw new Error('PODIUM_REHEARSAL requires loopback and PODIUM_CONNECT=off')
  }
  const configuredProxyHops = resolveTrustedProxyHops(opts.trustedProxyHops, process.env, host)
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
  const appSourceDigest = serverBuildSourceDigest()
  const instanceId = resolveInstanceId()
  // THE DEPLOYMENT'S ANSWERS, resolved once at boot (PDM-26). Every one of these
  // is `env → config.json → default`; reading them here rather than at each use
  // site keeps this process's shape decided in one place, and makes the env
  // layer's "boot-time, never stale" property literally true.
  const envMode = resolveMode(config, process.env)
  // Fails the boot rather than advertising a UI origin whose browser could never
  // hold this server's session cookie (PDM-26).
  assertAppUrlCompatible(config, process.env)
  const feedPollingEnabled = resolveUpdateFeedPolling(config, process.env)
  const updateScope = resolveUpdateScope(config, process.env)
  const fleetOnly = updateScope === 'fleet-only'
  ensureInstanceStateIdentity({ instanceId })
  // Role composition (roles.ts): which optional module groups this process
  // activates. Explicit opts win; else the H1 shape, core + hub.
  const desktopSupervised = process.env.PODIUM_DESKTOP_SUPERVISED === '1'
  const role = resolveServerRole(opts.role)
  // WHO THIS HOST IS, read (or minted) once, before anything can write a row. Every
  // other consumer in the process takes it from here — the store carries it to the
  // repos aggregate, `MachinesService` takes it as a dep, and the maintenance realm
  // and in-process daemon link below name this same value. The split-mode daemon
  // reads the same file in its own process; all-in-one is handed it in memory.
  // WHAT THIS SERVER MAY DO, derived once from its mode (server-mode.ts). Every
  // host-only shortcut below asks this object, never the options it came from.
  const capabilities = serverCapabilities({ mode: opts.mode, hostMachine: opts.hostMachine })
  // The one workspace this process loads (POD-7309): `local` on self-hosted,
  // the one the hosted root names otherwise. A request is bound to it at the
  // edge, and a request that names another one is refused there.
  const loadedWorkspaceId =
    capabilities.mode === 'hosted' ? hostedWorkspaceId(opts.workspaceId) : SELF_HOSTED_WORKSPACE_ID
  const hostMachine: HostMachine = capabilities.hostMachine
    ? { id: asMachineId(readOrCreateLocalMachineId()) }
    : null
  const serverPlacement: ServerPlacement = hostMachine
    ? { kind: 'fleet', machineId: hostMachine.id }
    : { kind: 'external' }
  const isHostLocal = (request: Request): boolean =>
    capabilities.sameMachineTrust && isHostLocalRequest(request)
  const transferBootMode = serverTransferBootMode(stateDir())
  const recoveryOnly = transferBootMode === 'recovery-only'
  if (!recoveryOnly) assertWritableServerBoot(stateDir())
  const portableStateFence = new PortableStateFence()
  if (recoveryOnly) await portableStateFence.acquire()
  // WHERE USER FILES LIVE (POD-6963 design 2.8): the state directory or one
  // bucket, resolved once from PODIUM_FILE_STORAGE_* → config.fileStorage. A
  // misconfigured bucket fails the boot here, before anything listens. Each
  // workspace's service graph takes its own handle (`forWorkspace`) below.
  const fileStorage = createServerFileStorage(resolveFileStorage(config, process.env), {
    stateDir: stateDir(),
    fence: portableStateFence,
  })
  if (!recoveryOnly) {
    const removed = await fileStorage.removeLeftoverTempFiles()
    if (removed > 0) log.info('removed temp files left by interrupted file writes', { removed })
  }
  // One database, and this install's one workspace over it (POD-7010). Its
  // location names its engine (POD-6994): the state directory's SQLite file, or
  // the Postgres database PODIUM_DATABASE_URL names. The sync worker and the
  // janitor open their read sessions on the same location.
  const databaseLocation = storeLocation(process.env, config)
  const database = await StoreDatabase.open(databaseLocation, hostMachine, {
    queryOnly: recoveryOnly,
    bootWorkspace: loadedWorkspaceId,
    migrateAtBoot: storeMigratesAtBoot(),
    wakeUp: storeWakeUpOptions(),
  })
  const store = await database.workspace(loadedWorkspaceId)
  // Artifacts stored before the blob store under names that are not key segments move to
  // their encoded keys, once, before anything serves them (POD-7054).
  if (!recoveryOnly && fileStorage.backend === 'local') {
    await convertArtifactKeys({ stateDir: stateDir(), log, fence: portableStateFence })
    // Composer uploads kept their records in meta.json files; those become rows (POD-7055).
    await convertPendingUploadRecords({
      stateDir: stateDir(),
      records: store.pendingUploads,
      log,
      fence: portableStateFence,
    })
  }
  const workspaceFiles = fileStorage.storage.forWorkspace(loadedWorkspaceId)
  // Legacy reads remain available while the background pass splits the lake.
  // Mirror writes join the same per-file conversion before touching its parts.
  const lakeConversionAbort = new AbortController()
  const convertingLake = !recoveryOnly
    ? new ConvertingLake({
        stateDir: stateDir(),
        rows: store.conversations.mirror,
        blobs: workspaceFiles,
        workspaceId: loadedWorkspaceId,
        log,
        fence: portableStateFence,
        signal: lakeConversionAbort.signal,
        // Parts on a bucket take no local disk, so there is nothing to preflight.
        ...(fileStorage.backend === 'local' ? {} : { freeBytes: undefined }),
      })
    : undefined
  let lakeConversionWork: Promise<unknown> | undefined
  // The installation identity follows server authority across transfers.
  const installation = await store.secrets.installationIdentity()
  const installationPublicKey = installationPublicKeyWire(installation)
  // In the store's server_secrets, read through its lifecycle port (POD-6994).
  const updateSigningKey = await database.updateSigningKey({
    allowCreate: !recoveryOnly && (await store.machines.listMachines()).length === 0,
  })
  const activeServerMove = (await store.operations.active()).find(
    (row) => row.kind === 'server-move',
  )?.operation
  reconcileSafeServerTransferBoot(stateDir(), activeServerMove)
  // THE IDENTITY OF THIS SERVER (POD-6746) opens once the registry exists,
  // below. The registry holds two of its handles, a member's account
  // credentials and the relocation codes, and reads them only when a request
  // or a server move uses them, after the boot.
  let openedIdentity: ServerIdentity | undefined
  const serverIdentity = (): ServerIdentity => {
    if (!openedIdentity) throw new Error('the server identity is read before it is open')
    return openedIdentity
  }
  const credentials = memberCredentials(store.users, () => serverIdentity().workspace.core.accounts)
  // Readiness gate: a bloated change log is fully pruned in
  // bounded, yielding units before the server starts serving catch-up reads.
  // The server does not listen meanwhile.
  if (!recoveryOnly) {
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
      log.warn(
        'boot retention exceeded the placement threshold — candidate for janitor placement',
        {
          durationMs: bootPrune.metrics.totalDurationMs,
        },
      )
    }
  }
  // The Settings toggle is the bottom layer; env and config.json sit above it.
  // Read at boot because the lake's presence decides how the registry is built —
  // flipping the toggle takes effect on the next start, which is what the
  // settings copy says.
  const lakeEnabled =
    (opts.transcriptLake ??
      resolveTranscriptLake(
        (await store.settings.getSettings()).transcripts.mirror,
        config,
        process.env,
      )) === 'on'

  /**
   * LATE-BOUND, because the two halves are constructed in this order and cannot
   * be reordered: the updates service (inside the registry) owns the resolver,
   * and the dev feed's address, fence, trust root and credential all come from
   * the publisher wiring below, which needs the registry to exist first.
   *
   * A function rather than a value, so a Settings write to Public URL — or a
   * remote machine joining the fleet — is followed without a restart, the same
   * discipline every other read on this path uses.
   */
  let devChannelFeed: (() => ChannelFeed | undefined) | undefined
  // ANNOTATED BECAUSE THE INITIALIZER REFERS TO ITSELF. `modelProbe` below closes
  // over `registry`, so inferring the type means inferring it from an expression
  // that already needs it. TypeScript tolerates that only while it can resolve
  // `SessionRegistry` without walking back through this binding, and the router
  // type graph has now grown past that point: `tsc` reports TS7022 here and
  // TS7023/TS7006 downstream of it. Naming the type cuts the cycle at the site,
  // which is why it does not come back the next time a procedure is added.
  //
  // NOTE FOR ANYONE WHO CANNOT REPRODUCE IT: the repo's `typecheck` task runs
  // `tsgo`, which does not report this family; `tsc --noEmit` in apps/server
  // does. That difference is why the same tree was honestly reported as both
  // clean and broken by different readers (POD-1858, POD-1862).
  const registry: SessionRegistry = await SessionRegistry.create(store, undefined, {
    serverPlacement,
    capabilities,
    instanceId,
    memberCredentials: credentials,
    clientRelocationCodes: () => serverIdentity().workspace.core.codes,
    afterServerMoveJournalCommitted: serverMoveCommitEvidenceHook(),
    devChannelFeed: () => devChannelFeed?.(),
    recoveryOnly,
    rehearseBoot: rehearsal,
    // The registry's sweeps and recovery passes are the worker's (POD-7332).
    backgroundWork: runs.worker,
    // The server's baked product label is the Phase 1 target identity. The richer
    // release-manifest descriptor remains an optional /version publication seam.
    targetVersion: () => appVersion,
    // Absent under `transcriptLake: 'off'` (PDM-26), which is the no-op shape
    // TranscriptLake already supports — the mirror and the indexer are simply
    // never constructed. Spread rather than `undefined` so its absence keeps
    // meaning exactly what it means for every test that omits it today.
    // The lake keeps its parts in this workspace's files (transcript-mirror
    // spec §2.1, POD-6963 design 2.3): `<state>/transcripts` on local disk, the
    // workspace's prefix on a bucket.
    ...(lakeEnabled
      ? {
          transcriptLake: {
            blobs: workspaceFiles,
            workspaceId: loadedWorkspaceId,
            lake: convertingLake,
          },
        }
      : {}),
    files: workspaceFiles,
    portableStateFence,
    // Inbound daemon pairing is a HUB capability, injected here (the composition
    // root) so core (relay/machines) never imports hub/pairing — see roles.ts.
    // Node role = no manager = `pair` handshakes rejected, minting throws; the
    // local daemon's `hello` path is untouched.
    ...(role.hub
      ? { pairing: new PairingManager({ installationId: installation.installationId }) }
      : {}),
    // The fleet's hub-only writes on `sync.submit` follow the role too (POD-6417).
    servesHub: role.hub,
    installationId: installation.installationId,
    updatePubkey: () => updateSigningKey.publicKey,
    // Under `updateScope: 'fleet-only'` this server's binary belongs to the
    // deployment, so the wave planner drops the coordinator row instead of
    // holding it for a step nothing will ever take (PDM-26).
    ...(fleetOnly ? { coordinatorExcluded: () => true } : {}),
    updateKeyRotations: () => updateSigningKey.rotations,
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
    modelProbe: async (machineId) => await registry.modules.rpc.modelProbe(machineId),
  })
  // THE IDENTITY OF THIS SERVER (POD-6746): one workspace-bound core, built on
  // this store or handed in through the seam. Everything below that signs
  // someone in or asks who a request is goes through it.
  //
  // OPENED AFTER THE REGISTRY, BEFORE THE SERVER SERVES (POD-6939). Opening it
  // writes member rows: the hosted boot catch-up applies the memberships that
  // changed while the server was down, the seam's own membership operations
  // apply theirs, and a self-hosted upgrade adopts its member. A member write is
  // a change-log commit, and the registry is what wires it (POD-6920); before
  // it, the store captures the write with nothing to drain it and refuses it.
  const identity = await openServerIdentity(store, {
    ...(capabilities.mode === 'hosted' ? { workspaceId: loadedWorkspaceId } : {}),
    seam: opts.identity,
    readOnly: recoveryOnly,
    newMemberId: opts.newMemberIdForTests,
  })
  openedIdentity = identity
  const membershipCatchUp =
    !identity.local && !recoveryOnly && !rehearsal && runs.worker
      ? startMembershipCatchUp(identity.workspace, opts.membershipCatchUpSchedulerForTests)
      : undefined
  if (membershipCatchUp) started.add('worker.membershipCatchUp')
  // Expired invitations and one-time codes are deleted hourly (section 2.3).
  // Not on a store that cannot be written, and not in a boot rehearsal.
  // LEGACY(remove-after: 2027-06): bootstrap and sweep pre-upgrade device sign-ins.
  // The sign-in carry-over (POD-6751) is built below, once the request
  // resolver exists; the same hourly timer sweeps its leftovers.
  let signInCarryOver: SignInCarryOver | undefined
  let stopIdentitySweep = (): void => {}
  if (!recoveryOnly && !rehearsal && runs.worker) {
    started.add('worker.identitySweep')
    const sweep = setInterval(() => {
      void identity.workspace.core
        .sweep()
        .catch((err) => log.warn('identity sweep failed; the next hour retries', { err }))
      void signInCarryOver
        ?.sweep()
        .catch((err) => log.warn('sign-in carry-over sweep failed; the next hour retries', { err }))
    }, IDENTITY_SWEEP_INTERVAL_MS)
    sweep.unref?.()
    stopIdentitySweep = () => clearInterval(sweep)
  }
  // IS SIGN-IN REQUIRED: one answer, the package's (section 5.5), read by the
  // status route, pairing, the tRPC `auth.*` procedures and the exposure
  // warning. It is not a gate: a request is admitted by `memberOfRequest` alone.
  const credentialsRequired = (): Promise<boolean> => identity.workspace.signInRequired()
  // WHY sign-in is mandatory, for Access to explain. Reporting only: the answer
  // is the package's. A hosted workspace always requires it; a second active
  // member ends open mode whatever `authOpenMode` says (POD-6285).
  const loginPolicy = async (): Promise<
    import('./modules/instance/service').InstanceLoginPolicy
  > => {
    const loginRequired = await credentialsRequired()
    const loginRequiredReason =
      capabilities.mode === 'hosted'
        ? 'hosted'
        : loginRequired && (await store.users.hasSeveralActiveMembers())
          ? 'several-members'
          : null
    return { loginRequired, loginRequiredReason }
  }
  const adoptionStarted = performance.now()
  const bootTargetPromotion = readNewestTargetPromotionMetadata(stateDir())
  // The owned worker receives this capability only through workerData. Each
  // generation replaces it, so neither a persisted fleet secret nor an old
  // worker's credential authorizes the private maintenance channel.
  let maintenanceToken = recoveryOnly ? '' : randomBytes(32).toString('base64url')
  const rotateMaintenanceToken = (): string => {
    maintenanceToken = randomBytes(32).toString('base64url')
    return maintenanceToken
  }
  const setupStarted = performance.now()
  if (!recoveryOnly) {
    const supervisorSetup = hostMachine ? loadSupervisorState(stateDir()) : undefined
    const setupRequest = supervisorSetup?.setupEnrollment
    if (hostMachine && setupRequest && !supervisorSetup?.enrolledPublicKey) {
      const stagedHash = readLegacyInstancePasswordHash()
      const passwordHash =
        stagedHash ??
        (process.env.PODIUM_PASSWORD ? await hashPassword(process.env.PODIUM_PASSWORD) : undefined)
      const receipt =
        (await completePreauthorizedSetup(
          store,
          credentials,
          installation.installationId,
          setupRequest,
          passwordHash,
        )) ??
        // A host upgraded from 0.1.0 staged this request to re-key its legacy row (POD-5931).
        (await adoptLegacyHostMachine(store, installation.installationId, setupRequest))
      if (receipt) {
        // Credential activation and enrollment committed together. Files and parent RPC happen afterwards.
        // The actor has a password now: the staged one, or an earlier one that wins.
        // Either way the staged file has nothing left to give.
        if (stagedHash && receipt.actor && (await credentials.hasPassword(receipt.actor)))
          deleteLegacyInstancePasswordFile()
        try {
          if (!rehearsal)
            await requestParentEnrollment({
              action: 'confirm',
              agentExecution: receipt.agentExecution,
              setupRequestId: receipt.requestId,
              publicKey: receipt.publicKey,
              installationId: receipt.installationId,
            })
        } catch (error) {
          log.warn('setup enrollment committed; parent confirmation will retry', { err: error })
        }
      }
    } else if (!setupRequest) {
      // Existing installations may still have a staged login password. This never creates a machine.
      const adopted = await adoptStagedFirstAdminPassword({ users: store.users, credentials })
      if (adopted.outcome === 'adopted' && adopted.userId)
        await registry.modules.machines.grantHostMachineIfUnowned(adopted.userId)
      const applied = await applyEnvFirstAdminPassword({ users: store.users, credentials })
      if (applied.applied && applied.userId)
        await registry.modules.machines.grantHostMachineIfUnowned(applied.userId)
    }
  }
  bootStage('setup enrollment', setupStarted)
  // RETIRED at POD-309: the node⇄hub dialer (`UpstreamSync`) and the issue write
  // forwarder (`UpstreamForwarder`) were constructed here when config.json carried an
  // `upstream` block. Federation is deferred, not cancelled (, ADR 5 D1);
  // what survives it is the SEAM — authority/feed identity, outbox attribution,
  // the reserved node-peer caps, and kernel ports with no transport baked in —
  // none of which is wired from this composition root.
  //
  // Anything an operator had QUEUED in `upstream_outbox` when this build lands is
  // parked, not discarded: `reportParkedUpstreamMutations` is the operator-visible
  // half of that (ADR 5 D8: "silent discard of poison/pending work is forbidden").
  if (!recoveryOnly) await reportParkedUpstreamMutations(store.sync, store.events)
  // Telemetry. The server is the sole emitter (D10). Usage is on
  // unless turned off, crash is off unless turned on (POD-5922). Wiring is
  // unconditional and consent is read fresh per record/flush (D4/D9), so a tier
  // that is off collects NOTHING, and a change takes effect without a restart.
  // The install id is minted here, once, when a tier is on by default (never on
  // a query-only recovery boot); a failure must never stop the server booting.
  if (!recoveryOnly) await store.settings.ensureTelemetryIdentity().catch(() => false)
  let telemetryMachineCount = (await registry.modules.machines.listMachines()).length
  const refreshTelemetryMachineCount = (): void => {
    void registry.modules.machines
      .listMachines()
      .then((rows) => {
        telemetryMachineCount = rows.length
      })
      .catch(() => {})
  }
  registry.modules.bus.on('machine.metadataChanged', refreshTelemetryMachineCount)
  const telemetry = wireTelemetry({
    bus: registry.modules.bus,
    machineCount: () => telemetryMachineCount,
    loadConfig: () => store.settings.telemetryConfig(),
  })
  const repos = new RepoRegistry(registry, store)
  // Automatic connect-scan orchestration RETIRED from the bus path [POD-925]:
  // janitor issues connect-scan commands; deep scans stay interactive via API.
  const superagent = await SuperagentService.create(registry.modules, repos, store)
  // The registry owns disposal on failed listen and in test harnesses. Normal
  // shutdown also settles its reaper before store.close starts scheduler drain.
  registry.adoptSuperagent(superagent)
  // Messaging-app bridge: two-way Telegram chat with the
  // superagent, riding the notification bot config. configure() is a no-op
  // until a bot token + chat id are set; settings.changed re-arms it live.
  // The Telegram bridge polls and sends in the background: the worker's
  // (POD-7332). A process without the role builds none, so no settings change
  // arms it; the factory keeps the construction below as it was.
  const newMessaging = (
    deps: ConstructorParameters<typeof MessagingService>[0],
  ): MessagingService | undefined => (runs.worker ? new MessagingService(deps) : undefined)
  const messaging = newMessaging({
    bus: registry.modules.bus,
    // Outbound routing is derived from the authenticated binding table, never
    // from one ambient operator/global chat id. Zero or ambiguous routes fail closed.
    routing: {
      chatIdForUser: async (userId) => {
        const routes = await store.telegramBindings.listForUser(userId)
        return routes.length === 1 ? routes[0]?.chatId : undefined
      },
      // POD-419: the bot token is server-only material; the chat id stays routing.
    },
    telegramBotToken: async () => await store.secrets.getOrEmpty('notifications.telegramBotToken'),
    // A chat message carries no client command: the bridge's sends write as the
    // bridge (`superagent.bridge`, ADR 12 D9, POD-6606).
    superagent: {
      sendTurn: async (input) =>
        await superagent.sendTurn(registry.modules.superagentBridgeWriter, input),
      interruptTurn: (input) => superagent.interruptTurn(input),
      restartThread: (input) => superagent.restartThread(input),
      startBtwTurn: async (input) => await superagent.startBtwTurn(input),
      ensureConciergeThread: async (input) => await superagent.ensureConciergeThread(input),
    },
    issues: registry.modules.issues.reports,
    sessions: registry.modules.sessions,
    topics: store.messagingTopics,
    sessionIssueId: async (sessionId) =>
      await registry.modules.sessions.readSessionIssueId(sessionId),
    // Issue-topic entry recap: last messages from the bound
    // superagent (or btw origin) session transcript.
    topicRecap: {
      getSuperagentThread: async (threadId) => await store.superagent.getSuperagentThread(threadId),
      readTranscript: async (input) =>
        await registry.modules.rpc.readTranscript(input, { kind: 'system', id: 'answer-delivery' }),
    },
    telegramSetupPending: () => registry.modules.settings.hasPendingTelegramSetup(),
    // The binding table, read live per message: an inbound chat resolves to the
    // user that bound it, or to nobody and is refused (ADR 3 Amendment 1 D22).
    telegramBindings: store.telegramBindings,
    // Direct session attachment (POD-6212): the bound user's own sessions, through
    // the session command plane under that user's principal.
    directSessions: directSessionPort(registry.modules, store),
    sessionAttachments: store.messagingSessionAttachments,
  })
  if (messaging && !recoveryOnly && !rehearsal) {
    messaging.configure()
    started.add('worker.messaging')
  }
  const cloud = createCloudRuntimeProviderFromEnv()
  const devArtifactToken = readOrCreateDevArtifactToken()
  let boundPort = opts.port ?? 0
  // BUILD IDENTITY and PUBLISHER CAPABILITY are different facts. A development
  // server normally runs from the installed bundle (therefore uses installed
  // swap/rollback/handover) while PODIUM_DEV_SOURCE_ROOT gives it the checkout
  // from which it may mint the next bundle. Production services omit the opt-in.
  const developmentRuntime = resolveDevelopmentRuntime({
    // Must remain this literal read: build-bun replaces it with the packaged version.
    packagedVersion: process.env.PODIUM_APP_VERSION,
    sourceRunRoot: DEVELOPMENT_SOURCE_ROOT,
  })
  const developmentSourceRoot = developmentRuntime.publisherSourceRoot
  /**
   * The version the parent installed for THIS operation, which is the version
   * the handover's health gate must see the successor serving. Written by the
   * update ask, read by the restart ask — the producer finding 15 said the
   * parameter did not have.
   */
  let pendingCoordinatorVersion: string | undefined
  /**
   * BY CONSTRUCTION, NOT BY PROBE (PDM-26). `canRestartServer` is derived from
   * `requestCoordinatorRestart` being present (operation.ts), and under
   * `fleet-only` the deployment replaces this binary itself — so the honest way
   * to say "there is no server step here" is to not have one, rather than to
   * rely on a container happening to have no parent supervisor.
   */
  const requestCoordinatorRestart =
    !hostMachine || fleetOnly
      ? undefined
      : developmentRuntime.runningFromSource
        ? createSourceRedeployRequest({ instanceId })
        : createInstalledCoordinatorRestart({
            instanceId,
            port: () => boundPort,
            pendingVersion: () => pendingCoordinatorVersion,
          })
  const prepareCoordinatorUpdate =
    !hostMachine || fleetOnly || developmentRuntime.runningFromSource
      ? undefined
      : createInstalledCoordinatorUpdate({
          pinnedPubkey: updateSigningKey.publicKey,
          onInstalled: (version) => {
            pendingCoordinatorVersion = version
          },
        })
  const devPublisher = await wireDevBundlePublisher({
    sourceRoot: rehearsal || !capabilities.devUpdateFeed ? undefined : developmentSourceRoot,
    instanceId,
    artifactOrigin:
      !rehearsal && capabilities.devUpdateFeed && developmentSourceRoot
        ? resolveDevArtifactOrigin(config)
        : undefined,
    localArtifactOrigin: () => `http://127.0.0.1:${boundPort}`,
    hasRemoteUpdateConsumers: async () =>
      (await store.machines.listMachines()).some(
        (machine) => !machine.revokedAt && isRemoteUpdateConsumer(machine, hostMachine?.id),
      ),
    // FLEET-SCOPED darwin production: this host mints a Mac
    // bundle when a Mac has enrolled, and not otherwise. Read at build time, from the
    // inventories the daemons themselves reported.
    fleetPlatforms: async () =>
      fleetHeadlessPlatforms(
        (await store.machines.listMachines()).filter((machine) => !machine.revokedAt),
      ),
    // A proposal answers what THIS running server would change by building HEAD.
    // Fleet skew belongs to rollout; it must never move the build's changelog baseline.
    proposalRunningVersion: appVersion,
    ...(appSourceDigest ? { proposalRunningSha: appSourceDigest } : {}),
    artifactToken: devArtifactToken,
    setTarget: async (target) => await registry.modules.updates.setTargetFromProducer(target),
    setTargetUnavailable: async (reason) =>
      await registry.modules.updates.setTargetUnavailable('dev', reason),
    // The publish handoff (spec §6 step 4). Publisher and updater share this
    // process on a source host, so "go and pull what I just wrote" is a call.
    refreshDevTarget: async () => await registry.modules.updates.refreshTarget('dev'),
    signingKey: updateSigningKey.privateKey,
    locks: registry.modules.locks,
  })
  // COMPOSITION-OWNED, because only this root knows both halves: the resolver
  // lives in the updates service and the dev feed's address, fence, trust root
  // and credential all come from the publisher wiring. Installed servers with
  // no publisher return nothing here and simply have no dev feed to pull.
  devChannelFeed = devPublisher.channelFeed

  /** One real host participant when an installed parent can apply its grants. */
  const localUpdateParticipant =
    hostMachine &&
    process.env.PODIUM_MACHINE_UPDATE_OWNER !== 'supervisor' &&
    !recoveryOnly &&
    !rehearsal &&
    process.env.PODIUM_E2E_DISABLE_LOCAL_UPDATE_PARTICIPANT !== '1' &&
    !developmentRuntime.runningFromSource &&
    prepareCoordinatorUpdate &&
    requestCoordinatorRestart
      ? startLocalUpdateParticipant({
          machineId: hostMachine.id,
          appVersion,
          runtimeDir: join(stateDir(), 'runtime'),
          pinnedPubkey: updateSigningKey.publicKey,
          machines: registry.modules.machines,
          /**
           * THE SAME SEAM THE DAEMON PATH USES (POD-2741).
           *
           * `onUpdateStatus` in relay.ts calls the service and then the fleet
           * bridge, because the same frame is the running operation's progress
           * event. Handing this participant the bare service left the second
           * half undone for the one machine that reports without a socket: the
           * coordinator refused a target in 264 ms, the service recorded
           * `rejected`, and the operation's place sat at `granted` for the full
           * 150 s a caller was willing to wait — because nothing told it to
           * look. It settled only when some unrelated daemon reconnect happened
           * to fire the bridge, which is why the gate row flipped run to run.
           */
          updates: {
            onStatus: async (machineId, status) => {
              await registry.modules.updates.onStatus(machineId, status)
              const fleetChanged: Promise<void> | undefined =
                registry.modules.updateFleetBridge?.onFleetChanged()
              await fleetChanged
            },
          },
          connected: (machineId) => registry.modules.bus.emit('machine.connected', { machineId }),
        })
      : undefined
  /**
   * SAY WHEN THIS MACHINE IS ABOUT TO VANISH FROM ITS OWN FLEET (POD-2721).
   *
   * Declining the participant is not only "no updates here". The participant is
   * also what reports this machine's build and what makes it count as `online`,
   * so a coordinator that skips it keeps whatever version it last managed to
   * report and shows `online: false` for the rest of its uptime — which is
   * exactly how the incident looked from the fleet table, and which took a
   * process listing and a pidfile to explain.
   *
   * A packaged coordinator declining is the surprising case and the one worth a
   * warning; a source checkout, and the two deployments that have DECLARED they
   * own this binary (`updateScope: 'fleet-only'`, or a supervising daemon that
   * applies our grants), are documented shapes and stay quiet. Which reason gets
   * named is `updateParticipantSkip`, tested there.
   */
  if (hostMachine && localUpdateParticipant === undefined) {
    const { why, level } = updateParticipantSkip({
      fleetOnly,
      supervisorOwnsUpdates: process.env.PODIUM_MACHINE_UPDATE_OWNER === 'supervisor',
      runningFromSource: developmentRuntime.runningFromSource,
      recoveryOnly,
      participantDisabledForRun: process.env.PODIUM_E2E_DISABLE_LOCAL_UPDATE_PARTICIPANT === '1',
    })
    log[level](updateParticipantSkipNote(why))
  }

  /**
   * ADOPT WHATEVER THE PREVIOUS PROCESS WAS DOING (POD-2097/POD-2098, spec §3.4).
   *
   * The process that runs an update is the process an update replaces, so a
   * successor booting with an operation still open is the NORMAL path, not the
   * exceptional one. Each live operation is handed to its kind to be re-derived
   * from OBSERVABLE FACTS — never from what the dead process believed:
   *
   *  - `appVersion` is this binary's own identity. It is the whole answer to
   *    "did the server reach the target?", and getting it wrong in the other
   *    direction is today's silent bug: a rollback re-offers the same update
   *    instead of saying the swap failed.
   *  - `servedWebDigest` is the WEBSITE's — both dists, via the same reader the
   *    request path uses (POD-1980), so a phone export left behind is not read
   *    as a finished web step.
   *  - `machineDirectory` is the daemons' handshakes, which is the fact that
   *    outlives the coordinator; in-memory convergence state does not.
   *
   * IT RUNS HERE, not with the other module bootstrapping above, because the
   * update kind's runners need the publisher, the redeploy request and the
   * served stamps — none of which exist before this line — and it must still
   * precede `serveNative` below, so no client can observe a stale operation this
   * boot was going to correct.
   */
  const updateOperationBoot = async () =>
    updateOperationContext({
      updates: registry.modules.updates,
      operations: registry.modules.operations,
      // The host's own channel, resolved per boot (POD-2189) — see
      // `UpdatesService.operationChannel`. This root is the ADOPTION path, so a
      // literal here also decided which channel a resumed operation was read
      // back against.
      channel: await registry.modules.updates.operationChannel(serverPlacement),
      appVersion: () => appVersion,
      sourceDigest: serverBuildSourceDigest,
      serverInstallKind: developmentRuntime.runningFromSource ? 'source' : 'installed',
      serverPlacement,
      ...(desktopSupervised ? { desktopSupervised: true } : {}),
      preflightDatabaseBackup: async () => registry.sessionStore.preflightUpdateBackup(),
      latestDatabaseSnapshot: () => registry.sessionStore.latestDatabaseSnapshot(),
      ...(prepareCoordinatorUpdate ? { prepareCoordinatorUpdate } : {}),
      legacyTransferActive: () => legacyTransferInProgress(stateDir()),
      ...(requestCoordinatorRestart ? { requestCoordinatorRestart } : {}),
      ...(devPublisher.requestWebRebuild
        ? { requestWebRebuild: devPublisher.requestWebRebuild }
        : {}),
      servedWebDigest: () => servedWebSourceDigest(desktopWebDir()),
      servedMobileWeb: () => servedWebIdentity(phoneWebDir()),
    })
  //
  // AND IT CANNOT STOP THIS BOOT (POD-2147). Every fact the reality lookup
  // gathers below can throw — a machine row with a shape this binary does not
  // expect, a version string it cannot parse, a store read that fails — and
  // this is awaited before `serveNative`. `adoptOnBoot` contains all of it and
  // resolves regardless, abandoning the operations it cannot resume, so the
  // bare await here is safe by the engine's own contract rather than by a catch
  // at this call site. The server that cannot boot is the one that has to apply
  // the update that fixes it.
  // Preserve the parent supervisor's rollback/refusal context for update adoption.
  const parentReport = readParentOutcome()?.why
  const durableUsers = registry.sessionStore.users
  const serverMoveCrash = serverMoveFaultHook()
  if (!recoveryOnly)
    await registry.modules.operations.engine.adoptOnBoot(
      async (row) => {
        if (row.kind === 'server-move') {
          const details = row.operation?.details
          const targetMachineId =
            details && typeof details === 'object' && typeof details.targetMachineId === 'string'
              ? details.targetMachineId
              : undefined
          return {
            promoted: bootTargetPromotion?.state === 'promoted' ? bootTargetPromotion : null,
            promoting: bootTargetPromotion?.state === 'promoting' ? bootTargetPromotion : null,
            journal: registry.modules.serverTransfer.status(),
            machineId: hostMachine?.id,
            targetOnline:
              targetMachineId !== undefined &&
              registry.modules.machines.hasDaemon(asMachineId(targetMachineId)),
            now: Date.now(),
          }
        }
        return {
          appVersion,
          servedWebDigest: websiteDigestReader(
            () => servedWebSourceDigest(desktopWebDir()),
            () => servedWebIdentity(phoneWebDir()),
          )?.(),
          machineDirectory: await registry.modules.updates.fleet(),
          ...(parentReport ? { parentReport } : {}),
          now: Date.now(),
        } satisfies UpdateReality
      },

      (row) => {
        if (row.kind !== 'server-move') return updateOperationBoot()
        const details = row.operation?.details
        if (!details || typeof details !== 'object') return undefined
        const targetMachineId = details.targetMachineId
        const publicUrl = details.publicUrl
        const bindHost = details.bindHost
        const port = details.port
        const transferId = details.transferId
        const authorizedBy = details.authorizedBy
        if (
          typeof targetMachineId !== 'string' ||
          typeof publicUrl !== 'string' ||
          (bindHost !== '127.0.0.1' && bindHost !== '0.0.0.0') ||
          typeof port !== 'number' ||
          typeof transferId !== 'string' ||
          typeof authorizedBy !== 'string'
        )
          return undefined
        return {
          service: registry.modules.serverTransfer,
          engine: registry.modules.operations.engine,
          input: {
            targetMachineId: asMachineId(targetMachineId),
            publicUrl,
            bindHost,
            port,
            confirmation: 'TRANSFER SERVER' as const,
          },
          authorization: serverMoveAuthorization({
            authorizedBy,
            targetMachineId,
            machines: registry.modules.machines,
            roleOf: (userId) => durableUsers.roleOf(userId),
          }),
          authorizedBy,
          transferId,
          sourceMachineId: registry.modules.serverTransfer.sourceMachineId(),
          publicUrl,
          bindHost,
          port,
          ...(serverMoveCrash ? { crash: serverMoveCrash } : {}),
        }
      },
      { resume: !rehearsal },
    )
  if (!recoveryOnly && parentReport) clearParentOutcome()
  // THE UPDATE EFFECT'S PORTS (POD-6358). An update request is an effect record
  // the Operations engine runs; a record from any client runs with the same
  // process ports a request carries on its tRPC context (below). Bound after
  // adoption, so a record that waited through a restart starts on the server
  // that will serve it; until now it stays pending.
  if (!recoveryOnly)
    registry.modules.updateEffects?.bindPorts({
      updates: registry.modules.updates,
      operations: registry.modules.operations,
      store: registry.sessionStore,
      serverPlacement,
      serverInstallKind: developmentRuntime.runningFromSource ? 'source' : 'installed',
      ...(desktopSupervised ? { desktopSupervised: true } : {}),
      ...(prepareCoordinatorUpdate ? { prepareCoordinatorUpdate } : {}),
      ...(requestCoordinatorRestart ? { requestCoordinatorRestart } : {}),
      ...(devPublisher.requestWebRebuild
        ? { requestWebRebuild: devPublisher.requestWebRebuild }
        : {}),
      servedWebDigest: () => servedWebSourceDigest(desktopWebDir()),
      servedMobileWeb: () => servedWebIdentity(phoneWebDir()),
    })

  bootStage('machines updates adoption', adoptionStarted)
  const deferredSourceJournal = registry.modules.serverTransfer.status()
  const deferredSourceMove =
    deferredSourceJournal &&
    ['preparing', 'staged', 'validated', 'fence-pending'].includes(deferredSourceJournal.state) &&
    deferredSourceJournal.record.sourceMachineId === hostMachine?.id &&
    registry.modules.operations.engine.isAdoptionDeferred(deferredSourceJournal.record.operationId)
      ? {
          operationId: deferredSourceJournal.record.operationId,
          transferId: deferredSourceJournal.record.transferId,
          targetMachineId: deferredSourceJournal.record.targetMachineId,
        }
      : undefined

  const deferredPromotion =
    bootTargetPromotion?.state === 'promoting' &&
    registry.modules.operations.engine.isAdoptionDeferred(bootTargetPromotion.operationId)
      ? bootTargetPromotion
      : undefined
  let serverMoveDataPlaneDeferred = deferredPromotion !== undefined
  // Keeps Connect's record of where this server is reachable current. Started
  // once the listener is up (below); reads PODIUM_CONNECT and the public URL
  // per tick, so both land without a restart. The base URL is a boot fact.
  // The address this server claims: what the Connect publisher sends and what
  // the locate proof signs over (POD-5921) — one reader, so the two never differ.
  const claimedPublicUrl = (): string | undefined =>
    serverMoveDataPlaneDeferred ? undefined : resolvePublicUrl(loadConfig(), process.env)
  const tunnelHealth = new TunnelHealthStore()
  const readTunnelHealth = () => tunnelHealth.read(claimedPublicUrl())
  const connectPublisher = new ConnectPublisher({
    client: connectClient({
      baseUrl: resolveConnectBaseUrl(config, process.env),
      identity: () => installation,
    }),
    identity: () => installation,
    publicUrl: claimedPublicUrl,
    enabled: () => store.settings.resolve('connectEnabled').value,
    log: createLogger('server:connect'),
    baseUrl: resolveConnectBaseUrl(config, process.env),
  })
  let stopDeferredPromotionPoll = (): void => {}
  if (deferredPromotion) {
    let settling = false
    const settle = async (): Promise<void> => {
      if (settling || !serverMoveDataPlaneDeferred) return
      const promoted = readPromotedTargetMetadata(stateDir(), deferredPromotion.transferId)
      if (!promoted || promoted.operationId !== deferredPromotion.operationId) return
      settling = true
      try {
        const operation = await registry.modules.operations.engine.resumeDeferredAdoption(
          deferredPromotion.operationId,
          {
            promoted,
            machineId: hostMachine?.id,
            journal: registry.modules.serverTransfer.status(),
            now: Date.now(),
          },
        )
        if (!registry.modules.operations.engine.isAdoptionDeferred(deferredPromotion.operationId)) {
          stopDeferredPromotionPoll()
          // Only exact promoted proof opens traffic. A final mismatched verdict
          // remains health-only and is durably visible as handoff-orphaned.
          if (operation?.state === 'done') serverMoveDataPlaneDeferred = false
        }
      } catch (error) {
        log.warn('deferred server move adoption retry failed', {
          operationId: deferredPromotion.operationId,
          err: error,
        })
      } finally {
        settling = false
      }
    }
    const poll = setInterval(() => {
      void settle()
    }, 50)
    poll.unref?.()
    stopDeferredPromotionPoll = () => clearInterval(poll)
    // Read immediately, then keep retrying while deferred. This closes both the
    // write-before-poll window and a transient reconciliation failure.
    void settle()
  }

  let startDeferredSourceMovePoll = (): void => {}
  let stopDeferredSourceMovePoll = (): void => {}
  if (deferredSourceMove) {
    let poll: ReturnType<typeof setInterval> | undefined
    let settling = false
    let stopped = false
    const settle = async (): Promise<void> => {
      if (settling || stopped) return
      if (!registry.modules.operations.engine.isAdoptionDeferred(deferredSourceMove.operationId)) {
        stopDeferredSourceMovePoll()
        return
      }
      const targetOnline = registry.modules.machines.hasDaemon(deferredSourceMove.targetMachineId)
      if (!targetOnline) return
      settling = true
      try {
        await registry.modules.operations.engine.resumeDeferredAdoption(
          deferredSourceMove.operationId,
          {
            journal: registry.modules.serverTransfer.status(),
            machineId: hostMachine?.id,
            targetOnline,
            now: Date.now(),
          },
        )
        if (!registry.modules.operations.engine.isAdoptionDeferred(deferredSourceMove.operationId))
          stopDeferredSourceMovePoll()
      } catch (error) {
        log.warn('deferred source server move adoption retry failed', {
          operationId: deferredSourceMove.operationId,
          transferId: deferredSourceMove.transferId,
          err: error,
        })
      } finally {
        settling = false
      }
    }
    startDeferredSourceMovePoll = () => {
      if (poll || stopped) return
      poll = setInterval(() => {
        void settle()
      }, 50)
      poll.unref?.()
      void settle()
    }
    stopDeferredSourceMovePoll = () => {
      stopped = true
      if (poll) clearInterval(poll)
      poll = undefined
    }
  }

  // Reconcile the recovery-snapshot catalogue with what is actually on disk and,
  // if anything is unproved, queue ONE background verifier (POD-3068). Not
  // awaited and not on the readiness path: proving a snapshot reads a whole
  // database, and boot may not wait for that any more than a request may.
  // This is also where a 0.1.0 install's existing `<db>.backup-v*` files and the
  // boot migration's own snapshots first enter the catalogue.
  //
  // LEGACY(remove-after: 2027-05): moves keys stored before the vault into it; removing it ends direct upgrades from versions before 2026-11 and drops the accounts table
  // First the old plaintext keys leave the retained snapshots (POD-7252), on a
  // worker thread and off the readiness path: a scrubbed snapshot changes size,
  // so it is catalogued and proved after the scrub, not before it. With nothing
  // to scrub this settles at once. It never rejects.
  if (runs.worker) {
    started.add('worker.snapshotCatalogue')
    void registry.sessionStore
      .scrubLegacySnapshots()
      .then(() => registry.sessionStore.discoverDatabaseSnapshots())
      .catch((error: unknown) =>
        log.error('reconciling the recovery-snapshot catalogue failed', { err: error }),
      )
  }

  const requestPeerAddresses = new WeakMap<Request, string>()
  /**
   * The request as the HTTP app sees it: `x-podium-peer-address` is the peer the
   * native server reported, never whatever the client sent. The WebSocket upgrade
   * cannot take this copy — Bun upgrades the object it was handed — so anything
   * that judges an upgrade's locality reads it through here (POD-4664: open
   * mode's "local request" clause read the raw upgrade, found no stamp, and
   * refused every `/client` socket; a client-supplied stamp would have passed).
   */
  // One observed request per native request, so the edge's binding of it is
  // what every later step of the same request reads (workspace-edge.ts).
  const observedRequests = new WeakMap<Request, Request>()
  const observedRequest = (request: Request): Request => {
    const seen = observedRequests.get(request)
    if (seen) return seen
    const headers = new Headers(request.headers)
    const peerAddress = requestPeerAddresses.get(request)
    if (peerAddress) headers.set('x-podium-peer-address', peerAddress)
    else headers.delete('x-podium-peer-address')
    const observed = new Request(request, { headers })
    observedRequests.set(request, observed)
    return observed
  }
  const configuredReadiness = createServerReadiness({
    bootConfig: config,
    hasLiveAgentMachine: () => registry.modules.machines.onlineMachineIds().length > 0,
    // An env-set mode is this process's mode, and the file cannot contradict it.
    ...(envMode ? { envMode } : {}),
  })
  const readiness = () =>
    serverMoveDataPlaneDeferred
      ? ({
          state: 'activation_pending',
          reason: 'restart_required',
          dataPlane: 'blocked',
        } as const)
      : configuredReadiness()
  let targetsResolvedOnBoot = recoveryOnly
  const app = new Hono()
  // The dev resolver pulls this server's own feed. The listener must therefore
  // exist before the boot resolve, but it must not report healthy in that narrow
  // window or a supervisor (and the packaged restart gate) could observe the
  // exact empty fleet state boot is about to repair.
  app.get('/health', (c) =>
    serverMoveDataPlaneDeferred || targetsResolvedOnBoot
      ? c.text('ok')
      : c.text('resolving update targets', 503),
  )
  app.use('*', async (c, next) => {
    if (!serverMoveDataPlaneDeferred || c.req.path === '/health') return next()
    return c.json({ error: 'server_not_ready', readiness: readiness() }, 503)
  })

  if (recoveryOnly) {
    const allowedRecoveryProcedures = new Set([
      '/health',
      '/trpc/operations.active',
      '/trpc/operations.history',
      '/trpc/operations.settleAsk',
      '/trpc/operations.action',
    ])
    app.use('*', async (c, next) => {
      if (allowedRecoveryProcedures.has(c.req.path)) return next()
      return c.notFound()
    })
  }

  // Every route below runs behind the workspace edge (POD-7309); `/health`
  // above is unbound, and so is every route the entry-point table says is.
  app.use('*', async (c, next) => await workspaceEdge.middleware(c, next))
  // The reachability answer for Podium Connect (PDM-51). After transfer recovery guards, before auth and CORS, so setup can
  // check reachability without exposing a retired or recovering server.
  registerWellKnownRoute(app, {
    identity: () => installation,
    trustedProbeKeys: () => [
      ...PODIUM_CONNECT_PROBE_KEYS,
      ...resolveConnectProbeKeys(loadConfig(), process.env),
    ],
  })
  // The locate proof (POD-5921): a client that found this address through
  // Connect checks it is this installation before it reconnects here. Public,
  // wildcard-CORS, rate-limited; beside the reachability answer, before auth.
  registerLocateProofRoute(app, {
    identity: () => installation,
    publicUrl: claimedPublicUrl,
    clientAddress: (request) =>
      clientAddressForRequest(request, requestPeerAddresses.get(request), trustedProxyHops),
  })
  devPublisher.registerRoute(app)
  let janitorHost: Awaited<ReturnType<typeof import('./janitor-host').startJanitorHost>> | undefined
  let syncWorker: SyncWorkerClient | undefined
  let janitorHostClosing = false
  let janitorHostStarting: Promise<void> | undefined
  // RESOLVED ONCE, AT BOOT. This is a trust decision — which other origins may
  // make credentialed calls and open sockets — and re-reading it per request
  // would let it change under a socket that is already open. Empty on every
  // install that names nothing, which is what makes both predicates below
  // behave exactly as they did before this existed (PDM-24).
  const allowedOrigins: ReadonlySet<string> = new Set(
    resolveAllowedOrigins(loadConfig(), process.env),
  )
  const reportOriginRefusal = originRefusalReporter((message, fields) => log.warn(message, fields))
  const cors = () => podiumCors({ allowed: allowedOrigins, onRefused: reportOriginRefusal })
  // BEFORE the route, or Hono never runs it: middleware and handlers share one
  // ordered list, so middleware registered after its handler is dead code.
  //
  // `/version` is how a page decides whether the bundle it is running is still
  // the one being served (apps/web/src/lib/served-assets.ts). With the UI on its
  // own host that question crosses an origin, so the answer needs CORS.
  app.use('/version', cors())
  registerVersionRoute(app, {
    workspaceId: () => opts.workspaceId,
    instanceId,
    installationId: installation.installationId,
    installationPublicKey,
    stableLink: () => connectPublisher.stableLink(),
    appUrl: () => resolveAppUrl(loadConfig(), process.env),
    appVersion: () => appVersion,
    sourceDigest: serverBuildSourceDigest,
    installKind: () => (developmentRuntime.runningFromSource ? 'source' : 'installed'),
    // Straight through to the Authority, which delegates to the policy object it
    // was constructed with. No copy on the path (POD-376).
    visibilityGrade: () => registry.modules.funnel.visibilityGrade(),
    // A source checkout's HEAD is a RELEASE PROPOSAL, not an update target.
    // Only a manifest already published into the feed may become the normal
    // update offer returned here.
    updateTarget: async () => registry.modules.updates.advertisedTarget(serverPlacement),
    mobileWeb: () => servedWebIdentity(phoneWebDir()),
    web: () => servedWebIdentity(desktopWebDir()),
    /**
     * THIS HOST's daemon, not "any daemon anywhere". The parent's handover
     * health gate (disposition 24) asks whether the LOCAL daemon reached the new
     * server; `onlineMachineIds().length > 0` answered yes on a multi-machine
     * host with the local daemon dead, which would let a handover complete onto
     * a stack that is missing a child (review finding 7).
     */
    daemonConnected: () =>
      hostMachine === null || registry.modules.machines.onlineMachineIds().includes(hostMachine.id),
    janitor: () =>
      janitorHost
        ? {
            state: janitorHost.state(),
            progressVersion: janitorHost.progressVersion(),
            ...(janitorHost.reason() ? { reason: janitorHost.reason() } : {}),
          }
        : undefined,
  })
  registerMaintenanceRoute(app, {
    authenticateToken: async (token) => {
      const expected = Buffer.from(maintenanceToken)
      const received = Buffer.from(token)
      return (
        expected.length > 0 &&
        expected.length === received.length &&
        timingSafeEqual(expected, received)
      )
    },
    service: new MaintenanceService(store, registry.modules.funnel, {
      issues: registry.modules.issues,
      sessions: registry.modules.sessions,
      automations: registry.modules.automations,
      messages: registry.modules.messages,
      // Read per handshake, never captured: a settings flip must reach the next
      // lease, not wait for a server restart (POD-564).
      worktreeGcPolicy: async () => (await store.settings.getSettings()).worktreeGc,
      liveSessionIds: async () =>
        new Set(registry.modules.sessions.runningSessionFacts().map((s) => s.sessionId)),
      stewardTick: async () => await registry.runStewardTick(),
      // A `machine.scan` effect record under a system principal (POD-6396).
      connectScan: async (machineId) => await connectScanThroughEffect(registry.modules, machineId),
      localMachineId: hostMachine?.id,
    }),
  })
  // The setup UI fetches /setup/config from the desktop webview, whose origin (tauri://localhost)
  // differs from the local server — same cross-origin case as /trpc. Without CORS the fetch is
  // blocked and SetupGate's catch() silently skips onboarding. Must precede the route handler.
  // `podiumCors` reflects an allow-listed origin and permits credentials, which a wildcard
  // cannot: every /trpc call carries the session cookie, and a browser rejects a credentialed
  // response allowed to `*` before the caller sees it. See ./http-cors.
  //
  // Gate the human-client data plane (/trpc, /files) behind the login session whenever a
  // password is configured; open otherwise (loopback / all-in-one, or the user opted out).
  // The static SPA shell, /auth/*, GET /setup/config, /health and /version stay open so the
  // login screen can load. Setup WRITES live under /trpc (setup.*), so they're covered by the
  // /trpc guard below. The /daemon link and /mcp keep their own credentials. Guards are
  // registered BEFORE their handlers so Hono runs them first.
  /**
   * WHO A REQUEST IS: ONE FUNCTION FOR EVERY TRANSPORT (POD-6746).
   *
   * HTTP, tRPC, the file routes, sync, the socket upgrade and the auth routes
   * all call `memberOfRequest`: device sign-in, account, active membership,
   * member. A request without a sign-in is the sole active member only under
   * the same-machine rule, which lives in the identity package (section 5.5)
   * and ends when a second membership is active.
   *
   * The request must be the one the HTTP app sees (`observedRequest`): its
   * `x-podium-peer-address` is the peer the native server reported.
   */
  const loadedMemberOfRequest = createMemberOfRequest({
    identity: identity.workspace,
    users: store.users,
    trustedProxyHops,
    hostMachine,
    publicUrl: claimedPublicUrl,
  })
  /**
   * THE WORKSPACE EDGE (POD-7309, workspace-edge.ts). Every request and socket
   * upgrade is bound to a workspace this process loaded before any handler
   * runs; a request naming another is refused there. The process loads one
   * workspace until the stateless Core lands, so the edge serves exactly it.
   */
  const workspaceEdge = createWorkspaceEdge({
    mode: capabilities.mode,
    pluginEntryPoints: (opts.plugins ?? []).flatMap((plugin) => plugin.entryPoints ?? []),
    served: [
      {
        id: loadedWorkspaceId,
        slug: capabilities.mode === 'hosted' ? opts.workspaceSlug?.trim() || null : null,
        memberOfRequest: loadedMemberOfRequest,
      },
    ],
    // A refusal carries the CORS answer of the route it refused, so a
    // cross-origin client (the desktop shell) can read it.
    respond: async (c, refusal) => {
      await cors()(c, async () => {
        c.res = c.json(refusal.body, refusal.status)
      })
      return c.res
    },
  })
  // Resolves a request in the workspace it is bound to.
  const memberOfRequest = boundMemberOfRequest(workspaceEdge)
  // SIGN-INS FROM BEFORE SHARED SIGN-IN (POD-6751): only on a server that
  // built its own identity core, and not on a store that cannot be written.
  // The period is fixed here, after the migrations and the local identity
  // upgrade and before the server listens.
  if (identity.local && !recoveryOnly) {
    signInCarryOver = createSignInCarryOver({
      store: store.signInCarryOver,
      identity: identity.workspace,
      memberOfRequest,
      originAllowed: (origin, request) =>
        isAllowedHttpOrigin(origin, new URL(request.url).host, allowedOrigins),
      audit: (command, actor, detail) => store.users.audit(command, actor, detail),
    })
    await signInCarryOver.start()
  }
  /** The member a route outside the guard acts for, or nobody. */
  const memberIdOfRequest = async (request: Request) => {
    if (!controlPlaneAvailable(readiness())) return undefined
    const resolution = await memberOfRequest(request)
    return resolution.kind === 'member' ? resolution.memberId : undefined
  }
  /** The principal of a guarded request, or undefined for anybody the guard would refuse. */
  const principalOfRequest = async (request: Request) => {
    const resolution = await memberOfRequest(request)
    return resolution.kind === 'member' ? resolution.principal : undefined
  }
  const guard = clientAuthGuard({ memberOfRequest, renew: identity.workspace.renew })
  const boundary = readinessBoundary({ readiness, isHostLocal })
  /**
   * Event-loop accounting, when the level installs it (it is started further
   * down, inside the listen promise). Declared at THIS scope — above the /trpc
   * context factory rather than beside the wiring that assigns it — because four
   * places need it: that wiring, the tRPC context (so `perf.snapshot` can report
   * the rings), the handle this function resolves, and the shutdown step that
   * releases the file. `let`, and read through the context factory's closure at
   * REQUEST time, so a request served before the level is resolved simply sees
   * `undefined` and reports no loop section.
   */
  let loopAccounting: LoopAccountingHandle | undefined
  let dropLoopAccounting: (() => void) | undefined
  // First-run setup belongs to whoever installed this server. A hosted server
  // has no such person and no `/setup/*` route at all.
  if (capabilities.setupRoutes) app.use('/setup/*', cors())
  app.use('/readiness', cors())
  registerReadinessRoute(app, readiness, membershipCatchUp?.status, {
    setupPage: capabilities.setupRoutes,
  })
  if (capabilities.setupRoutes) {
    registerSetupRoute(app, {
      readiness,
      // A source launcher is not enough on its own: PODIUM_HOST=0.0.0.0 is an explicit
      // reachability choice, so that server must retain password/reachability setup.
      localSetupDefault:
        hostMachine !== null && shouldAdvertiseLocalSetupDefault({ ...opts, host }),
    })
  }
  // Human-client login (web/desktop UI). Same cross-origin reason as /setup: the desktop
  // webview's origin differs from the server in the all-in-one case. Login itself is
  // same-origin in the supported network topologies; the password store gates it.
  app.use('/auth/*', cors())
  app.use('/auth/*', authReadinessBoundary(readiness))
  // The people routes refuse a signed-in non-member of the bound workspace.
  app.use('/auth/*', workspaceEdge.signedInGate)
  let revokeConnectedDeviceSignIn: (credentialId: string) => void = () => {}
  registerAuthRoute(app, {
    publicUrl: claimedPublicUrl,
    syncBoundaryId: replicaBoundaryOf({
      installationNamesWorkspace: capabilities.installationNamesWorkspace,
      installationBoundary: opts.workspaceId ?? installation.installationId,
      // The request's bound workspace (POD-7309).
      workspaceOf: (request) => maybeBoundServedWorkspaceOf(request)?.id,
    }),
    identity: identity.workspace,
    // One resolver for every human-client transport; the status route reports
    // its result and holds no policy of its own.
    memberOfRequest,
    controlPlaneAvailable: () => controlPlaneAvailable(readiness()),
    memberOfAccount: (accountId) => store.users.findMemberByAccount(accountId),
    allowedOrigins,
    isLocalRequest: isHostLocal,
    readiness,
    // Signing a device out closes that device's open sockets at once.
    onDeviceSignInEnded: (deviceSignInId) => revokeConnectedDeviceSignIn(deviceSignInId),
    onLogin: (event) => registry.modules.bus.emit('auth.login', event),
    ...(signInCarryOver ? { carryOver: signInCarryOver } : {}),
  })
  const memberInvites = memberLinks({
    users: store.users,
    identity: identity.workspace,
    onDeviceSignInEnded: (id) => revokeConnectedDeviceSignIn(id),
  })
  registerMemberRoutes(app, {
    onMembershipChanged: (memberId, change) => {
      // Role changes rescope the member's authority at commit; the People
      // ceremony also ends their old socket so the client reconnects with it.
      // A removed or disabled member's sockets close with a code that tells
      // the client its access ended, not that the network dropped (POD-6910).
      const ended = change === 'remove' || change === 'disable'
      for (const conn of registry.clientGateway.registry.values()) {
        if (conn.principal.user !== memberId) continue
        if (ended && conn.endSignIn) conn.endSignIn(SIGN_IN_ENDED_CLOSE.accessEnded)
        else conn.terminate?.()
      }
    },
    users: store.users,
    identity: identity.workspace,
    onDeviceSignInEnded: (id) => revokeConnectedDeviceSignIn(id),
    resolveUserId: memberIdOfRequest,
    appUrl: () =>
      resolveAppUrl(loadConfig(), process.env) || resolvePublicUrl(loadConfig(), process.env),
    allowedOrigins,
    // Their credentials are removed everywhere, and sessions on them flagged (§8).
    afterMemberRemoved: async (memberId, actor) =>
      await registry.modules.credentialHealth.removeMemberCredentials(memberId, actor),
  })
  // The admin area's viewer, Access and Audit reads (POD-6299).
  registerAdminRoutes(app, {
    users: store.users,
    settings: store.settings,
    sessions: store.sessions,
    identity: identity.workspace,
    audit: store.settingsAudit,
    machineNames: async (ids) =>
      new Map(
        [...(await store.machines.getMachines(ids))].map(([id, machine]) => [id, machine.name]),
      ),
    resolveUserId: memberIdOfRequest,
    loginRequired: credentialsRequired,
    allowedOrigins,
  })
  registerSignInRoutes(app, {
    identity: identity.workspace,
    memberOfRequest,
    audit: store.settingsAudit,
    allowedOrigins,
    onDeviceSignInEnded: (id) => revokeConnectedDeviceSignIn(id),
  })
  registerMobilePairingRoutes(app, {
    identity: identity.workspace,
    memberOfRequest,
    memberOfAccount: (accountId) => store.users.findMemberByAccount(accountId),
    allowedOrigins,
    serverIdentity: () => ({
      publicUrl: resolvePublicUrl(loadConfig(), process.env),
      instanceId,
      workspaceId: opts.workspaceId,
      installationId: installation.installationId,
      installationPublicKey,
    }),
  })
  // An <img src> or a download link from another origin needs no CORS, but a
  // fetch() of /files/asset does — and HtmlFilePanel and OpenInBrowserButton
  // both build asset URLs from the resolved httpOrigin expecting them to be
  // fetchable. `clientAuthGuard` already passes OPTIONS through, so the
  // preflight reaches this middleware rather than the login gate.
  app.use('/files/*', cors())
  app.use('/files/*', boundary)
  app.use('/files/*', guard)
  registerAssetRoute(app, {
    mayRead: async (request, target) => {
      const access = privateResourceAccess(
        {
          sessionOwnerUserId: async (sessionId) =>
            (await store.sessions.getSession(sessionId))?.ownerUserId,
          machines: registry.modules.machines,
        },
        await principalOfRequest(request),
      )
      return 'sessionId' in target
        ? await access.ownsSession(target.sessionId)
        : await access.mayReadMachineFiles(target.machineId)
    },
    readAsset: async (a) => await registry.modules.rpc.readAsset(a),
    allowsRoot: async (root, machineId) =>
      (await repos.inferFromPath(
        root,
        machineId ?? (await registry.modules.machines.defaultMachine()),
      )) !== undefined,
  })
  // Permanent artifact snapshots (#441) — server-local, no daemon hop.
  registerArtifactRoute(
    app,
    workspaceArtifacts(loadedWorkspaceId, registry.modules.issueArtifacts),
    edgeWorkspaceBinding(capabilities.mode, workspaceEdge.served),
  )
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
      mcpToolSpecs: async (threadId) => await superagent.mcpToolSpecs(threadId),
      callMcpTool: async (name, args, threadId) =>
        await superagent.callMcpTool(name, args, threadId),
    },
    mcpToken,
    // The per-thread token each harness invocation's mcp-config carries (issue #67).
    { resolveThread: (token) => superagent.threadForMcpToken(token) },
  )
  app.use('/sync/*', cors())
  app.use('/sync/*', boundary)
  app.use('/sync/*', guard)
  registerSyncRoutes(app, {
    ...registry.syncDelta,
    workspaceOf: boundWorkspaceOf,
    worker: () => syncWorker,
    principal: async (request) => syncFeedPrincipal(await principalOfRequest(request)),
  })
  /**
   * The host-local first-run bootstrap, which acts as the earliest admin
   * before anyone can sign in. Never on a server whose mode has no default
   * principal (hosted).
   */
  const isSetupBootstrap = (path: string, request: Request): boolean =>
    capabilities.earliestAdminDefault &&
    isHostSetupBootstrap(readiness(), path, request, isHostLocal)
  app.use('/trpc/*', cors())
  app.use('/trpc/*', boundary)
  app.use('/trpc/*', async (c, next) => {
    // A host-local first run must remain possible when PODIUM_PASSWORD already
    // provisioned a credential. Login itself is not a bootstrap surface, so the
    // exact setup allowlist bypasses the ordinary login guard only while blocked.
    if (isSetupBootstrap(c.req.path, c.req.raw)) return await next()
    return await guard(c, next)
  })
  app.use(
    '/trpc/*',
    trpcServer({
      router: appRouter,
      // Error funnel: every failed /trpc call leaves a server-side trace.
      onError: ({ error, path, type }) => logProcedureFailure(log, { error, path, type }),
      // Everyone who reaches /trpc is the OPERATOR: the login session (clientAuthGuard
      // above) already authenticated the human, so the tracker grants full authority — no
      // separate tracker credential. Constrained agents don't come through here; they are
      // relayed via their daemon and carry their own capability (agent integration).
      createContext: async (_request, hono) => {
        // SETUP BOOTSTRAP, before there is anything to authenticate with: the
        // first admin is RESOLVED here too, so the account this acts as is a row
        // that exists rather than an id the build named.
        const bootstrapAccount = isSetupBootstrap(hono.req.path, hono.req.raw)
          ? await store.users.earliestAdmin()
          : undefined
        const principal =
          (await principalOfRequest(hono.req.raw)) ??
          (bootstrapAccount
            ? userCommandPrincipal(asUserId(bootstrapAccount.id), bootstrapAccount.role)
            : undefined)
        if (principal === undefined) throw new Error('authenticated account is unavailable')
        // The workspace the edge bound this request to; the registry is its.
        const boundWorkspace = boundWorkspaceOf(hono.req.raw)
        if (boundWorkspace !== store.workspaceId) {
          throw new Error(
            `request bound to ${boundWorkspace} reached the registry of ${store.workspaceId}`,
          )
        }
        return {
          registry,
          repos,
          boundWorkspace,
          // The selector a joining machine sends: the hosted workspace's id, or
          // the self-hosted label an outer router routes by.
          ...(capabilities.mode === 'hosted'
            ? { workspaceId: boundWorkspace }
            : opts.workspaceId
              ? { workspaceId: opts.workspaceId }
              : {}),
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
          loginPolicy,
          hostLocalRequest: isHostLocal(hono.req.raw),
          modules: registry.modules,
          // Absent at profile level `off`, and absent until the level resolves
          // during listen — `perf.snapshot` then omits its `loop` section, which
          // is what "nothing was measured" has to look like.
          ...(loopAccounting ? { loopAccounting } : {}),
          // Only so telemetry.preview can show the REAL report;
          // consent lives in config.json and is never read through the context.
          telemetry,
          // Hub-only procs (machines fleet admin + pairing) 404 when the hub
          // role is off — see the hubProc guard in router.ts.
          role,
          ...(desktopSupervised ? { desktopSupervised: true } : {}),
          ...(prepareCoordinatorUpdate ? { prepareCoordinatorUpdate } : {}),
          ...(requestCoordinatorRestart ? { requestCoordinatorRestart } : {}),
          serverInstallKind: developmentRuntime.runningFromSource ? 'source' : 'installed',
          serverPlacement,
          // POD-2766: `setup.activate` — the restart an operator can reach while
          // the data plane is blocked — reads this live and refuses any instance
          // that is not activation-pending, so it never becomes a bounce lever.
          readiness,
          connect: connectPublisher,
          tunnelHealth: readTunnelHealth,
          // The web build is the server's own step now, not a systemd unit to
          // restart (POD-1985) — but the context shape is unchanged, so the
          // Update panel's "the website is behind" path still just calls this.
          ...(devPublisher.requestWebRebuild
            ? { requestWebRebuild: devPublisher.requestWebRebuild }
            : {}),
          ...(devPublisher.enabled
            ? {
                releaseProposal: devPublisher.proposal,
                approveReleaseProposal: devPublisher.approveRelease,
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
    await plugin.register({
      hono: app,
      modules: registry.modules,
      bus: registry.bus,
      config,
      role,
    })
  }

  // Serve the built web UIs for external clients (browser/phone/other desktop) —
  // see desktopWebDir/phoneWebDir for where each dist comes from.
  const mobileWebDir = phoneWebDir()
  registerHttpsRequiredPage(app, memberOfRequest)
  // Routing first so its /mobile fallback middleware owns the dist-absent case;
  // presence is probed per request (the mobile dist may be exported after boot).
  const mobileIndex = mobileWebDir ? join(mobileWebDir, 'index.html') : ''
  const expoMobilePresent = (): boolean => mobileIndex !== '' && existsSync(mobileIndex)
  registerMobileRouting(app, {
    expoMobilePresent,
    redirectPhoneRoot: opts.redirectPhoneRootToMobile ?? true,
    operatorEntryAvailable: () => readiness().dataPlane === 'available',
    /**
     * ONLY WHEN THIS SERVER SERVES NO UI AT ALL (PDM-26).
     *
     * An API-only deployment has no page to give a browser, so those routes 404
     * or bounce today and the app URL is the true answer. A server that HAS a
     * bundle keeps serving it: redirecting away from a working local UI would
     * take it from the operator standing in front of the box, which is the one
     * person who most needs it.
     */
    appUrl: () =>
      // A BUNDLE THAT IS ACTUALLY SERVED, not a directory path. `desktopWebDir()`
      // answers where the dist WOULD be and is a non-empty string in every
      // compiled binary, whether or not anything is there — so testing it
      // directly made this accessor return `undefined` on exactly the API-only
      // deployment the redirects exist for. This is the same predicate `/version`
      // publishes as `web.present`, which is what a client is told (PDM-34).
      servedWebIdentity(desktopWebDir()).present || expoMobilePresent()
        ? undefined
        : resolveAppUrl(loadConfig(), process.env),
  })
  // crossOriginIsolated: expo-sqlite web needs SharedArrayBuffer for durable
  // OPFS persistence (POD-541). Without these headers the replica degrades to
  // in-memory and offline deep links paint "Task not found."
  if (mobileWebDir) {
    registerWebStatic(app, mobileWebDir, {
      basePath: '/mobile',
      lazy: true,
      crossOriginIsolated: true,
      // The phone's worker controls `/mobile` itself, for an offline reload (POD-7179).
      serviceWorkerScope: '/mobile',
    })
  }

  const webDir = desktopWebDir()
  if (webDir) {
    registerDesktopWebStatic(app, webDir)
    // Keep the build-pair grade as an operator diagnostic. The app owns the only
    // compatibility banner; the server must never stamp a second one into HTML.
    const bundle = describeBundleDiagnostic(gradeWebBundle(webDir))
    if (bundle) log.warn(bundle, { webDir })
  }

  // Reachable off-box with no login password: open mode serves this machine only
  // (isHostLocalRequest), so every other device is refused. Say so, rather than leave an
  // operator wondering why nothing else can log in.
  if (!isLoopbackHost(host) && !(await credentialsRequired())) {
    log.warn(
      'server is network-reachable but has no login password, so only this machine can use it; set one with `podium setup`',
      { host },
    )
  }

  const requestedPort = opts.port ?? 0
  /**
   * THE HTTP PATHS THIS PROCESS ANSWERS (POD-7332): `/health` on every
   * listener, the janitor's maintenance channel with the `worker` role, and
   * the rest of the HTTP app with the `api` role. Socket upgrades are the
   * `sync` role's and are answered before this. The path is the one Hono
   * routes on, so an encoded spelling cannot reach a route the role lacks.
   */
  const servesHttpPath = (request: Request): boolean => {
    const path = routedPath(request)
    if (path === '/health') return true
    if (path === '/maintenance' || path.startsWith('/maintenance/')) return runs.worker
    return runs.api
  }
  const listen = async (
    resolve: (handle: ServerHandle) => void,
    reject: (error: unknown) => void,
  ): Promise<void> => {
    let settled = false

    let loopMinuteSink: LoopMinuteFileSink | undefined
    let loopProfileCapture: LoopProfileCapture | undefined
    const failListen = async (err: unknown): Promise<void> => {
      if (settled) return
      settled = true
      stopDeferredPromotionPoll()
      stopDeferredSourceMovePoll()
      await messaging?.stop()
      await registry.dispose()
      // THE SECOND CLOSE PATH (POD-2148). Boot adoption has already run by
      // here, so this server may hold armed deadlines and drives in flight over
      // the store about to close — and a port-in-use start, the routine outcome
      // with a stale backend on :18787, takes exactly this path. Same call and
      // same order as the shutdown persist list below.
      registry.modules.operations.cleanupJanitor.stop()
      registry.modules.operations.engine.stop()
      await store.close()
      reject(
        isAddressInUseError(err)
          ? new PortInUseError(requestedPort, { cause: err })
          : (err as Error),
      )
    }

    // Client sync sockets and daemon links are the sync role's (POD-7332);
    // their heartbeats start with them, so a process without it attaches none.
    const attachSockets: (...args: Parameters<typeof attachWebSockets>) => WsHandle | undefined =
      runs.sync ? attachWebSockets : () => undefined
    const ws = attachSockets(
      registry,
      {
        readinessForClient: readiness,
        // THE WORKSPACE EDGE FOR SOCKETS (POD-7309): /client, /daemon and
        // /machine are bound like any request, on the same observed request
        // the member is resolved from below.
        bindWorkspace: async (request) => {
          const answer = await workspaceEdge.bind(observedRequest(request), true)
          if (answer.kind === 'refused') return { refused: answer.refusal }
          if (answer.kind !== 'bound')
            return { refused: { status: 404, body: { error: 'not_found' } } }
          return { workspaceId: answer.workspace.id }
        },
        principalForClient: async (request) => {
          // The upgrade is judged as the HTTP app would see it: the peer address
          // is the one the native server reported, never one the client sent.
          const resolution = await memberOfRequest(observedRequest(request))
          if (resolution.kind !== 'member') return { refused: refusalAnswer(resolution) }
          const { memberId, role, deviceSignIn } = resolution
          // What the socket holds, revalidated on every heartbeat (15 seconds):
          // the device sign-in still exists and its membership is still active
          // with this member and role, or, for a socket admitted by the
          // same-machine rule, the rule still holds. One statement.
          const held = deviceSignIn
            ? { deviceSignInId: deviceSignIn.id, memberId, role }
            : { sameMachine: true as const, memberId, role }
          return {
            userId: memberId,
            userRole: role,
            ...(deviceSignIn ? { credentialId: deviceSignIn.id } : {}),
            maintain: () => identity.workspace.revalidate(held),
          }
        },
      },
      // The same list and the same reporter as the HTTP plane: one statement of
      // trust, read by both boundaries, so they cannot drift apart. A daemon's
      // link is judged from the same facts sign-in reads (credential management §8).
      {
        allowedOrigins,
        onOriginRefused: reportOriginRefusal,
        daemonLink: (request) =>
          daemonLinkFactsOf(request, requestPeerAddresses.get(request), trustedProxyHops),
      },
    )
    if (ws) started.add('sync.sockets')
    revokeConnectedDeviceSignIn = (sessionId) => ws?.revokeClientCredential(sessionId)

    let acceptingRequests = true
    let server: Pick<NativeServer<never>, 'port' | 'stop'>
    const listenStarted = performance.now()
    // A process with neither `api` nor `sync` serves nobody from outside. Its
    // janitor still reaches the maintenance channel over HTTP, so it listens
    // on loopback alone, on a port of its own: no public port is opened.
    const servesNetwork = runs.api || runs.sync
    try {
      server = serveNative({
        port: servesNetwork ? requestedPort : 0,
        hostname: servesNetwork ? host : '127.0.0.1',
        idleTimeout: HTTP_IDLE_TIMEOUT_S,
        ...(tls && servesNetwork ? { tls } : {}),
        ...(ws ? { websocket: ws.websocket } : {}),
        async fetch(request, nativeServer) {
          if (rehearsal && !['/health', '/version'].includes(new URL(request.url).pathname)) {
            return new Response('Upgrade rehearsal: session and API traffic disabled', {
              status: 503,
            })
          }
          if (!acceptingRequests) return new Response('Server is shutting down', { status: 503 })
          for (const plugin of opts.plugins ?? []) {
            const response = await plugin.onRequest?.(request)
            if (response) return response
          }
          const peerAddress = nativeServer.requestIP?.(request)?.address
          if (peerAddress) requestPeerAddresses.set(request, peerAddress)
          const upgrade =
            !ws || serverMoveDataPlaneDeferred
              ? null
              : recoveryOnly && new URL(request.url).pathname !== '/daemon'
                ? null
                : await ws.handleRequest(request, nativeServer as never)
          if (upgrade !== null) return upgrade
          if (!servesHttpPath(request)) {
            return new Response('Not found', { status: 404 })
          }
          const response = await app.fetch(observedRequest(request))
          // Sync owns its streaming content coding, including identity.
          if (new URL(request.url).pathname.startsWith('/sync/')) return response
          return await compressHttpResponse(request, response)
        },
      })
      bootStage('listen', listenStarted)
      started.add(servesNetwork ? 'listener' : 'listener.loopback')
      if (runs.api) started.add('api.http')
      const httpsWarning = httpsSignInWarning({
        loopback: isLoopbackHost(host),
        tls: tls !== undefined,
        trustedProxyHops,
        publicUrl: claimedPublicUrl(),
      })
      if (httpsWarning) log.warn(httpsWarning)
      if (!rehearsal) startDeferredSourceMovePoll()
    } catch (err) {
      await failListen(err)
      return
    }

    settled = true
    boundPort = server.port
    // EVERY server process owns a janitor worker thread (PDM-27) — dev,
    // self-hosted and cloud are the same composition, and there is no mode or
    // ordinary environment that turns it off. Rehearsal deliberately omits it.
    // Construction stays off the listen path,
    // and the client turns faults/stalls into observable degraded state plus
    // automatic replacement rather than request-loop failure.
    janitorHostStarting = (async () => {
      if (rehearsal) return
      // Existing worker test seam suppresses real threads in vitest's fork runtime.
      // The sync worker thread answers `/sync/*` bootstrap and pages: the api's.
      if (runs.api && !opts.janitorWorkerForTests && !janitorHostClosing) {
        const { SyncWorkerClient } = await import('./sync-worker/worker-client')
        syncWorker = new SyncWorkerClient({
          dbPath: databaseLocation,
          // The worker builds effect records from the table and holds no
          // executor: it is told which kinds this server serves (POD-6770).
          effectKinds: () => registry.modules.effects?.executors.kinds() ?? [],
        })
        started.add('api.syncWorker')
      }
      if (!runs.worker) return
      started.add('worker.janitor')
      const { startJanitorHost } = await import('./janitor-host')
      const startedJanitorHost = await startJanitorHost({
        port: boundPort,
        token: rotateMaintenanceToken,
        dbPath: databaseLocation,
        localMachineId: hostMachine?.id ?? null,
        ...(opts.janitorWorkerForTests ? { start: opts.janitorWorkerForTests } : {}),
      })
      if (janitorHostClosing) {
        const closing: Promise<void> = startedJanitorHost.close()
        await closing
      } else janitorHost = startedJanitorHost
    })().catch((error) => {
      log.warn('janitor worker host failed to start', { err: error })
    })
    // Startup stays off the listen path; ordered shutdown awaits this retained work.
    void janitorHostStarting
    // The in-process MCP issue surface is the trusted superagent orchestrator. It calls
    // the issue command registry DIRECTLY (not the cookie-gated HTTP /trpc, which would
    // 401 it) as the OPERATOR — router-equal authz, no router caller involved. This is
    // also the seam for per-agent capabilities later: pass a constrained capability
    // instead of OPERATOR.
    issueTools.setClientResolver(async (threadId) => {
      const ownerUserId = await superagent.threadOwner(threadId)
      const account = ownerUserId ? await store.users.get(ownerUserId) : undefined
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
    // reaches this MCP route. Now that the port is known, point it there. The
    // route is the api's, so a process without it has no endpoint to name.
    if (runs.api) {
      await superagent.setMcpEndpoint(
        selfCallUrl(`http://127.0.0.1:${server.port}/mcp`, capabilities.mode, loadedWorkspaceId),
        mcpToken,
        (await superagent.mcpToolSpecs()).map((s) => s.name),
      )
    }
    // Event-loop accounting and the server-side stall reporter (POD-600), both
    // gated on the resolved profile level. The warning goes out at ANY level:
    // it means the environment asked for something this build does not accept,
    // so what is measured is not what whoever set it expects.
    reportLoopProfileWarning(loopLog)
    if (atLeast('accounting')) {
      const perfDir = join(stateDir(), 'perf')
      const loopSink = createLoopMinuteSink({
        dir: perfDir,
        component: 'server',
      })
      loopMinuteSink = loopSink
      // CPU profiles are an `attribution` artifact (spec §8): below it nothing
      // is constructed, so the sampler is never armed and its keep-clear timer
      // never exists. The cost of the drain lands on the minute record through
      // `noteProfilerCost`, next to everything else this process spends on
      // measuring itself.
      const capture = atLeast('attribution')
        ? createProfileCapture({
            component: 'server',
            level: loopProfileLevel,
            dir: perfDir,
            onKeepClearCost: (ms) => loopAccounting?.noteProfilerCost(ms),
          })
        : undefined
      loopProfileCapture = capture
      // POD-7037: the stall early warning — immediate alerts, an hourly digest
      // by definition name, and the post-deploy comparison with the previous
      // build. It reads what the per-stall record already measures, so it lives
      // at the same level.
      const stallWatch: StallWatch | undefined = atLeast('attribution')
        ? createStallWatch({
            build: appVersion,
            log: loopLog,
            summaryPath: join(perfDir, 'server-stall-builds.json'),
          })
        : undefined
      const profileStallMs = resolveProfileStallMs()
      // POD-3834: a stall no longer arms a profile by itself unless this install
      // asked it to. Arming is permanent — Bun's sampler has no stop — so the
      // automatic path bought this server a measured 4.05 percent of wall for
      // stalls nobody was reading. `podium perf profile server` still arms one.
      const profileOnStall = resolveProfileOnStall()
      /** Arm a capture, and record it in the minute when the limiter refuses. */
      const requestProfile = (
        trigger: 'stall' | 'signal',
        seconds: number,
        context?: { stallMs?: number },
      ): void => {
        if (!capture) return
        void capture
          .request(trigger, seconds, {
            ...(context?.stallMs === undefined ? {} : { stallMs: context.stallMs }),
            ...(loopAccounting?.latestMinute() ? { minute: loopAccounting.latestMinute() } : {}),
          })
          .then((result) => {
            if (result.suppressed) {
              // `level` cannot happen here and `unavailable` is a property of the
              // runtime, not of this minute — only contention is worth counting.
              if (result.reason === 'running' || result.reason === 'rate-limited') {
                loopAccounting?.noteProfileSuppressed()
              }
              return
            }
            loopLog.warn('loop profile captured', {
              path: result.path,
              trigger,
              seconds,
              traceCount: result.traceCount,
              bytes: result.bytes,
            })
          })
          .catch((err: unknown) => {
            loopLog.warn('loop profile capture failed', {
              trigger,
              reason: err instanceof Error ? err.message : String(err),
            })
          })
      }
      loopAccounting = startLoopAccounting({
        component: 'server',
        level: loopProfileLevel,
        sink: loopSink,
        // The per-stall record is an ATTRIBUTION-level artifact. At `accounting`
        // the minute record already carries the stall count, max and
        // percentiles, and a per-stall line would write the same event a second
        // time in a shape nothing aggregates (POD-1932 is that mistake once
        // already).
        ...(atLeast('attribution')
          ? {
              // The sole record of a server stall — the probe reports here and
              // logs nothing itself, so every field lands on one queryable
              // record (POD-1932).
              onLongTick: (stall) => {
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
                const taskCoverage = taskAttributionCoverage(stall.durationMs)
                stallWatch?.noteStall(stall.durationMs, queryAttributionSnapshot())
                loopLog.warn('server event-loop stall', {
                  durationMs: stall.durationMs,
                  heapUsedBytes: mu.heapUsed,
                  rssBytes: mu.rss,
                  // How busy the loop was in the second before the stall — the
                  // number that says whether this was a spike on an idle loop
                  // or one more block on a loop that is saturated anyway.
                  ...(stall.utilizationPct === undefined
                    ? {}
                    : { utilizationPct: stall.utilizationPct }),
                  // Each classification number its own NUMBER field: a query can ask
                  // "which stalls were starved" only if the verdict is a field.
                  ...(stall.classification
                    ? {
                        ownCpuMs: stall.classification.ownCpuMs,
                        runqueueWaitMs: stall.classification.runqueueWaitMs,
                        stallVerdict: stall.classification.verdict,
                      }
                    : {}),
                  ...(sql ? { sql } : {}),
                  ...(tasks ? { tasks, taskCoverage } : {}),
                })
                // A long stall arms a profile AFTER the fact: the stall itself
                // is already over, and every measured incident has had them
                // arrive in bursts, so the next one lands inside the window
                // (spec §8). The rate limiter is what keeps a burst from
                // producing a file per stall.
                if (profileOnStall && stall.durationMs >= profileStallMs) {
                  requestProfile('stall', 10, { stallMs: stall.durationMs })
                }
              },
            }
          : {}),
      })
      if (atLeast('attribution')) {
        // POD-1630: the per-second window that scopes SQL attribution to the
        // stall rather than to all of uptime — the same cadence the daemon's
        // loop-attribution uses, and for the same reason.
        // POD-1931: the SAME question one level out. Query attribution names the
        // statements; this names the SCHEDULED CALLBACKS, which is where the rest
        // of a stall lives — after the query-shaped costs were fixed, the phases
        // and statements together accounted for barely a third of the blocked
        // time. Installed before the subsystems schedule anything, so their timers
        // are wrapped at creation.
        // Hand the seams their target. The recording sites — `recordQuery`,
        // `recordTask`, the tRPC middleware — reach the accounting through a
        // module-level sink rather than a threaded-through handle, so it has to
        // be registered once here. BEFORE `attributeTasks()` below and before any
        // subsystem schedules work, or the first costs of the process go nowhere.
        // REGISTERED, not assigned: `all-in-one` hosts the daemon in this same PID
        // and registers its own handle, and both describe the one loop they share.
        dropLoopAccounting = addLoopAccounting(loopAccounting)
        attributeTasks()
        const attributionWindow = setInterval(() => {
          // The second's executions that read past the heavy-read line, before
          // the window they were recorded in is dropped (POD-7037).
          stallWatch?.noteHeavyReads(drainHeavyStatementReads())
          resetQueryAttribution()
          resetTaskAttribution()
        }, 1000)
        attributionWindow.unref?.()
        const stallWatchTick = setInterval(() => stallWatch?.tick(), 60_000)
        stallWatchTick.unref?.()
        // POD-1653: the window above answers "what stalled this second"; a bench
        // run asks "what ran over the last minute, and WHO issued it". Both
        // retentions already exist (queryAttributionTotals / queryCallerStacks)
        // but nothing could read them out of a live process. SIGUSR2 is that
        // reader — inert below this level, and it only prints.
        process.on('SIGUSR2', () => {
          const out = [...queryAttributionTotals()]
            .sort((a, b) => b[1].count - a[1].count)
            .slice(0, 15)
            .map(([key, c]) => formatQueryCost(key, c))
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
          // ...and a CPU profile, which is the half of this the totals above
          // cannot give: they name what ran through a seam, the profile names
          // what ran through none. `podium perf profile server` leaves the
          // duration in the request file; a signal sent by hand gets 10 s.
          requestProfile('signal', takeProfileRequest(perfDir))
        })
      }
    }
    // In-process daemon link [POD-196]: the local-machine equivalent of
    // wireDaemonSocket, minus serialization. It still drives the SAME
    // acceptor and daemonSecret strategy. Composition-root reachability is
    // not proof of machine identity and grants no ambient `use` (M4).
    // queueMicrotask keeps delivery async so neither side re-enters the
    // other's call stack (the ordering the WS transport implied).
    const localDaemonLink: LocalDaemonLink = {
      attachPortableState: (control) => registry.attachLocalDaemonPortableState(control),
      attach: async ({ hello, deliver, deliverInput, signChallenge }) => {
        const credentialCurrent = registry.modules.machines.credentialFence()
        let credentialLive = true
        const acceptor = createDaemonAcceptor({
          machines: registry.modules.machines,
          connectionId: `local-daemon-${randomUUID()}`,
          verifyOnly: registry.recoveryOnly,
        })
        let { outcome } = await prepareDaemonFrame(acceptor, JSON.stringify(hello))
        if (outcome.kind === 'challenge' && signChallenge) {
          const signed = await signChallenge(outcome.reply)
          ;({ outcome } = await prepareDaemonFrame(acceptor, JSON.stringify(signed)))
        }
        if (outcome.kind !== 'established' || !credentialCurrent(outcome.principal.machine)) {
          const reply =
            outcome.kind === 'rejected'
              ? PeerHelloReply.parse(outcome.reply)
              : { type: 'peerHelloRejected' as const, reason: 'unexpected-frame' as const }
          return { established: false as const, reply }
        }
        const { principal } = outcome
        const unregisterCredential = registry.modules.machines.registerCredentialConnection(
          principal.machine,
          () => {
            credentialLive = false
          },
        )
        perf.record(
          'phase',
          outcome.acceptedCaps.includes(CAP_TERMINAL_OUTPUT_BINARY_V1)
            ? 'terminal.output.daemon.capability.binary'
            : 'terminal.output.daemon.capability.base64',
          0,
          DEPLOYMENT,
        )
        perf.record(
          'phase',
          outcome.acceptedCaps.includes(CAP_TERMINAL_INPUT_BINARY_V1)
            ? 'terminal.input.daemon.capability.binary'
            : 'terminal.input.daemon.capability.base64',
          0,
          DEPLOYMENT,
        )
        if (!registry.recoveryOnly) {
          await recordHelloBuild(registry.modules.machines, outcome.machineId, {
            build: outcome.build,
            caps: outcome.offeredCaps,
            at: new Date().toISOString(),
          })
        }
        if (!credentialLive) {
          unregisterCredential()
          return {
            established: false as const,
            reply: { type: 'peerHelloRejected' as const, reason: 'unexpected-frame' as const },
          }
        }
        const send = (msg: ControlMessage): void =>
          queueMicrotask(() => {
            if (credentialLive) deliver(msg)
          })
        const transport = {
          send,
          sendInput: (input: DaemonPtyInputBatch): void => {
            if (deliverInput && outcome.acceptedCaps.includes(CAP_TERMINAL_INPUT_BINARY_V1)) {
              perf.record(
                'phase',
                'terminal.input.daemon.direct',
                0,
                DEPLOYMENT,
                input.bytes.byteLength,
              )
              queueMicrotask(() => {
                if (credentialLive) deliverInput(input)
              })
              return
            }
            perf.record(
              'phase',
              'terminal.input.daemon.base64',
              0,
              DEPLOYMENT,
              input.bytes.byteLength,
            )
            send({
              type: 'input',
              sessionId: input.sessionId,
              inputOrigin: input.inputOrigin,
              data: Buffer.from(input.bytes).toString('base64'),
              ...(input.attribution ? { attribution: input.attribution } : {}),
            })
          },
        }
        // AWAITED: attach records the machine's daemon COMPONENT, and the
        // capability guards read that row. Dropped, the hello returns before the
        // component is written, so the very next call decides the machine "runs no
        // Podium daemon" -- and the write then lands after the store's scheduler
        // has begun draining, surfacing as an unhandled SchedulerClosedError.
        // This link never leaves the computer: it is `local` for credentials.
        const linkOwner = {}
        registry.daemonLinks.connected(principal.machine, IN_PROCESS_DAEMON_LINK, linkOwner)
        if (registry.recoveryOnly) {
          await registry.modules.machines.attach(principal.machine, send)
          await registry.modules.machines.flushQueued(principal.machine)
        } else {
          await registry.gateway.attachDaemon(principal, transport, outcome.acceptedCaps)
        }
        return {
          established: true as const,
          reply: PeerHelloReply.parse(outcome.reply),
          machineId: principal.machine,
          // `inventoryReport` used to be special-cased at both socket call
          // sites; it is a row in the gateway's routing table now, so this
          // link routes the WHOLE daemon union through one seam.
          deliver: (msg) => {
            if (
              registry.recoveryOnly &&
              msg.type !== 'serverTransferResult' &&
              msg.type !== 'serverEndpointResult'
            )
              return
            queueMicrotask(() => {
              if (credentialLive) registry.gateway.routeDaemonFrame(principal, msg)
            })
          },
          deliverOutput: (batch) => {
            perf.record(
              'phase',
              'terminal.output.daemon.direct',
              0,
              DEPLOYMENT,
              batch.bytes.byteLength,
            )
            queueMicrotask(() => {
              if (credentialLive) registry.gateway.routeDaemonOutput(principal, batch)
            })
          },
          close: () => {
            credentialLive = false
            unregisterCredential()
            registry.daemonLinks.disconnected(principal.machine, linkOwner)
            if (registry.recoveryOnly) registry.modules.machines.detach(principal.machine, send)
            else registry.gateway.detachDaemon(principal, transport)
          },
        }
      },
    }
    const healthStarted = performance.now()
    // Resolving update targets, the reconciler's boot sweep, the delayed
    // refresh and the lake conversion are background work: the worker's.
    void (
      recoveryOnly || !runs.worker
        ? Promise.resolve()
        : refreshTargetsOnBoot({
            refresh: (channel) => registry.modules.updates.refreshTargetForPolling(channel),
            enabled: feedPollingEnabled,
          })
    ).then(async (initialResults) => {
      // Recovery-only transfer boots must remain read-only. Normal boots recover
      // a lost settle sweep after operation adoption and target hydration.
      if (!recoveryOnly && runs.worker) await registry.modules.updatesReconciler?.onBoot()
      // Only after the immediate resolve succeeds or records its per-channel
      // refusal do we expose health and arm the delayed retry. The delay remains
      // exactly the scheduler's 2–7 minute jitter; it is recovery, not boot.
      const targetRefresh =
        recoveryOnly || rehearsal || !runs.worker
          ? { stop: () => {} }
          : startTargetRefresh({
              refresh: (channel) => registry.modules.updates.refreshTargetForPolling(channel),
              enabled: feedPollingEnabled,
              initialResults: initialResults ?? {},
              operationActive: (channel) => registry.modules.updates.operationActive(channel),
              schedule: timerSchedule,
            })
      if (!recoveryOnly && !rehearsal && runs.worker) started.add('worker.updateTargetRefresh')
      targetsResolvedOnBoot = true
      bootStage('health exposed', healthStarted)
      // Health cannot wait for tens of GB of cold history. A failed pass keeps
      // its sources and no done marker; reads work and the next boot retries.
      if (convertingLake && runs.worker) {
        started.add('worker.lakeConversion')
        lakeConversionWork = convertingLake.run().catch((err) => {
          if (!lakeConversionAbort.signal.aborted) {
            log.warn('transcript lake conversion paused; will resume on restart', { err })
          }
        })
      }
      // Connect advertises where this server's HTTP app is reached: the api's.
      if (!recoveryOnly && !rehearsal && runs.api) {
        connectPublisher.start()
        started.add('api.connectPublisher')
      }
      // Local programs (the quick-tunnel utility first) reach this server on a
      // user-only unix socket; a new public URL written there reaches Connect at
      // once instead of on the publisher's 5-minute tick (POD-4640). A socket that
      // cannot be bound costs only that; the server serves regardless.
      // The local programs' control plane answers on behalf of the HTTP app.
      const controlSocket =
        recoveryOnly || rehearsal || !capabilities.controlSocket || !runs.api
          ? undefined
          : await listenUserSocket(
              serverControlSocketPath({ instanceId }),
              controlSocketHandler({
                ...(capabilities.hostSignIn &&
                identity.workspace.core.capabilities().adminEndDeviceSignIn
                  ? {
                      hostSignIns: hostSignIns(
                        identity.workspace,
                        revokeConnectedDeviceSignIn,
                        signInCarryOver,
                      ),
                    }
                  : {}),
                tunnelHealth: (report) => tunnelHealth.report(report),
                diagnostics: () => ({
                  connect: connectPublisher.diagnostics(),
                  tunnelHealth: readTunnelHealth(),
                }),
                publishConnect: () => connectPublisher.republish(),
                setPublicUrl: (url, opts) => {
                  const result = applyPublicUrl(url, opts)
                  if (result.ok && result.changed) connectPublisher.publicUrlChanged()
                  return result
                },
                // `podium setup` sets the first admin's password on the running server
                // (POD-3274): auth.json is only read by a first boot.
                loginPassword: {
                  isSet: async () => {
                    const admin = await store.users.earliestAdmin()
                    return admin ? await credentials.hasPassword(asUserId(admin.id)) : false
                  },
                  set: async (password) => {
                    const admin = await store.users.earliestAdmin()
                    if (!admin) return { ok: false, error: 'this instance has no admin account' }
                    const userId = asUserId(admin.id)
                    try {
                      await credentials.setPassword(userId, password)
                    } catch (error) {
                      if (!(error instanceof MemberHasNoAccount)) throw error
                      return { ok: false, error: error.message }
                    }
                    await registry.modules.machines.grantHostMachineIfUnowned(userId)
                    return { ok: true }
                  },
                },
                // `podium auth recovery-link`: the host-local way back in (POD-6298).
                memberRecovery: async (email) => {
                  try {
                    const invite = await memberInvites.createHostRecovery(email)
                    const url = new URL(
                      resolveAppUrl(loadConfig(), process.env) ||
                        resolvePublicUrl(loadConfig(), process.env) ||
                        `http://127.0.0.1:${server.port}`,
                    )
                    url.hash = `invite=${invite.token}`
                    return { ok: true, url: url.href, expiresAt: invite.expiresAt }
                  } catch (error) {
                    return {
                      ok: false,
                      error: error instanceof Error ? error.message : 'recovery link refused',
                    }
                  }
                },
              }),
              'server control socket',
            ).catch((error: unknown) => {
              log.warn('control socket unavailable; local programs cannot reach this server', {
                err: error,
              })
              return undefined
            })
      if (controlSocket) started.add('api.controlSocket')
      resolve({
        port: server.port,
        syncWorker: () => syncWorker,
        instanceId,
        registry,
        identity: identity.workspace,
        capabilities,
        ...(signInCarryOver ? { signInCarryOver } : {}),
        recoveryOnly,
        get maintenanceToken() {
          return maintenanceToken
        },
        ...(runs.sync ? { localDaemonLink } : {}),
        roles,
        started: () => started,
        ...(loopAccounting ? { loopAccounting } : {}),
        // Deterministic fast shutdown (POD-611): terminate WS intake, persist
        // state unconditionally, THEN force-close lingering http sockets —
        // see closeServerFast for the full ordering rationale. Step order
        // below matters: sync/outbox loops stop before the store closes (a
        // late write against a closed DB would throw), dirty activity
        // timestamps flush while the DB is open, registry.dispose() stops the
        // periodic flush timer, and only then does the store close.
        close: async () =>
          await closeServerFast({
            closeWebSockets: async () => {
              acceptingRequests = false
              await ws?.close()
            },
            drainStore: async (persist) => {
              // A timer pass keeps its original executor context: awaiting it
              // inside persistence cannot grant it shutdown admission. Stop and
              // join it BEFORE store.close marks the scheduler as draining.
              await superagent.dispose()
              await membershipCatchUp?.stop()
              lakeConversionAbort.abort()
              await lakeConversionWork
              await convertingLake?.settled()
              await store.close(persist)
            },
            server,
            persist: [
              ['messaging.stop', () => messaging?.stop()],
              // A sweep that outlives the server would delete against a closed store.
              ['identity.stopSweep', stopIdentitySweep],
              ['serverMove.stopDeferredPromotionPoll', stopDeferredPromotionPoll],
              ['serverMove.stopDeferredSourceMovePoll', stopDeferredSourceMovePoll],
              // An armed refresh timer that outlives the server would resolve a
              // target against a service whose store is already closed.
              ['updates.stopTargetRefresh', () => targetRefresh.stop()],
              // A publish that outlives the server would advertise a URL that
              // is about to stop answering; the next boot republishes anyway.
              ['controlSocket.close', async () => await controlSocket?.close()],
              ['connect.stop', () => connectPublisher.stop()],
              ['updates.localParticipant.close', () => localUpdateParticipant?.close()],
              // Same hazard, same window (POD-2097): an armed operation deadline
              // that outlives the server would wake into a closed store and try
              // to persist a stall against it. Operations are durable, so losing
              // the timer costs nothing — the successor adopts the operation and
              // re-derives it from reality, which is the stronger answer anyway.
              [
                'operations.stopTimers',
                () => {
                  registry.modules.operations.cleanupJanitor.stop()
                  registry.modules.operations.engine.stop()
                },
              ],
              // Stop the flush timer + unsubscribe. Deliberately NOT awaiting a
              // final network flush: shutdown is a user-visible latency path
              // (POD-611 made it deterministic and fast), and a report is worth
              // less than a fast stop. The queue is durable — it goes next boot.
              ['telemetry.stop', () => telemetry.stop()],
              // Release the per-origin client log descriptors. The sink writes
              // synchronously, so nothing is buffered and this loses no records —
              // it closes fds a long-lived process would otherwise hold.
              ['logs.close', () => registry.modules.logs.close()],
              // The same, for the per-machine fleet descriptors (POD-3156).
              ['fleetLogs.close', () => registry.modules.fleetLogs.close()],
              [
                'janitorHost.close',
                // AWAIT THE START FIRST. The host is constructed off the listen
                // path, so at shutdown it may still be starting and `janitorHost`
                // still undefined -- in which case `janitorHost?.close()` is a
                // no-op, shutdown completes, and a worker THREAD comes up behind
                // it and keeps the process alive. That is the hang: server.janitor
                // and server.role were timing out in afterEach on handle.close().
                // dev/mw's version of this step was synchronous, which was correct
                // on its base; this epic made close async and the merge took the
                // sync one.
                async () => {
                  janitorHostClosing = true
                  await janitorHostStarting
                  await syncWorker?.close()
                  if (janitorHost) {
                    const closing: Promise<void> = janitorHost.close()
                    await closing
                  }
                },
              ],
              // Stop the sample/probe timers and release the minute file's fd.
              // The records are already on disk — the sink writes synchronously
              // — so this closes a descriptor rather than draining anything.
              [
                'loopAccounting.stop',
                () => {
                  loopAccounting?.stop()
                  loopProfileCapture?.stop()
                  // Unregister with it — and only THIS handle: a stopped handle
                  // still accepts costs into a ring nothing will ever flush, and
                  // on a process that restarts the server in-process those would
                  // be billed to the run that ended. A co-hosted daemon's handle
                  // is not ours to drop.
                  dropLoopAccounting?.()
                  dropLoopAccounting = undefined
                  loopMinuteSink?.close()
                },
              ],
              ['sessions.flushActivity', () => registry.modules.sessions.flushActivity()],
              ['registry.dispose', () => registry.dispose()],
              // NO 'store.close' STEP HERE. `drainStore` above already IS
              // store.close(persist) -- it runs this whole list from inside the
              // close it is performing. dev/mw had no drainStore and closed the
              // store as the last persist step, which was right on its base;
              // this epic moved that responsibility into drainStore so the
              // persist work happens while the database is still open. The merge
              // kept BOTH, so the last step re-entered the close it was running
              // inside, and awaited a drain that could not finish. That was the
              // shutdown hang: handle.close() never resolved.
            ],
          }),
      })
    })
  }
  return new Promise<ServerHandle>((resolve, reject) => {
    void listen(resolve, reject).catch(reject)
  })
}

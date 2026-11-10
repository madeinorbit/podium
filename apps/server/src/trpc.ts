import { createLogger, describeError } from '@podium/logger'
import type { ServerReadiness } from '@podium/model'
import type { MobileWebIdentity, ReleaseProposal, UpdateTarget } from '@podium/protocol'
import type { LoopAccountingHandle } from '@podium/runtime/loop-accounting'
import { attribute } from '@podium/runtime/loop-accounting'
import type { TelemetryEmitter } from '@podium/telemetry'
import { initTRPC } from '@trpc/server'
import type {
  inferParser,
  MiddlewareBuilder,
  MiddlewareFunction,
  Overwrite,
  Parser,
  ProcedureBuilder,
  Simplify,
  UnsetMarker,
} from '@trpc/server/unstable-core-do-not-import'
import type { CloudRuntimeProvider } from './cloud-runtime'
import type { CommandPrincipal } from './command-principal'
import type { Capability } from './issue-authz'
import type { ConnectPublisher } from './modules/connect/publisher'
import type { IssueCaller } from './modules/issues/command-ctx'
import { IssueRevisionConflict } from './modules/issues/conflict'
import { DEPLOYMENT, perf } from './modules/perf/registry'
import type { SuperagentService } from './modules/superagent'
import type { PrepareCoordinatorUpdate } from './modules/updates/installed-restart'
import type { ServerPlacement } from './modules/updates/service'
import type { RegistryModules, SessionRegistry } from './relay'
import type { RepoRegistry } from './repo-registry'
import type { ServerRoleConfig } from './roles'
import { withOperation } from './store/executor/operation-scope'
import type { UsersRepository } from './store/users'

const log = createLogger('server:trpc')

/**
 * The tRPC core shared by the hand-written routers (router.ts) and the derived
 * issues router (modules/issues/trpc.ts, the P3 command registry [spec:SP-3fe2]):
 * ONE `initTRPC` instance + the request Context + the tiny ctx accessors. Split
 * out of router.ts so the derivation helper can import them without a runtime
 * cycle (router.ts imports the helper).
 */

export interface Context {
  registry: SessionRegistry
  repos: RepoRegistry
  /** Stable hosted workspace identity for pre-auth join URLs; absent on self-hosted. */
  workspaceId?: string
  superagent: SuperagentService
  cloud?: CloudRuntimeProvider
  /** What this caller may do with issues. The authenticated principal below is
   *  mandatory so no production or test transport can silently become the
   *  historical ambient operator. */
  capability: Capability
  principal: CommandPrincipal
  /** Set by the daemon relay when an agent passed --outside-scope, allowing a knowing
   *  write outside its subtree. Undefined for the operator (/trpc) and the superagent. */
  overrideScope?: boolean
  /** Typed accessor to the composed services (issue #13 Phase 2). Optional so
   *  existing context builders keep working — mods() falls back to the
   *  registry's own composition. */
  modules?: RegistryModules
  /** Runtime role composition (roles.ts): hub-only procs 404 when the hub role
   *  is off. Optional so existing context builders keep the historical shape
   *  (absent = core + hub, exactly as before roles existed). */
  role?: ServerRoleConfig
  /** The opt-in telemetry emitter [spec:SP-f933], so `telemetry.preview` can
   *  render the REAL pending report instead of a hand-written sample that could
   *  drift from what is actually sent. Optional: contexts without one (tests,
   *  the in-process MCP caller) simply have no preview. Consent state itself is
   *  read from config.json, never from here — it must work with no server.
   *
   *  `recordCrash` joined `buildUsageReport` on this Pick in chunk 3 of the
   *  logging strategy: `logs.crash` is the call site the crash tier never had
   *  (it shipped with zero of them). The Pick stays a Pick — the ingestion
   *  handler may offer a crash to the emitter and may do nothing else with it,
   *  and in particular cannot read or write consent, which lives in config.json
   *  so that turning telemetry off works with no server. */
  telemetry?: { emitter: Pick<TelemetryEmitter, 'buildUsageReport' | 'recordCrash'> }
  /** Accounts and their credentials (POD-1554). `auth.setPassword` writes the CALLER's
   *  credential, so the instance family needs the repository; optional because a context
   *  can be built without one, and the commands refuse rather than invent an account. */
  users?: UsersRepository
  /** Is login required on this instance — `credentialsRequired()` from server.ts. */
  loginRequired?: () => boolean | Promise<boolean>
  loginPolicy?: () => Promise<import('./modules/instance/service').InstanceLoginPolicy>
  /**
   * This process's event-loop accounting rings, which `perf.snapshot` reports
   * alongside the timings (loop design §7.2).
   *
   * A property of the PROCESS rather than of the registry, which is why it is on
   * the context rather than in `RegistryModules`. Optional and absent at profile
   * level `off`: at that level nothing is installed and the snapshot omits its
   * whole `loop` section, which is the honest answer.
   */
  loopAccounting?: LoopAccountingHandle
  /** Source-host only: schedule the verified redeploy unit after an operator
   * authorizes a target newer than this server's boot identity. */
  requestCoordinatorRestart?: () => void | Promise<void>
  /** This coordinator's own install shape; absent remains unknown and visible. */
  serverInstallKind?: 'installed' | 'source'
  /** Required by updater endpoints; supplied by server composition. */
  serverPlacement?: ServerPlacement
  /** This deployment's lifecycle projection, read live (POD-2766). `setup.activate`
   *  needs it to refuse an instance that is not actually activation-pending, which
   *  is what keeps a control-plane restart from being a remote bounce lever. */
  readiness?: () => ServerReadiness
  /** Podium Connect (PDM-51): `connect.check` asks the cloud whether a public URL
   *  is reachable; `publicUrlChanged` publishes a URL Settings just wrote (POD-4640).
   *  Optional: absent when Connect is not wired (tests). */
  connect?: Pick<ConnectPublisher, 'check' | 'publicUrlChanged'> &
    Partial<Pick<ConnectPublisher, 'stableLink'>>
  tunnelHealth?: () => import('@podium/runtime/tunnel-health').TunnelHealth | null
  /** This server process is supervised and replaced by the native desktop shell. */
  desktopSupervised?: boolean
  /** Installed coordinator-only exact-target delivery before the process-manager restart. */
  prepareCoordinatorUpdate?: PrepareCoordinatorUpdate
  /** Source-host only: rebuild BOTH websites via podium-web when the server is
   *  current — the unit builds apps/web/dist and apps/mobile/dist together. */
  requestWebRebuild?: () => void
  /**
   * Source-host only: compile the signed development tarball other computers
   * download. `/version` still asks without blocking; Update awaits this so
   * remotes are not granted a git-only identity.
   */
  requestDestBundle?: () => Promise<unknown>
  /** Source-host preparation state for honest update progress and failure reporting. */
  updatePreparation?: () => {
    webReady: boolean
    bundleReady: boolean
    failureDetail?: string
  }
  /** Source-host pre-release stage. Reads are hidden from non-admin callers. */
  releaseProposal?: () => Promise<ReleaseProposal | undefined>
  /** Admin approval admits build + publication only, never rollout. */
  approveReleaseProposal?: (
    approvedBy: string,
    expected: Pick<ReleaseProposal, 'headSha' | 'version'>,
  ) => Promise<ReleaseProposal | undefined>
  /** Install identity currently served from apps/web/dist, if any. */
  servedWebDigest?: () => string | undefined
  /** The phone website served from apps/mobile/dist, present or not (POD-1980).
   *  Not a bare digest: absent and unstamped share one `undefined` and need
   *  opposite verdicts — see `servedWebIdentity`. */
  servedMobileWeb?: () => MobileWebIdentity
}

/** The typed module seam router procs reach services through (ctx.modules when
 *  the context provides it, else the registry's composed set). */
export function mods(ctx: Context): RegistryModules {
  return ctx.modules ?? ctx.registry.modules
}

/** The caller identity issue-command authorization runs against. */
export function issueCaller(ctx: Context): IssueCaller {
  return {
    capability: ctx.capability,
    principal: ctx.principal,
    ...(ctx.overrideScope !== undefined ? { overrideScope: ctx.overrideScope } : {}),
  }
}

/**
 * Put back on the wire the two things tRPC drops with `cause` — ADDITIVELY, so
 * every error a client already renders keeps its shape and its `message`.
 *
 * `data.conflict` is a refused expected-revision precondition (ADR 3 D13.3):
 * which revision the authority expected and which it is actually at, so a client
 * that must rebase is not left parsing English.
 *
 * `data.causeChain` is everything UNDER the error, rendered as one line
 * [POD-3805]. A store failure arrives wrapped — `Failed query: insert into
 * "locks"` over `ParallelNestedTransactionError` — and `cause` is dropped at this
 * boundary, so the operator-facing half of the sentence never reached the UI at
 * all (POD-3802 §2). It is a string rather than a serialized error: this travels
 * to a client, and a stack is for the server log.
 *
 * Exported because it is the only testable seam here — `initTRPC.create()`
 * swallows the formatter, and `createCaller` never runs it.
 */
export function errorShapeWithCause<TShape extends { data: Record<string, unknown> }>(
  shape: TShape,
  error: { readonly cause?: unknown },
): TShape {
  const conflict = error.cause instanceof IssueRevisionConflict ? error.cause.detail : undefined
  const causeChain =
    error.cause === undefined || error.cause === null ? undefined : describeError(error.cause)
  if (conflict === undefined && causeChain === undefined) return shape
  return {
    ...shape,
    data: {
      ...shape.data,
      ...(conflict === undefined ? {} : { conflict }),
      ...(causeChain === undefined ? {} : { causeChain }),
    },
  }
}

/**
 * What a WRITE route says about itself (ADR 12 D9, POD-6593): the registration it
 * reaches and which path that registration is on. Only the write-route
 * generator (`modules/write-routes/`) sets it, on every mutation it
 * builds; a query carries none. A test walks the served router and holds every
 * mutation to a registration in the sync or the plain registry.
 */
export interface WriteRouteMeta {
  /** The registration's wire name (`layout.set`, `logs.forward`), or
   *  {@link ANY_SYNC_REGISTRATION} for `sync.submit`, whose envelope names one. */
  readonly registration: string
  readonly path: 'sync' | 'plain' | 'direct'
}

/** `sync.submit`'s registration: whichever the envelope names. */
export const ANY_SYNC_REGISTRATION = '*'

/** A procedure's meta: a write route's, or nothing (a query). */
export type RouteMeta = Partial<WriteRouteMeta>

/** Composed at rebase with POD-701's timing core: one create() carries both. */
const core = initTRPC
  .context<Context>()
  .meta<RouteMeta>()
  .create({
    errorFormatter({ shape, error }) {
      return errorShapeWithCause(shape, error)
    },
  })

/** Slow-call visibility [POD-701]: one warning when a procedure exceeds
 *  this, throttled per path so a storm can't flood the logs. */
const SLOW_RPC_WARN_MS = 500
const SLOW_RPC_WARN_THROTTLE_MS = 10_000
const lastSlowWarnAt = new Map<string, number>()

/** Times EVERY procedure call into the perf registry [POD-701]. Attached to the
 *  base procedure below so all routers (hand-written + derived) inherit it. */
const rpcTiming = core.middleware(async ({ path, next }) => {
  const start = performance.now()
  try {
    return await next()
  } finally {
    const ms = performance.now() - start
    // ATTRIBUTED TO THE DEPLOYMENT, and that is a claim rather than a shrug
    // [POD-736]. RPC timing is process-wide diagnostic of the server's own
    // request path, not work done on a principal's feed slice — so it stays
    // off the per-principal table. Client switch traces are different: they
    // carry one person's session ids and are partitioned by the transport
    // principal at the report seam (POD-1230 / modules/perf/commands.ts).
    perf.record('rpc', path, ms, DEPLOYMENT)
    // The `rpc` cost bucket (§6.1). WALL time across the handler's awaits, not
    // own-CPU: the synchronous slices between them are not separable at this
    // seam, and a middleware that only timed the first one would under-report
    // every procedure that touches the store. So the number is real but
    // INCLUSIVE — `LOOP_INCLUSIVE_BUCKETS` says so in the record, which is how a
    // reader knows not to add it to the others and expect busy time back.
    attribute('rpc', ms)
    if (ms >= SLOW_RPC_WARN_MS) {
      const now = Date.now()
      const last = lastSlowWarnAt.get(path) ?? 0
      if (now - last >= SLOW_RPC_WARN_THROTTLE_MS) {
        lastSlowWarnAt.set(path, now)
        log.warn('slow rpc', { path, durationMs: ms })
      }
    }
  }
})

/** One call is one operation [POD-6189]: memos that opt in (the grants loader)
 *  answer a row once for the whole call, before, inside and after its write
 *  spans. See `store/executor/operation-scope.ts`. */
const oneOperation = core.middleware(
  async ({ next }) => await withOperation(async () => await next()),
)

/** The base procedure: the always-on timing middleware and the operation scope. */
const baseProcedure = core.procedure.use(rpcTiming).use(oneOperation)

// ---------------------------------------------------------------------------
// The query-only builder (ADR 12 D9, POD-6593)
// ---------------------------------------------------------------------------

/** tRPC's own (unexported) `IntersectIfDefined`, which its builder chains with. */
type IntersectIfDefined<A, B> = A extends UnsetMarker
  ? B
  : B extends UnsetMarker
    ? A
    : Simplify<A & B>

/**
 * A procedure builder with NO `.mutation`: `.input`, `.output`, `.meta` and
 * `.use` chain to another query-only builder, and it ends in `.query` or
 * `.subscription`. It is the builder every module gets as `t.procedure`, so a
 * module cannot build a write route: every write route is generated from a
 * registration by `modules/write-routes/`, which alone holds the full builder
 * ({@link claimWriteProcedureBuilder}). `write-routes.typecheck.ts` holds the
 * missing `.mutation` with `@ts-expect-error`.
 *
 * The signatures are tRPC's own (`ProcedureBuilder`), without its compile-time
 * refusal to chain an optional parser onto a required one.
 */
export interface QueryProcedureBuilder<C, M, CO, II, IO, OI, OO> {
  input<$P extends Parser>(
    schema: $P,
  ): QueryProcedureBuilder<
    C,
    M,
    CO,
    IntersectIfDefined<II, inferParser<$P>['in']>,
    IntersectIfDefined<IO, inferParser<$P>['out']>,
    OI,
    OO
  >
  output<$P extends Parser>(
    schema: $P,
  ): QueryProcedureBuilder<
    C,
    M,
    CO,
    II,
    IO,
    IntersectIfDefined<OI, inferParser<$P>['in']>,
    IntersectIfDefined<OO, inferParser<$P>['out']>
  >
  meta(meta: M): QueryProcedureBuilder<C, M, CO, II, IO, OI, OO>
  use<$CO>(
    fn: MiddlewareBuilder<Overwrite<C, CO>, M, $CO, IO> | MiddlewareFunction<C, M, CO, $CO, IO>,
  ): QueryProcedureBuilder<C, M, Overwrite<CO, $CO>, II, IO, OI, OO>
  query: ProcedureBuilder<C, M, CO, II, IO, OI, OO, false>['query']
  subscription: ProcedureBuilder<C, M, CO, II, IO, OI, OO, false>['subscription']
}

/** The query-only view of a full builder. */
type QueryOnly<B> =
  B extends ProcedureBuilder<
    infer C,
    infer M,
    infer CO,
    infer II,
    infer IO,
    infer OI,
    infer OO,
    false
  >
    ? QueryProcedureBuilder<C, M, CO, II, IO, OI, OO>
    : never

/** The builder modules get: queries only. */
export type ModuleProcedureBuilder = QueryOnly<typeof baseProcedure>

/** The shared tRPC core: identical to `initTRPC.create()` except `procedure`
 *  carries the always-on timing middleware and the operation scope, and builds
 *  QUERIES only ({@link QueryProcedureBuilder}). */
export const t = {
  ...core,
  procedure: baseProcedure as ModuleProcedureBuilder,
}

/** The builder a write route is built from. */
export type WriteProcedureBuilder = typeof baseProcedure

let writeBuilderClaimed = false

/**
 * The builder WRITE routes are made from, handed out ONCE (POD-6593). The
 * write-route generator claims it when it loads; any second claimant fails at
 * boot. So the one module that may build a mutation is the one that holds it,
 * and every write route is generated there from a registration.
 */
export function claimWriteProcedureBuilder(): WriteProcedureBuilder {
  if (writeBuilderClaimed) {
    throw new Error(
      'trpc: the write procedure builder is already claimed; write routes are generated by modules/write-routes/ only',
    )
  }
  writeBuilderClaimed = true
  return baseProcedure
}

import type { TelemetryEmitter } from '@podium/telemetry'
import { initTRPC } from '@trpc/server'
import type { CloudRuntimeProvider } from './cloud-runtime'
import type { CommandPrincipal } from './command-principal'
import type { Capability } from './issue-authz'
import type { IssueCaller } from './modules/issues/command-ctx'
import { IssueRevisionConflict } from './modules/issues/conflict'
import { DEPLOYMENT, perf } from './modules/perf/registry'
import type { SuperagentService } from './modules/superagent'
import type { RegistryModules, SessionRegistry } from './relay'
import type { MachineRepoDiscovery } from './repo-discovery'
import type { RepoRegistry } from './repo-registry'
import type { ServerRoleConfig } from './roles'
import type { UsersRepository } from './store/users'

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
  /** Tiered per-machine repo discovery (POD-787) [spec:SP-3701]. Optional so test
   *  callers that don't exercise discovery need not construct one. */
  discovery?: MachineRepoDiscovery
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
   *  read from config.json, never from here — it must work with no server. */
  telemetry?: { emitter: Pick<TelemetryEmitter, 'buildUsageReport'> }
  /** Accounts and their credentials (POD-1554). `auth.setPassword` writes the CALLER's
   *  credential, so the instance family needs the repository; optional because a context
   *  can be built without one, and the commands refuse rather than invent an account. */
  users?: UsersRepository
  /** Is login required on this instance — `credentialsRequired()` from server.ts. */
  loginRequired?: () => boolean
  /** Source-host only: schedule the verified redeploy unit after an operator
   * authorizes a target newer than this server's boot identity. */
  requestCoordinatorRestart?: () => void
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

const core = initTRPC.context<Context>().create({
  /**
   * Lift a refused expected-revision precondition onto `error.data.conflict`
   * (ADR 3 D13.3). tRPC drops `cause` on the way out, so without this the
   * authority's structured rejection — which revision it expected, which it is
   * actually at — would reach the client only as prose in `message`, and a
   * client that must rebase would be left parsing English. Additive: every
   * other error keeps its default shape. Composed at rebase with POD-701's
   * timing core: one create() call carries both concerns.
   */
  errorFormatter({ shape, error }) {
    if (!(error.cause instanceof IssueRevisionConflict)) return shape
    return { ...shape, data: { ...shape.data, conflict: error.cause.detail } }
  },
})

/** Slow-call visibility [POD-701]: one console.warn when a procedure exceeds
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
    if (ms >= SLOW_RPC_WARN_MS) {
      const now = Date.now()
      const last = lastSlowWarnAt.get(path) ?? 0
      if (now - last >= SLOW_RPC_WARN_THROTTLE_MS) {
        lastSlowWarnAt.set(path, now)
        console.warn(`[perf] slow rpc ${path} took ${Math.round(ms)}ms`)
      }
    }
  }
})

/** The shared tRPC core: identical to `initTRPC.create()` except `procedure`
 *  carries the always-on timing middleware. */
export const t = {
  ...core,
  procedure: core.procedure.use(rpcTiming),
}

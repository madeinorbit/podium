import type { TelemetryEmitter } from '@podium/telemetry'
import { initTRPC } from '@trpc/server'
import type { CloudRuntimeProvider } from './cloud-runtime'
import type { Capability } from './issue-authz'
import type { IssueCaller } from './modules/issues/registry'
import type { SuperagentService } from './modules/superagent'
import type { RegistryModules, SessionRegistry } from './relay'
import type { RepoRegistry } from './repo-registry'
import type { ServerRoleConfig } from './roles'

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
  superagent: SuperagentService
  cloud?: CloudRuntimeProvider
  /** What this caller may do with issues (authz, distinct from the login authn on /trpc).
   *  Every HTTP caller is the OPERATOR today; the in-process MCP passes its own. */
  capability: Capability
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
    ...(ctx.overrideScope !== undefined ? { overrideScope: ctx.overrideScope } : {}),
  }
}

export const t = initTRPC.context<Context>().create()

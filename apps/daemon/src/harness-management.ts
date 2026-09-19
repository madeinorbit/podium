import { manifestFor } from '@podium/harness'
import { declaredValue } from '@podium/harness'
import type { DaemonHarnessRuntime } from './harness-runtime.js'
import type { DaemonMachineRuntime } from './runtime/machine-runtime'
import type { DaemonContext } from './control/context'

/**
 * HARNESS MANAGEMENT OWNERSHIP BOUNDARY (POD-4305, F11/F12).
 *
 * Install, login, model discovery, historical usage, account quota and quota-history
 * boot seed must remain available BEFORE any agent exists — logged-out, uninstalled,
 * zero sessions, historical closed sessions, multiple credential homes. The live
 * `AgentSessionHandle` contract intentionally does not provide these: `handle.usage()`
 * reports one live session's context percentage (or a refusal), never hour×model
 * harvest, account windows or boot history; live verbs cannot reprobe executables,
 * enumerate models or resolve a native login command before a handle exists.
 *
 * OWNERSHIP RULE: everything in this module is non-live. Management services take
 * `HarnessManagementContext` — a `Pick` that EXCLUDES live-session state (`bridges`,
 * `observers`, `composerEngine`, `outputScheduler`, `clientTerminals`,
 * `runningHeadlessTurns`, `nativeClient*`, `sessionScreens`, handle registries).
 * Adding a live field to this Pick is a boundary violation: legacy turn-path removal
 * (POD-4279) must never delete these services because they sit outside the live
 * contract, and live-session cleanup (kill/reap/close) must never retire them.
 *
 * Credential-home/account and instance isolation are part of the boundary:
 * - `resolveManagementCredentialHome` prefers the provisioned native-account HOME
 *   (`accountHome.path`) over the instance agent HOME (`homeDir`). Model discovery
 *   and login reads must name the account the child will run as (POD-2692); the
 *   server's `apiKeys.anthropic` secret is never shipped down for this.
 * - `managementInventoryCacheKey` keys inventory by `(machineId, homeDir)` with a
 *   real NUL separator so two credential homes on one machine never share one
 *   observation, and two machines never share one snapshot.
 * - Executable/version admission stays manifest-bound: the generation snapshot's
 *   verified executable + command environment is what login and launch bind to,
 *   never a re-resolved binary. `managementLoginCommandFor` returns the static
 *   manifest argv only; binding happens against `DaemonHarnessRuntime.current()`.
 *
 * No shell manifest or driver is added here: shells and native login panes stay
 * plain PTYs under POD-4278. This module only resolves the login argv that the
 * plain-terminal path launches.
 */

/** Non-live management services only. Never add bridges, observers, composer, scheduler, client terminals, headless turns or handle registries. */
export type HarnessManagementContext = Pick<
  DaemonContext,
  | 'send'
  | 'machineId'
  | 'homeDir'
  | 'accountHome'
  | 'harnessRuntime'
  | 'quotaFetcher'
  | 'usageMemo'
  | 'harnessLoginState'
> & {
  /**
   * Inventory fallback only. The legacy prober (`agentRuntime.inventory()`) is a
   * management read — install/version/login per harness — not a live handle. Only
   * `inventory()` may be reached through this field; `handleFor`, `create`,
   * `bindTerminal` and every other verb stay outside the boundary.
   */
  agentRuntime?: Pick<DaemonMachineRuntime, 'inventory'>
  harnessRuntime?: Pick<DaemonHarnessRuntime, 'current' | 'isCurrent' | 'reprobe' | 'refresh' | 'launch'>
}

/**
 * Which HOME management reads (model probe, login) observe.
 *
 * The provisioned native-account HOME wins: on a named instance the credentials
 * live under an isolated agent-home, and a login read run with the operator's HOME
 * cheerfully answers about the operator instead (POD-2692). Falls back to the
 * instance agent HOME, then to undefined (real process HOME) when neither is set.
 */
export function resolveManagementCredentialHome(
  ctx: Pick<HarnessManagementContext, 'accountHome' | 'homeDir'>,
): string | undefined {
  return ctx.accountHome?.path ?? ctx.homeDir
}

/**
 * Inventory cache identity: one observation per (machine, credential home).
 *
 * The separator is a real NUL, deliberately: NUL cannot occur in a machineId or a
 * path, so the composite key can never collide — but a LITERAL NUL byte makes git,
 * grep and `file` classify the module as BINARY (see POD-758 and the guard in
 * `control/inventory.ts`). Keyed by `(machineId, homeDir)` and holding
 * `MachineHarnessInventory` — a per-machine fact with visibility class
 * `owned-compute` inheriting its machine's scoping, never an instance-global
 * "current inventory" (cf. ADR 1 Amendment 1 D13.5, POD-1079).
 */
export function managementInventoryCacheKey(
  machineId: string,
  homeDir: string | undefined,
): string {
  // ESCAPED NUL, deliberately never a literal NUL byte: a literal NUL makes
  // git/grep/file classify this module as BINARY (POD-758). NUL cannot occur in
  // a machineId or a path, so the composite key can never collide.
  return `${machineId}${SEP}${homeDir ?? ''}`
}

// Single NUL separator, built without a literal NUL byte in source.
const SEP = String.fromCharCode(0)

/** Static native login argv for one harness, or undefined when it declares none. Never needs a handle. */
export function managementLoginCommandFor(
  loginHarness: string,
): { cmd: string; args: readonly string[] } | undefined {
  return declaredValue(
    manifestFor(loginHarness)?.inventory.loginCommand ?? {
      supported: false,
      reason: 'unknown harness',
    },
  )
}

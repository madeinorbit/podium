import {
  declaredValue,
  type HarnessAccountScope,
  type HarnessContext,
  type HarnessEnvironment,
  type HarnessExecutableSnapshot,
  harnessAccount,
  harnessContext,
  manifestFor,
  type ResolvedHarnessInventory,
} from '@podium/harness'
import { makeQuotaFetcher } from '@podium/harness/inventory'
import type { BuiltinHarnessKind } from '@podium/protocol'
import type { DaemonContext } from './control/context'
import type { DaemonHarnessRuntime } from './harness-runtime.js'
import type { DaemonMachineRuntime } from './runtime/machine-runtime'

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
 * `nativeClient*`, `sessionScreens`, handle registries).
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
  harnessRuntime?: Pick<
    DaemonHarnessRuntime,
    'current' | 'isCurrent' | 'reprobe' | 'refresh' | 'launch' | 'settled'
  >
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
 * THE ACCOUNT A MANAGEMENT READ ANSWERS FOR (POD-6534, design §3.3 "account
 * scope"): the credential home and the machine command environment of the
 * current inventory generation. Every per-harness answer is built from these
 * two by the harness contract's one recipe — {@link managementAccountFor} (no
 * installation needed) or {@link managementContextFor} (installed harnesses)
 * — so model probes, quota, usage, credentials, the Codex Responses call and
 * transcript reads all name the folders the session child uses, never the
 * daemon's own HOME or `process.env`.
 */
export interface ManagementAccount {
  /** `accountHome ?? homeDir ?? the snapshot's machine home`, the daemon's
   *  `credentialHome` rule. */
  readonly home: string
  /** The snapshot's command environment; `{}` without a snapshot, so folders
   *  come from `home` alone. */
  readonly machineEnv: HarnessEnvironment
  readonly snapshot?: HarnessExecutableSnapshot
}

type ManagementAccountSource = Pick<HarnessManagementContext, 'accountHome' | 'homeDir'> & {
  harnessRuntime?:
    | {
        current(): Promise<ResolvedHarnessInventory>
        settled?(): ResolvedHarnessInventory | undefined
      }
    | undefined
}

/**
 * Resolve the management account. `wait: false` takes the last SETTLED
 * snapshot instead of joining an inventory wave in flight — for reads whose
 * latency a user feels (transcripts); before the first wave settles it uses
 * no machine env. `undefined` only when no home can be named at all.
 */
export async function resolveManagementAccount(
  ctx: ManagementAccountSource,
  opts: { wait?: boolean } = {},
): Promise<ManagementAccount | undefined> {
  const runtime = ctx.harnessRuntime
  const snapshot =
    opts.wait === false ? runtime?.settled?.() : await runtime?.current().catch(() => undefined)
  const home = resolveManagementCredentialHome(ctx) ?? snapshot?.commandEnvironment.machineHome
  if (!home) return undefined
  return {
    home,
    machineEnv: snapshot?.commandEnvironment.env ?? {},
    ...(snapshot ? { snapshot } : {}),
  }
}

/**
 * The daemon's quota memo, reading each harness's quota as the management
 * account (POD-6534, F08). The account is resolved per fetch, so a new
 * inventory generation's command env is picked up; with no home to name, the
 * fetch fails into an error wire rather than reading the daemon's home.
 */
export function managementQuotaFetcher(
  ctx: ManagementAccountSource,
): ReturnType<typeof makeQuotaFetcher> {
  return makeQuotaFetcher({
    account: async () => {
      const account = await resolveManagementAccount(ctx)
      if (!account) throw new Error('quota read refused: no account home')
      return { homeDir: account.home, env: account.machineEnv }
    },
  })
}

/** One harness's account half (roots and env), installed or not. */
export function managementAccountFor(
  account: ManagementAccount,
  kind: string,
): HarnessAccountScope {
  return harnessAccount(kind, account.home, account.machineEnv)
}

/** One installed harness's full context; `undefined` when this generation has
 *  no executable for it (never a basename fallback). */
export function managementContextFor(
  account: ManagementAccount,
  kind: BuiltinHarnessKind,
): HarnessContext | undefined {
  if (!account.snapshot?.executables.has(kind)) return undefined
  return harnessContext(account.snapshot, kind, account.home)
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
): { args: readonly string[] } | undefined {
  return declaredValue(
    manifestFor(loginHarness)?.inventory.loginCommand ?? {
      supported: false,
      reason: 'unknown harness',
    },
  )
}

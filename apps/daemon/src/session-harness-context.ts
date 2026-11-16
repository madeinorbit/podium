/**
 * THE SESSION-PINNED HARNESS CONTEXT, ON THE DAEMON SIDE (POD-6533,
 * docs/design/harness-access-contract.md §3.3).
 *
 * A session's context is built ONCE, where its SessionSpec is assembled, from
 * the inventory as it stands at spawn. Launch, hook installation and the
 * observer all read that one value off the spec; none of them asks the
 * inventory again, so a refresh between them cannot split the session across
 * two installations.
 *
 * Lifetime: daemon memory, with the session (`DaemonSession.harnessContext`).
 * The binding store is not extended. A daemon restart rebuilds the context
 * from the current inventory on reattach: roots depend only on the home and
 * the account env, so the rebuilt context names the same folders, and the
 * running process is never relaunched.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  type HarnessContext,
  type HarnessExecutableSnapshot,
  harnessContext,
  harnessDriverContext,
  harnessLoginReadEnv,
  harnessRoots,
  withHarnessHome,
} from '@podium/harness'
import { createLogger } from '@podium/logger'
import type { AgentKind, BuiltinHarnessKind, SessionId } from '@podium/model'
import { parseHomeId } from '@podium/protocol'
import type { DaemonContext } from './control/context'
import { resolveManagementCredentialHome } from './harness-management'
import type { HarnessHome } from './homes/registry'
import { prepareHomeLaunch } from './homes/share'

const log = createLogger('daemon:harness-context')

type ContextSource = Pick<DaemonContext, 'harnessRuntime' | 'accountHome' | 'homeDir'> &
  Partial<Pick<DaemonContext, 'access' | 'homes'>>

/** A session's credential names a home this machine does not hold. */
export class HomeNotOnMachineError extends Error {
  override readonly name = 'HomeNotOnMachineError'
}

/**
 * The Podium home session `sessionId` runs in (credential management §10), or
 * undefined for the harness's own directory. A home the access names that
 * this machine does not hold, or one made for another harness, throws: the
 * session is never started on the harness's own login instead.
 */
export function sessionHomeFor(
  ctx: Partial<Pick<DaemonContext, 'access' | 'homes'>>,
  sessionId: SessionId | undefined,
  kind: AgentKind,
): HarnessHome | undefined {
  if (!sessionId || !ctx.access) return undefined
  const homeId = ctx.access.homeIdOf(sessionId)
  if (homeId === undefined) return undefined
  const home = ctx.homes?.get(homeId)
  if (!home || parseHomeId(homeId)?.harness !== kind) {
    throw new HomeNotOnMachineError(
      `This session's login lives in a home this machine does not hold (${homeId}), so it was not started on the machine's own login instead. Sign in to that credential on this machine, or pick another credential.`,
    )
  }
  return home
}

/**
 * `context`, moved into the session's home when it has one, with the home
 * made ready for a start: the person's settings linked and, for Claude Code,
 * its state file seeded with the person's MCP servers. Unchanged for a
 * session on the harness's own directory.
 */
export function inSessionHome(
  ctx: Partial<Pick<DaemonContext, 'access' | 'homes'>>,
  sessionId: SessionId | undefined,
  context: HarnessContext,
): HarnessContext {
  const home = sessionHomeFor(ctx, sessionId, context.installation.kind)
  if (!home) return context
  prepareHomeLaunch(home, {
    defaultDir: context.roots.state,
    personClaudeState: claudeStateFile(context),
  })
  return withHarnessHome(context, { id: home.homeId, dir: home.dir })
}

/** Where Claude Code keeps its state file for the harness's own directory. */
export function claudeStateFile(context: HarnessContext): string {
  const configDir = context.env.CLAUDE_CONFIG_DIR?.trim()
  return configDir ? join(configDir, '.claude.json') : join(context.home, '.claude.json')
}

/**
 * Build the context a new session of `kind` runs under: the inventory's
 * current installation, and the daemon's credential home
 * (`accountHome ?? homeDir ?? machine home`, the one home host-runtime hands
 * the inventory's login probes).
 *
 * Throws when the inventory has no executable for `kind`: a session never
 * falls back to a basename on the daemon's PATH.
 */
export async function buildSessionHarnessContext(
  ctx: ContextSource,
  kind: BuiltinHarnessKind,
  /** The session it is for: its access names the home it runs in. */
  sessionId?: SessionId,
): Promise<HarnessContext> {
  if (!ctx.harnessRuntime) return inSessionHome(ctx, sessionId, launchSeamHarnessContext(ctx, kind))
  const snapshot = await ctx.harnessRuntime.current()
  const home = resolveManagementCredentialHome(ctx) ?? snapshot.commandEnvironment.machineHome
  return inSessionHome(ctx, sessionId, harnessContext(snapshot, kind, home))
}

/**
 * The context a new SERVER-MODE session of `kind` on `driverId` runs under
 * (POD-6546): {@link buildSessionHarnessContext}, except that a server
 * alternative with its own binary (opencode2) pins that binary, resolved in
 * the same command environment the inventory's alternative probe uses.
 */
export async function buildDriverHarnessContext(
  ctx: ContextSource,
  kind: BuiltinHarnessKind,
  driverId: string | undefined,
  sessionId?: SessionId,
): Promise<HarnessContext> {
  if (!ctx.harnessRuntime) return inSessionHome(ctx, sessionId, launchSeamHarnessContext(ctx, kind))
  return driverHarnessContextFrom(
    ctx,
    await ctx.harnessRuntime.current(),
    kind,
    driverId,
    sessionId,
  )
}

/** {@link buildDriverHarnessContext} over a snapshot the caller already read,
 *  so admission and the spec it admits share one inventory generation. */
export function driverHarnessContextFrom(
  ctx: Pick<DaemonContext, 'accountHome' | 'homeDir'> &
    Partial<Pick<DaemonContext, 'access' | 'homes'>>,
  snapshot: HarnessExecutableSnapshot,
  kind: BuiltinHarnessKind,
  /** Undefined: the harness's primary server, which runs its own executable. */
  driverId: string | undefined,
  /** The session it is for: its access names the home it runs in. */
  sessionId?: SessionId,
): HarnessContext {
  const home = resolveManagementCredentialHome(ctx) ?? snapshot.commandEnvironment.machineHome
  return inSessionHome(
    ctx,
    sessionId,
    driverId === undefined
      ? harnessContext(snapshot, kind, home)
      : harnessDriverContext(snapshot, kind, home, driverId),
  )
}

/**
 * THE ENGINE FAMILIES' `harnessContextFor` (POD-6546): the context an engine
 * launch with no spec in hand (adopt, wake) runs under.
 *
 * The one the session holds — the context it was spawned with, so a wake
 * after an inventory refresh relaunches the installation the session started
 * on. After a daemon restart the held one went with the old process: rebuilt
 * from the current inventory for this driver and kept on the session from
 * then on, which is also what native attach reads.
 *
 * Throws when the harness has left the inventory: an engine never falls back
 * to a basename on the daemon's PATH.
 */
export async function engineSessionHarnessContext(
  ctx: ContextSource & Pick<DaemonContext, 'sessions'>,
  sessionId: SessionId,
  kind: BuiltinHarnessKind,
  driverId: string | undefined,
): Promise<HarnessContext> {
  const held = ctx.sessions.get(sessionId)?.harnessContext
  if (held) return held
  const rebuilt = await buildDriverHarnessContext(ctx, kind, driverId, sessionId)
  // Kept on an entry that already exists, as on the terminal reattach path.
  const entry = ctx.sessions.get(sessionId)
  if (entry) entry.harnessContext = rebuilt
  return rebuilt
}

/**
 * The context a session already holds, or — after a daemon restart, when the
 * survivor's context went with the old process — one rebuilt from the current
 * inventory and kept on the session from then on.
 *
 * Undefined for a plain shell, and when no context can be rebuilt (the harness
 * has since left the inventory). Reattach must not fail on that: the process
 * is running and is never relaunched here, so the observer keeps its
 * home-based default instead.
 */
export async function sessionHarnessContextFor(
  ctx: ContextSource & Pick<DaemonContext, 'sessions'>,
  sessionId: SessionId,
  kind: AgentKind,
): Promise<HarnessContext | undefined> {
  if (kind === 'shell') return undefined
  const held = ctx.sessions.get(sessionId)?.harnessContext
  if (held) return held
  try {
    const rebuilt = await buildSessionHarnessContext(ctx, kind, sessionId)
    // Kept on an entry that already exists; a reattach that has not attached
    // yet stores it once the bridge is wired.
    const entry = ctx.sessions.get(sessionId)
    if (entry) entry.harnessContext = rebuilt
    return rebuilt
  } catch (err) {
    log.warn('could not rebuild the harness context for a surviving session', {
      err,
      sessionId,
      kind,
    })
    return undefined
  }
}

/**
 * THE `ctx.launch` TEST SEAM HAS NO INVENTORY. Production always composes a
 * `DaemonHarnessRuntime`; a daemon built with an injected argv builder (tests
 * only, see `DaemonContext.launch`) launches whatever that builder names, so
 * the installation here is a label, never spawned. Home and folders follow the
 * same credential-home rule as production.
 */
function launchSeamHarnessContext(ctx: ContextSource, kind: BuiltinHarnessKind): HarnessContext {
  const home = resolveManagementCredentialHome(ctx) ?? process.env.HOME ?? homedir()
  const env: Readonly<Record<string, string>> = Object.freeze(
    harnessLoginReadEnv<string>(kind, home, {}),
  )
  const context: HarnessContext = {
    installation: Object.freeze({
      kind,
      executable: `launch-seam:${kind}`,
      version: '',
      generation: 0,
    }),
    home,
    env,
    roots: Object.freeze(harnessRoots(kind, home, env)),
  }
  return Object.freeze(context)
}

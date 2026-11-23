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
 * The binding store is not extended. A daemon restart rebuilds the context on
 * reattach from the installation the session's row in the install ledger
 * records (managed installs §6.2), so it names the binary that really runs;
 * from the current inventory only when there is no row. Roots depend only on
 * the home and the account env, so the rebuilt context names the same
 * folders, and the running process is never relaunched.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  type HarnessContext,
  type HarnessExecutableSnapshot,
  type HarnessHomeSide,
  harnessContext,
  harnessContextOn,
  harnessDriverContext,
  harnessHomeVariable,
  harnessLoginReadEnv,
  harnessRoots,
  withHarnessHome,
} from '@podium/harness'
import { createLogger } from '@podium/logger'
import {
  type AgentKind,
  type BuiltinHarnessKind,
  isBuiltinHarnessKind,
  type SessionId,
} from '@podium/model'
import { HomeHarness, parseHomeId, parsePodiumHomeId } from '@podium/protocol'
import type { MachineHomeFacts } from './control/access'
import type { DaemonContext } from './control/context'
import { resolveManagementCredentialHome } from './harness-management'
import { ownLoginInPodiumHome, snapshotHomeFacts } from './homes/own-login'
import { type HarnessHome, isPodiumHome } from './homes/registry'
import { prepareHomeLaunch, type ShareSource } from './homes/share'
import { recordedInstallation } from './session-installs'

const log = createLogger('daemon:harness-context')

type ContextSource = Pick<DaemonContext, 'harnessRuntime' | 'accountHome' | 'homeDir'> &
  Partial<Pick<DaemonContext, 'access' | 'homes' | 'sessionInstalls'>>

type HomeSource = Partial<
  Pick<DaemonContext, 'access' | 'homes' | 'harnessRuntime' | 'accountHome' | 'homeDir'>
>

/** A session's credential names a home this machine does not hold. */
export class HomeNotOnMachineError extends Error {
  override readonly name = 'HomeNotOnMachineError'
}

/**
 * The facts of the last settled inventory wave, for a caller with no
 * snapshot in hand (a transcript read, a home's process list). A launch path
 * passes its own snapshot's facts, so its home and its binary agree.
 */
function settledHomeFacts(ctx: HomeSource): MachineHomeFacts {
  const settled = ctx.harnessRuntime?.settled?.()
  return settled ? machineHomeFacts(ctx, settled) : { managedInstall: () => false }
}

/**
 * The home facts of `snapshot` with the login files of the machine's own login
 * read through the daemon's credential home (`ownLoginInPodiumHome`): what
 * every launch path and account read of the `default` login decides by.
 */
export function machineHomeFacts(
  ctx: HomeSource,
  snapshot: Pick<HarnessExecutableSnapshot, 'managed'> &
    Partial<Pick<HarnessExecutableSnapshot, 'executables' | 'commandEnvironment'>>,
): MachineHomeFacts {
  const home = resolveManagementCredentialHome(ctx) ?? snapshot.commandEnvironment?.machineHome
  return snapshotHomeFacts(
    snapshot,
    home
      ? { homes: ctx.homes, account: { home, env: snapshot.commandEnvironment?.env ?? {} } }
      : {},
  )
}

/**
 * The Podium-made home session `sessionId` runs in (credential management
 * §10, managed installs §4.3), or undefined for the harness's own directory.
 * A home the access names that this machine does not hold, or one made for
 * another harness, throws: the session is never started on the harness's own
 * login instead. The Podium home is made when it is not there yet; filling
 * it is `PodiumHomes.reconcile`'s.
 */
export function sessionHomeFor(
  ctx: HomeSource,
  sessionId: SessionId | undefined,
  kind: AgentKind,
  machine: MachineHomeFacts = settledHomeFacts(ctx),
): HarnessHome | undefined {
  const homeId = sessionId && ctx.access ? ctx.access.homeIdOf(sessionId, machine) : undefined
  if (homeId === undefined) {
    // The machine's own login: the person's folder, or, where only Podium's
    // install is there, the Podium home (POD-7494).
    const podiumSide = ownLoginInPodiumHome(kind, machine)
    return podiumSide && ctx.homes ? ctx.homes.ensurePodiumHome(podiumSide).home : undefined
  }
  const podium = parsePodiumHomeId(homeId)
  if (podium && podium === kind && ctx.homes) return ctx.homes.ensurePodiumHome(podium).home
  const home = podium ? undefined : ctx.homes?.get(homeId)
  if (!home || parseHomeId(homeId)?.harness !== kind) {
    throw new HomeNotOnMachineError(
      `This session's login lives in a home this machine does not hold (${homeId}), so it was not started on the machine's own login instead. Sign in to that credential on this machine, or pick another credential.`,
    )
  }
  return home
}

/**
 * THE BINARY FOLLOWS THE HOME (managed installs §4.2, §6.1). The one place
 * that knows a session's home decides which installation it runs:
 *
 * - no home (the person's own harness folder): `build('person')`, the
 *   person's install, never Podium's;
 * - a home Podium made (the Podium home or a sign-in folder):
 *   `build('podium')`, Podium's install when there is one, else the
 *   person's, moved into the home, with the home made ready for a start.
 *
 * Made ready (§4.3, §4.6): a sign-in folder links its settings from the
 * Podium home when the machine has a managed install, else from the person's
 * folder, and Claude Code's state file there gets that folder's MCP servers.
 * The Podium home links nothing (it holds copies). Every home Podium made is
 * marked onboarded, and a delivered Claude API key is marked approved, so the
 * first turn is not a setup screen.
 *
 * `build` returns the context for that side in the account's own folders;
 * this moves it into the home.
 */
export function inSessionHome(
  ctx: HomeSource,
  sessionId: SessionId | undefined,
  kind: BuiltinHarnessKind,
  build: (side: HarnessHomeSide) => HarnessContext,
  machine: MachineHomeFacts = settledHomeFacts(ctx),
): HarnessContext {
  const home = sessionHomeFor(ctx, sessionId, kind, machine)
  if (!home) return build(defaultFolderSide(ctx, sessionId, kind, machine))
  const context = build('podium')
  const shareFrom = isPodiumHome(home) ? undefined : shareSourceFor(ctx, home, context, machine)
  const access = sessionId ? ctx.access?.current(sessionId) : undefined
  prepareHomeLaunch(home, {
    ...(shareFrom ? { shareFrom } : {}),
    ...(access?.delivery.kind === 'env'
      ? { deliveredEnv: { [access.delivery.variable]: access.delivery.secret } }
      : {}),
  })
  return withHarnessHome(context, { id: home.homeId, dir: home.dir })
}

/** Where a sign-in folder shares from: the Podium home on Podium's side (§4.6). */
function shareSourceFor(
  ctx: HomeSource,
  home: HarnessHome,
  context: HarnessContext,
  machine: MachineHomeFacts,
): ShareSource {
  const harness = HomeHarness.safeParse(home.harness)
  if (harness.success && machine.managedInstall(harness.data) && ctx.homes) {
    const podium = ctx.homes.ensurePodiumHome(harness.data).home
    return { dir: podium.dir, claudeState: join(podium.dir, '.claude.json') }
  }
  return { dir: context.roots.state, claudeState: claudeStateFile(context) }
}

/**
 * The side of the machine session `sessionId` runs on: `podium` when its
 * access names a home Podium made, else `person`. Throws as
 * {@link sessionHomeFor} does. For a caller that needs only the installation
 * (a headless turn's argv) and must not prepare the home.
 */
export function sessionHomeSide(
  ctx: HomeSource,
  sessionId: SessionId | undefined,
  kind: AgentKind,
  machine?: MachineHomeFacts,
): HarnessHomeSide {
  return sessionHomeFor(ctx, sessionId, kind, machine)
    ? 'podium'
    : defaultFolderSide(ctx, sessionId, kind, machine ?? settledHomeFacts(ctx))
}

/** Section 4.7: without a directory variable an admitted install uses the default folder.
 * If a personal copy appeared later, its own login still selects its own binary. */
function defaultFolderSide(
  ctx: HomeSource,
  sessionId: SessionId | undefined,
  kind: AgentKind,
  machine: MachineHomeFacts,
): HarnessHomeSide {
  if (!isBuiltinHarnessKind(kind) || harnessHomeVariable(kind) || !machine.managedInstall(kind))
    return 'person'
  const passedIn = sessionId && ctx.access?.current(sessionId)?.delivery.kind === 'env'
  return passedIn || !machine.externalInstall?.(kind) ? 'podium' : 'person'
}

/** Where Claude Code keeps its state file for the harness's own directory. */
export function claudeStateFile(context: HarnessContext): string {
  const configDir = context.env.CLAUDE_CONFIG_DIR?.trim()
  return configDir ? join(configDir, '.claude.json') : join(context.home, '.claude.json')
}

/**
 * Build the context a new session of `kind` runs under: the inventory's
 * current installation for the session's side ({@link inSessionHome}), and
 * the daemon's credential home
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
  if (!ctx.harnessRuntime)
    return inSessionHome(ctx, sessionId, kind, () => launchSeamHarnessContext(ctx, kind))
  const snapshot = await ctx.harnessRuntime.current()
  const home = resolveManagementCredentialHome(ctx) ?? snapshot.commandEnvironment.machineHome
  return inSessionHome(
    ctx,
    sessionId,
    kind,
    (side) => harnessContext(snapshot, kind, home, side),
    machineHomeFacts(ctx, snapshot),
  )
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
  if (!ctx.harnessRuntime)
    return inSessionHome(ctx, sessionId, kind, () => launchSeamHarnessContext(ctx, kind))
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
  ctx: Pick<DaemonContext, 'accountHome' | 'homeDir'> & HomeSource,
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
    kind,
    (side) =>
      driverId === undefined
        ? harnessContext(snapshot, kind, home, side)
        : harnessDriverContext(snapshot, kind, home, driverId, side),
    machineHomeFacts(ctx, snapshot),
  )
}

/**
 * The context a session's row in the install ledger records (managed
 * installs §6.2): the installation its process was started on, in the home
 * its access names, whatever the inventory holds now. Undefined when there is
 * no row for this harness, or no inventory to read the account half from.
 */
export async function recordedSessionHarnessContext(
  ctx: ContextSource,
  sessionId: SessionId,
  kind: BuiltinHarnessKind,
): Promise<HarnessContext | undefined> {
  if (!ctx.harnessRuntime || !ctx.sessionInstalls) return undefined
  const row = ctx.sessionInstalls.get(sessionId)
  if (!row || row.kind !== kind) return undefined
  const snapshot = await ctx.harnessRuntime.current()
  const home = resolveManagementCredentialHome(ctx) ?? snapshot.commandEnvironment.machineHome
  const installation = recordedInstallation(row, snapshot.commandEnvironment.generation)
  // The home it started in, not the one the inventory points at now (§4.2):
  // a passed-in credential ran in the Podium home exactly when its process
  // was started on Podium's install, so a session that began in the person's
  // folder before a managed install appeared is re-attached there.
  const startedOn: MachineHomeFacts = {
    managedInstall: (harness) => harness === kind && installation.provenance === 'managed',
  }
  return inSessionHome(
    ctx,
    sessionId,
    kind,
    () => harnessContextOn(snapshot, installation, home),
    startedOn,
  )
}

/**
 * THE ENGINE FAMILIES' `harnessContextFor` (POD-6546): the context an engine
 * launch with no spec in hand (adopt, wake) runs under, and what a client
 * attached to the engine runs.
 *
 * The one the session holds — the context it was spawned with, so a wake
 * after an inventory refresh relaunches the installation the session started
 * on — with one exception (managed installs §6.2): when that installation is
 * a release Podium manages and is no longer the current one, and no engine of
 * the session runs, a new context is built from the inventory as it stands,
 * in the same home. A parked session then never pins an old release; an
 * engine still running on it keeps its context, so its client runs the same
 * binary. The person's own install keeps today's rule.
 *
 * After a daemon restart the held one went with the old process: rebuilt from
 * the session's row in the install ledger (the binary that really runs), else
 * from the current inventory, and kept on the session from then on.
 *
 * Throws when the harness has left the inventory: an engine never falls back
 * to a basename on the daemon's PATH.
 */
export async function engineSessionHarnessContext(
  ctx: ContextSource & Pick<DaemonContext, 'sessions'>,
  sessionId: SessionId,
  kind: BuiltinHarnessKind,
  driverId: string | undefined,
  /**
   * Whether the engine under a durable label still runs (the session engine
   * scope's `engineAlive`). Absent: an engine is taken to run, so the held
   * context is kept.
   */
  engineAlive?: (label: string) => Promise<boolean>,
): Promise<HarnessContext> {
  const held = ctx.sessions.get(sessionId)?.harnessContext
  if (held) {
    if (
      !(await outdatedManagedRelease(ctx, held)) ||
      (await engineRunning(ctx, sessionId, engineAlive))
    )
      return held
  } else {
    const recorded = await recordedSessionHarnessContext(ctx, sessionId, kind)
    if (recorded) return keepOnSession(ctx, sessionId, recorded)
  }
  return keepOnSession(
    ctx,
    sessionId,
    await buildDriverHarnessContext(ctx, kind, driverId, sessionId),
  )
}

/** Kept on an entry that already exists, as on the terminal reattach path. */
function keepOnSession(
  ctx: Pick<DaemonContext, 'sessions'>,
  sessionId: SessionId,
  context: HarnessContext,
): HarnessContext {
  const entry = ctx.sessions.get(sessionId)
  if (entry) entry.harnessContext = context
  return context
}

/**
 * Whether `context` runs a release Podium manages that the inventory no
 * longer offers: Podium's install of the harness is now another release, or
 * there is none. The person's own install is never outdated here.
 */
async function outdatedManagedRelease(
  ctx: ContextSource,
  context: HarnessContext,
): Promise<boolean> {
  if (context.installation.provenance !== 'managed' || !ctx.harnessRuntime) return false
  const snapshot = await ctx.harnessRuntime.current()
  return snapshot.managed?.get(context.installation.kind)?.path !== context.installation.executable
}

/**
 * Whether the session's engine process runs: the label the session layer
 * started or re-attached it under, still live in its host. No label: no
 * engine of the session is known to run. A check that cannot be made, or
 * fails, reads as running, so the held context is kept.
 */
async function engineRunning(
  ctx: Pick<DaemonContext, 'sessions'>,
  sessionId: SessionId,
  engineAlive: ((label: string) => Promise<boolean>) | undefined,
): Promise<boolean> {
  const label = ctx.sessions.get(sessionId)?.engine?.label
  if (label === undefined) return false
  if (!engineAlive) return true
  try {
    return await engineAlive(label)
  } catch (err) {
    log.warn('could not tell whether the session engine runs', { err, sessionId, label })
    return true
  }
}

/**
 * The context a session already holds, or — after a daemon restart, when the
 * survivor's context went with the old process — one rebuilt from the
 * session's row in the install ledger (the binary that really runs), else
 * from the current inventory, and kept on the session from then on.
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
    const rebuilt =
      (await recordedSessionHarnessContext(ctx, sessionId, kind)) ??
      (await buildSessionHarnessContext(ctx, kind, sessionId))
    // Kept on an entry that already exists; a reattach that has not attached
    // yet stores it once the bridge is wired.
    return keepOnSession(ctx, sessionId, rebuilt)
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
      provenance: 'external',
    }),
    home,
    env,
    roots: Object.freeze(harnessRoots(kind, home, env)),
  }
  return Object.freeze(context)
}

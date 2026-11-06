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
import {
  type HarnessContext,
  harnessContext,
  harnessLoginReadEnv,
  harnessRoots,
} from '@podium/harness'
import { createLogger } from '@podium/logger'
import type { AgentKind, BuiltinHarnessKind, SessionId } from '@podium/model'
import type { DaemonContext } from './control/context'
import { resolveManagementCredentialHome } from './harness-management'

const log = createLogger('daemon:harness-context')

type ContextSource = Pick<DaemonContext, 'harnessRuntime' | 'accountHome' | 'homeDir'>

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
): Promise<HarnessContext> {
  if (!ctx.harnessRuntime) return launchSeamHarnessContext(ctx, kind)
  const snapshot = await ctx.harnessRuntime.current()
  const home = resolveManagementCredentialHome(ctx) ?? snapshot.commandEnvironment.machineHome
  return harnessContext(snapshot, kind, home)
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
    const rebuilt = await buildSessionHarnessContext(ctx, kind)
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

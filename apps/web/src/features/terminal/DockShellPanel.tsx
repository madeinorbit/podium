import { shallowEqual } from '@podium/client-core/store'
import { useTerminalSession } from '@podium/terminal-client-react'
import type { JSX } from 'react'
import { useEffect, useRef } from 'react'
import { useStoreSelector } from '@/app/store'
import { isKnownRefPrefix } from '@/lib/markdown'
import { activateRef } from '@/lib/ref-activation'
import { prettyCwd } from './AgentPanel'
import { TERMINAL_DEFAULTS } from './appearance'
import { useTerminalAppearance } from './use-terminal-appearance'

/**
 * The right dock's Shell panel (#23) [spec:SP-75b1]: one shell session per
 * worktree, living IN the dock — not in the workspace tab strip (the strip
 * filters ids in `dockShells`). The mapping is persisted, so a reload (or
 * closing and reopening the panel) reattaches the same shell with its
 * scrollback; a dead shell is archived and replaced with a fresh one.
 */
export function DockShellPanel({
  cwd,
  machineId,
}: {
  cwd: string
  machineId?: string
}): JSX.Element {
  const { hub, trpc, sessions, reposLoaded, dockShells, setDockShell, setDockVisibleSession } =
    useStoreSelector(
      (s) => ({
        hub: s.hub,
        trpc: s.trpc,
        sessions: s.sessions,
        reposLoaded: s.reposLoaded,
        dockShells: s.dockShells,
        setDockShell: s.setDockShell,
        setDockVisibleSession: s.setDockVisibleSession,
      }),
      shallowEqual,
    )
  const mapped = dockShells[cwd]
  const session = sessions.find((s) => s.sessionId === mapped)
  // Dead = unrevivable in place. 'starting' and 'reconnecting' are HEALTHY
  // transients — treating them as dead made this effect archive a spawning
  // shell and replace it, looping until the panel closed.
  const dead =
    !!session &&
    (session.archived || session.status === 'exited' || session.status === 'hibernated')
  const alive = !!session && !dead

  // The id we created and whose broadcast hasn't landed yet. While set, NEVER
  // create again — the first version of this effect looped on exactly that gap
  // (each spawn re-armed because its session wasn't in the store yet) and
  // stamped out a dozen shells in seconds.
  const pendingId = useRef<string | null>(null)
  if (pendingId.current && sessions.some((s) => s.sessionId === pendingId.current)) {
    pendingId.current = null
  }
  // Create only when we can DISTINGUISH "dead" from "not synced yet":
  //  - no mapping at all → fresh worktree, create (after boot data loaded);
  //  - mapped and the session row is present but dead → replace;
  //  - mapped but absent from a NON-EMPTY synced session list → gone, replace.
  // A mapped id with no session rows at all means the boot sync hasn't landed —
  // render the connecting state and wait, don't spawn a duplicate.
  const needsCreate =
    !alive && reposLoaded && pendingId.current === null && (!mapped || dead || sessions.length > 0)

  const creating = useRef(false)
  useEffect(() => {
    if (!needsCreate || creating.current) return
    creating.current = true
    void (async () => {
      try {
        // A mapped-but-dead shell can't be revived in place — archive it so it
        // never resurfaces as a workspace tab once the map points elsewhere.
        if (session && !session.archived) {
          await trpc.sessions.setArchived
            .mutate({ sessionId: session.sessionId, archived: true })
            .catch(() => {})
        }
        const { sessionId } = await trpc.sessions.create.mutate({
          agentKind: 'shell',
          cwd,
          ...(machineId ? { machineId } : {}),
        })
        pendingId.current = sessionId
        setDockShell(cwd, sessionId)
      } catch {
        // Leave the mapping as-is; the panel shows the connecting state and the
        // next store change retries.
      } finally {
        creating.current = false
      }
    })()
  }, [needsCreate, cwd, machineId, session, trpc, setDockShell])

  const terminalShown = alive && !!mapped && session.status !== 'starting'
  // Report the rendered dock shell in the viewState `visible` set: the server's
  // viewVisible gate drops resizes from clients not rendering a session, so an
  // unreported dock terminal would stay pinned to the spawn-default 80×24.
  useEffect(() => {
    if (!terminalShown || !mapped) return
    setDockVisibleSession(mapped)
    return () => setDockVisibleSession(null)
  }, [terminalShown, mapped, setDockVisibleSession])

  return (
    // min-w-0 the whole chain: a flex child's min-width:auto would let the
    // xterm canvas (sized before the first fit) push the column past the
    // dock's fixed width, and view.fit() then measures the OVERFLOWED box —
    // the terminal never shrinks back to the panel.
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex-none truncate border-b border-border px-3 py-1.5 text-[11px] text-muted-foreground/70">
        {prettyCwd(cwd)}
      </div>
      {terminalShown && mapped ? (
        // 'starting' holds the mount: the PTY may not exist server-side yet, and
        // the terminal's one-shot attach would be dropped and never retried.
        <DockShellTerminal key={mapped} sessionId={mapped} hub={hub} />
      ) : (
        <div className="p-3 text-xs text-muted-foreground/70">Starting shell…</div>
      )}
    </div>
  )
}

/** The mounted terminal for one dock shell session (keyed by session id, so a
 *  replaced shell remounts cleanly). */
function DockShellTerminal({
  sessionId,
  hub,
}: {
  sessionId: string
  hub: Parameters<typeof useTerminalSession>[0]['hub']
}): JSX.Element {
  const { settings, appearance } = useTerminalAppearance()
  const termBg = settings.background ?? TERMINAL_DEFAULTS.background
  const { containerRef, ready } = useTerminalSession({
    hub,
    sessionId,
    appearance,
    focusWhenReady: true,
    // Human-facing ref links (#474): clickable PREFIX-N tokens in shell output.
    onMounted: (mounted) => {
      mounted.view.setRefLinks({
        isKnownPrefix: (p) => isKnownRefPrefix(p),
        onActivate: (ref, event) => activateRef(ref, event),
      })
    },
  })
  return (
    <div
      className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      style={{ backgroundColor: termBg }}
    >
      <div ref={containerRef} className="term min-h-0 min-w-0 flex-1 overflow-hidden px-2 py-1.5" />
      {!ready && (
        <div
          className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-muted-foreground/70"
          style={{ backgroundColor: termBg }}
          role="status"
          aria-live="polite"
        >
          Connecting…
        </div>
      )}
    </div>
  )
}

import { shallowEqual } from '@podium/client-core/store'
import { resolveIssueReference } from '@podium/client-core/viewmodels'
import type { MachineWire, SessionId, SessionMeta, MachineId } from '@podium/model/browser'
import { useTerminalSession } from '@podium/terminal-client-react'
import { Monitor } from 'lucide-react'
import type { JSX } from 'react'
import { useEffect, useRef } from 'react'
import { useReplicaIssues, useStoreSelector } from '@/app/store'
import { Badge } from '@/components/ui/badge'
import { isKnownRefPrefix } from '@/lib/markdown-references'
import { activateRef } from '@/lib/ref-activation'
import { TERMINAL_DEFAULTS } from './appearance'
import { dockShellIsDead, dockShellIsParked } from './dock-shell-lifecycle'
import { prettyCwd } from './pretty-cwd'
import { HibernatedPane } from './SessionLifecyclePanes'
import { useTerminalAppearance } from './use-terminal-appearance'

/**
 * The right dock's Shell panel (#23) [spec:SP-75b1]: one shell session per
 * worktree, living IN the dock — not in the workspace tab strip (the strip
 * filters ids in `dockShells`). The mapping is SERVER-OWNED (POD-4436,
 * `shells.forWorktree`): the same dock shell opens on every device, and the
 * device-local `dockShells` map is only the instant cache until the server
 * answers, then the server wins. A reload (or closing and reopening the
 * panel) reattaches the same shell with its scrollback; a dead shell is
 * archived and replaced with a fresh one, while a parked (hibernated) shell
 * is resumed in place under the SAME id (POD-4429).
 */
export function DockShellPanel({
  cwd,
  machineId,
}: {
  cwd: string
  machineId?: MachineId
}): JSX.Element {
  const {
    hub,
    trpc,
    sessions,
    machines,
    reposLoaded,
    dockShells,
    setDockShell,
    setDockVisibleSession,
  } = useStoreSelector(
    (s) => ({
      hub: s.hub,
      trpc: s.trpc,
      sessions: s.sessions,
      machines: s.machines,
      reposLoaded: s.reposLoaded,
      dockShells: s.dockShells,
      setDockShell: s.setDockShell,
      setDockVisibleSession: s.setDockVisibleSession,
    }),
    shallowEqual,
  )
  const mapped = dockShells[cwd]
  const session = sessions.find((s) => s.sessionId === mapped)
  const machineLabel = resolveShellMachineLabel(session, machines, machineId)
  // Dead = unrevivable in place. 'starting' and 'reconnecting' are HEALTHY
  // transients — treating them as dead made this effect archive a spawning
  // shell and replace it, looping until the panel closed.
  // Parked (hibernated) is NOT dead (POD-4429): the same session id resumes
  // in place via HibernatedPane, so it is excluded from both `dead` and
  // `alive` and never enters the create effect below.
  const dead = !!session && dockShellIsDead(session)
  const parked = !!session && !!mapped && dockShellIsParked(session)
  const alive = !!session && !dead && !parked

  // The id we created and whose broadcast hasn't landed yet. While set, NEVER
  // create again — the first version of this effect looped on exactly that gap
  // (each spawn re-armed because its session wasn't in the store yet) and
  // stamped out a dozen shells in seconds.
  const pendingId = useRef<string | null>(null)
  if (pendingId.current && sessions.some((s) => s.sessionId === pendingId.current)) {
    pendingId.current = null
  }
  // Create only when we can DISTINGUISH "dead" from "not synced yet":
  //  - no mapping at all → fresh worktree, resolve (after boot data loaded);
  //  - mapped and the session row is present but dead → resolve (the server
  //    archives and replaces under the same worktree key);
  //  - mapped but absent from a NON-EMPTY synced session list → gone, resolve.
  // A mapped id with no session rows at all means the boot sync hasn't landed —
  // render the connecting state and wait, don't resolve a duplicate.
  // A parked shell never resolves (POD-4429): it resumes the same id in place.
  const needsCreate =
    !alive &&
    !parked &&
    reposLoaded &&
    pendingId.current === null &&
    (!mapped || dead || sessions.length > 0)

  const creating = useRef(false)
  useEffect(() => {
    if (!needsCreate || creating.current) return
    creating.current = true
    void (async () => {
      try {
        // SERVER-OWNED mapping (POD-4436): returns-or-creates the dock shell
        // for this worktree, so two devices opening the same worktree attach
        // to the same session id. Creation stays a normal shell spawn; the
        // device-local map is only refreshed from the answer (cache, server
        // wins). A mapped-but-dead shell is archived and replaced server-side.
        const { sessionId } = await trpc.shells.forWorktree.mutate({
          worktreePath: cwd,
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
  }, [needsCreate, cwd, machineId, trpc, setDockShell])

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
      <div className="flex min-w-0 flex-none items-center gap-2 border-b border-border px-3 py-1.5 text-[11px] text-muted-foreground/70">
        <span className="min-w-0 flex-1 truncate" title={cwd}>
          {prettyCwd(cwd)}
        </span>
        {machineLabel && (
          <Badge
            variant="secondary"
            className="min-w-0 max-w-[45%] flex-none gap-1 px-1.5 py-0 font-normal text-muted-foreground"
            aria-label={`Running on ${machineLabel}`}
            title={`Running on ${machineLabel}`}
          >
            <Monitor size={10} className="flex-none" aria-hidden="true" />
            <span className="truncate">{machineLabel}</span>
          </Badge>
        )}
      </div>
      {terminalShown && mapped ? (
        // 'starting' holds the mount: the PTY may not exist server-side yet, and
        // the terminal's one-shot attach would be dropped and never retried.
        <DockShellTerminal key={mapped} sessionId={mapped} hub={hub} session={session} />
      ) : parked && mapped ? (
        // Parked, not dead (POD-4429): the pane offers resume of the SAME
        // session id in place — never archive, never spawn a replacement.
        // A shell has no transcript, so this is the recovery pane (the same
        // HibernatedPane the workspace tabs show for a transcript-less
        // session), not a banner over one.
        <HibernatedPane sessionId={mapped} />
      ) : (
        <div className="p-3 text-xs text-muted-foreground/70">Starting shell…</div>
      )}
    </div>
  )
}

/** Resolve the dock shell's actual server-attributed host first, retaining a
 * useful target indicator while a newly-created session is still arriving. */
export function resolveShellMachineLabel(
  session: Pick<SessionMeta, 'machineId' | 'machineName'> | undefined,
  machines: Pick<MachineWire, 'id' | 'name'>[],
  requestedMachineId?: MachineId,
): string | undefined {
  if (session?.machineName) return session.machineName
  const id = session?.machineId ?? requestedMachineId
  if (!id) return undefined
  return machines.find((machine) => machine.id === id)?.name ?? id
}

/** The mounted terminal for one dock shell session (keyed by session id, so a
 *  replaced shell remounts cleanly). */
function DockShellTerminal({
  sessionId,
  hub,
  session,
}: {
  sessionId: SessionId
  hub: Parameters<typeof useTerminalSession>[0]['hub']
  /** The row this shell's grid comes from (POD-3239 B1). */
  session: SessionMeta | undefined
}): JSX.Element {
  const { settings, appearance } = useTerminalAppearance()
  const termBg = settings.background ?? TERMINAL_DEFAULTS.background
  const issues = useReplicaIssues()
  const issuesRef = useRef(issues)
  issuesRef.current = issues
  const { containerRef, viewportRef, ready, mountedRef } = useTerminalSession({
    hub,
    sessionId,
    appearance,
    focusWhenReady: true,
    // Born at W, exactly as the agent panel is (POD-3239 B1). A dock shell is a
    // terminal like any other; constructing it at 80x24 and moving it is the
    // same wrong first frame.
    ...(session?.geometry ? { initialGeometry: session.geometry } : {}),
    geometryState: session?.geometryState ?? 'unknown',
    // Human-facing ref links (#474 / POD-529): clickable PREFIX-N tokens with
    // live stage-coloured underlines when the issue is known.
    onMounted: (mounted) => {
      mounted.view.setRefLinks({
        isKnownPrefix: (p) => isKnownRefPrefix(p),
        onActivate: (ref, event) => activateRef(ref, event),
        resolveStage: (ref) => resolveIssueReference(ref, issuesRef.current)?.stage ?? null,
      })
    },
  })
  // biome-ignore lint/correctness/useExhaustiveDependencies: mountedRef is a stable ref from useTerminalSession
  useEffect(() => {
    const view = mountedRef.current?.view
    if (!view) return
    view.setRefLinks({
      isKnownPrefix: (p) => isKnownRefPrefix(p),
      onActivate: (ref, event) => activateRef(ref, event),
      resolveStage: (ref) => resolveIssueReference(ref, issuesRef.current)?.stage ?? null,
    })
  }, [issues, mountedRef])
  return (
    <div
      className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      style={{ backgroundColor: termBg }}
    >
      {/* The BOX and the HOST (POD-3239 B3): the outer element clips, carries the
      inset and is what gets measured; xterm sizes the inner one. */}
      <div ref={viewportRef} className="term-viewport min-h-0 min-w-0 flex-1 px-2 py-1.5">
        <div ref={containerRef} className="term" />
      </div>
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

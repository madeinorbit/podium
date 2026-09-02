import { resolveIssueReference } from '@podium/client-core/viewmodels'
import type { IssueId, SessionId } from '@podium/model'
import { parseAnyRef } from '@podium/protocol'
import { MobileTerminalKeyboard, useTerminalSession } from '@podium/terminal-client-react'
import { Mic } from '../components/icons'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Text, View } from 'react-native'
import { useConnected, useHub, useIssues, useSessions, useSpawnPending } from '../client/hooks'
import { Icon } from '../components/Icon'
import { color, font, mono, sans, space } from '../theme/theme'
import { LEGACY_MOBILE_KEYBOARD_THEME, MOBILE_APPEARANCE } from './terminal-appearance'
import {
  type TerminalControlState,
  type TerminalControlView,
  terminalControlCopy,
  terminalControlView,
} from './terminal-control'
import { terminalStatusLine } from './terminal-status'

export interface TerminalPaneProps {
  sessionId: SessionId
  active: boolean
  /**
   * Open the task a `PREFIX-N` token in agent output names (POD-724). Routing
   * belongs to the SCREEN, not to a pane that could be mounted anywhere, so the
   * pane resolves the token against the live projection and hands back an id.
   */
  onOpenIssue?: (issueId: IssueId) => void
  /** Publish who is driving the PTY so the screen header can own the action. */
  onControlState?: (state: TerminalControlState) => void
}

export function TerminalPane({
  sessionId,
  active,
  onOpenIssue,
  onControlState,
}: TerminalPaneProps) {
  const hub = useHub()
  const connected = useConnected()
  const issues = useIssues()
  // The row this pane's grid comes from (POD-3239 B1). Read once at mount by
  // `useTerminalSession`; a later row update never remounts the terminal.
  const session = useSessions().find((s) => s.sessionId === sessionId)
  // Live reads for callbacks the terminal keeps for the lifetime of the mount:
  // the overlay asks for a stage on every repaint, and a closure that captured
  // one render's projection would underline a stage the board has left behind.
  const issuesRef = useRef(issues)
  issuesRef.current = issues
  const onOpenIssueRef = useRef(onOpenIssue)
  onOpenIssueRef.current = onOpenIssue
  const onControlStateRef = useRef(onControlState)
  onControlStateRef.current = onControlState

  /**
   * WHICH `PREFIX-N` TOKENS ARE REAL REFS (POD-724).
   *
   * The desktop answers this from a repo-prefix registry (`setKnownRefPrefixes`,
   * fed by the repo list) so `UTF-8` never becomes a dead link. The phone has no
   * such registry, and standing a second one up would be a second source of
   * truth for the same fact — so the prefixes are derived from the issue
   * projection the replica already holds. That is deliberately the STRICTER
   * answer: the phone marks exactly the prefixes it can actually resolve and
   * open, so an underline here is never an affordance that leads nowhere.
   */
  const knownPrefixes = useMemo(() => {
    const prefixes = new Set<string>()
    for (const issue of issues) {
      const prefix = issue.prefix ?? parseAnyRef(issue.displayRef ?? '')?.prefix
      if (prefix) prefixes.add(prefix)
    }
    return prefixes
  }, [issues])
  const knownPrefixesRef = useRef(knownPrefixes)
  knownPrefixesRef.current = knownPrefixes

  // One stable config object: every field reads through a ref, so re-arming it
  // is only ever a repaint request — it can never resurrect a stale projection.
  const refLinks = useMemo(
    () => ({
      isKnownPrefix: (prefix: string) => knownPrefixesRef.current.has(prefix),
      // A token the phone cannot resolve does NOTHING rather than navigating to
      // a guess: absence here means late, hidden, or removed, and this surface
      // must not render any of those as a destination.
      onActivate: (ref: string) => {
        const issueId = resolveIssueReference(ref, issuesRef.current)?.issueId
        if (issueId) onOpenIssueRef.current?.(issueId)
      },
      resolveStage: (ref: string) => resolveIssueReference(ref, issuesRef.current)?.stage ?? null,
    }),
    [],
  )

  // Who is driving the PTY. Spectator until the server says otherwise — the
  // honest default, since the phone attaches without claiming anything. This is
  // per-MOUNT state and the mount is per session (the route carries the id in
  // its path), so there is no reuse that could carry "in control" across to a
  // PTY this phone has never attached to.
  const [controlView, setControlView] = useState<TerminalControlView>({
    role: 'spectator',
    phase: 'spectating',
    cols: 80,
    rows: 24,
  })
  // HOLD THE MOUNT UNTIL THE SPAWN IS CONFIRMED (POD-1613). The create path
  // lands here with an OPTIMISTIC session: the row is painted, so the screen
  // renders, but the server has not created the session and there is no PTY to
  // bind. `hub.attach` gets exactly one shot — it sends its frame at connection
  // construction and re-sends only across a socket reconnect — so attaching now
  // spends it on a frame the server drops, and nothing ever retries. The ready
  // backstop then hides "Attaching terminal…" over a grid that stays empty
  // forever, which is precisely what the operator saw. Leaving the screen
  // disposed the mount (`hub.detach`) and coming back built a fresh connection
  // whose attach finally landed — the "go to work and back and it's there".
  // Flipping this false→true remounts, so the attach that runs is the one with
  // a live PTY behind it. Same gate the desktop spends as `spawnConfirmed`.
  const spawnPending = useSpawnPending(sessionId)
  const { viewportRef, containerRef, toolbarRef, mountedRef, ready, outputSeen } =
    useTerminalSession({
      hub,
      sessionId,
      enabled: connected && !spawnPending,
      // Match the desktop AgentPanel lifecycle exactly: stay mounted while hidden,
      // flip eligibility on the live session, and focus only after reveal/attach.
      // This is what drives the shared reveal -> fit -> WebGL recovery sequence.
      active,
      focusOnMount: false,
      focusWhenReady: true,
      appearance: MOBILE_APPEARANCE,
      // A phone that is merely looking must not resize a desktop-driven PTY.
      // Keep xterm on the server's one authoritative grid and expose the rest by
      // panning; the first actual keypress still takes control and applies the
      // phone viewport that the terminal client records in the background — as
      // does the header's explicit take-control action, so READING at this
      // screen's size no longer costs a keystroke into someone's agent (POD-724).
      gridMode: 'server-grid',
      // Born at W (POD-3239 B1). A phone crops rather than reflows, so a buffer
      // constructed at 80x24 and then moved is the same wrong first frame here
      // as on the desktop — with a scroll position that jumps as well.
      ...(session?.geometry ? { initialGeometry: session.geometry } : {}),
      geometryState: session?.geometryState ?? 'unknown',
      test: new URLSearchParams(window.location.search).get('e2e') === '1',
      // Ref underlines are configured at mount so the very first replayed frame
      // is already marked — the desktop AgentPanel arms them in the same place.
      onMounted: (mounted) => {
        mounted.view.setRefLinks(refLinks)
      },
      onState: (state) => setControlView(terminalControlView(state)),
    })

  // Re-arm on every projection change, exactly as the desktop effect does: the
  // stage colour is READ live, but nothing schedules a repaint on its own, so a
  // task moving to review would keep its old underline until the next frame.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `issues` is the repaint trigger; refLinks reads it through a ref
  useEffect(() => {
    mountedRef.current?.view.setRefLinks(refLinks)
  }, [issues, refLinks, mountedRef])

  const takeControl = useCallback(() => {
    // THE EXPLICIT TAKEOVER (POD-724). `takeControl` rather than a bare
    // `connection.requestControl()`: the mount carries this phone's measured
    // viewport on the claim, so the server sizes the PTY and transfers control
    // in one mutation.
    mountedRef.current?.takeControl()
  }, [mountedRef])

  useEffect(() => {
    onControlStateRef.current?.({ ...controlView, ready, takeControl })
  }, [controlView, ready, takeControl])

  const controlCopy = terminalControlCopy({ ...controlView, ready, takeControl })
  // Four waits, four sentences, at most one on screen at a time — the decision
  // (and each sentence's reason for existing) lives in ./terminal-status so the
  // native pane's DOM component speaks the identical words.
  const status = terminalStatusLine({ connected, spawnPending, ready, outputSeen })

  return (
    <View style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
      {status !== null ? <Text style={statusStyle}>{status}</Text> : null}
      {/* WHY THE FRAME IS TOO WIDE, AND WHO CAN CHANGE THAT (POD-724). A
          spectator is looking at the DESK's grid, cropped to this screen —
          without a word for it the operator reads a broken layout rather than a
          deliberate one, and the header action reads as a mystery button. The
          line appears with the attach and then only ever changes its TEXT: a
          caption that came and went would resize this flex column, and the one
          moment it would do so is the takeover that is already resizing the PTY. */}
      {connected && !spawnPending && ready ? (
        <Text style={captionStyle}>{controlCopy.caption}</Text>
      ) : null}
      {/* `minHeight: 0` (the desktop AgentPanel's `min-h-0`) lets this flex child
          SHRINK to the viewport. The old `minHeight: 260` floor meant a short
          phone screen could not contain the pane and the agent frame ran off the
          bottom of the screen (POD-338). A spectator intentionally keeps the
          SERVER grid, so overflow is scrollable instead of clipping or reflowing
          that wider canvas into shredded line fragments. */}
      <div
        ref={viewportRef}
        data-terminal-crop-viewport
        style={{
          flex: 1,
          minHeight: 0,
          width: '100%',
          overflow: 'auto',
          overscrollBehavior: 'contain',
          WebkitOverflowScrolling: 'touch',
        }}
      >
        <div
          ref={containerRef}
          style={{ display: 'inline-block', minWidth: '100%', minHeight: '100%' }}
        />
      </div>
      <MobileTerminalKeyboard
        mountedRef={mountedRef}
        toolbarRef={toolbarRef}
        ready={ready}
        voiceIcon={<Icon as={Mic} size={16} color={color.textDim} />}
        theme={LEGACY_MOBILE_KEYBOARD_THEME}
      />
    </View>
  )
}

const statusStyle = {
  ...mono(400),
  color: color.textDim,
  fontSize: font.small,
  padding: 12,
} as const

// Chrome, not terminal output: sans and the micro step, so it reads as the
// app talking about the grid rather than as another line printed into it.
const captionStyle = {
  ...sans(400),
  color: color.textFaint,
  fontSize: font.micro,
  paddingHorizontal: space.md,
  paddingVertical: 6,
} as const

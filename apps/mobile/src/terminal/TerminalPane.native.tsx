import type {
  ConnectionState,
  SessionConnection,
  ViewportStatement,
} from '@podium/client-core/socket-transport'
import type { IssueId, SessionId } from '@podium/model'
import { useCallback, useEffect, useRef } from 'react'
import { type KeyboardEvent, LayoutAnimation, Platform, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useConnected, useHub } from '../client/hooks'
import {
  useSessionContextSession,
  useSessionContextSpawnPending as useSpawnPending,
} from '../client/use-session-context'
import { useKeyboardLift } from '../hooks/useKeyboardHeight'
import { useReduceMotion } from '../hooks/useReduceMotion'
import { appearancePalette } from '../theme/theme'
import TerminalDom from './TerminalDom'
import type { TerminalControlState } from './terminal-control'
import type { TerminalDomControlEvent, TerminalDomHandle } from './terminal-dom-bridge'
import { encodeFrameBytes } from './terminal-dom-bridge'

/**
 * The NATIVE terminal pane: the same session surface as TerminalPane.web.tsx,
 * with xterm rendered inside an Expo DOM component (see TerminalDom.tsx).
 *
 * THIS SIDE OWNS THE TRANSPORT. The webview cannot authenticate its own
 * /client socket (terminal-dom-bridge.ts says exactly why), so the pane
 * attaches through the app's ONE authenticated SocketHub — the same hub every
 * other native surface shares — and streams the session across the DOM bridge:
 * frames/state/reset/attach IN through the imperative handle, input and the
 * one size statement OUT through the async function props.
 *
 * THE ATTACH IS THE WEBVIEW'S TO REQUEST (POD-1613 kept intact). `hub.attach`
 * spends its one attach frame at connection construction, so this side must
 * not attach before there is both a confirmed session AND a renderer for the
 * replay. The DOM component gates its mount on `connected && !spawnPending`
 * (the same gate the web pane uses — both facts are passed down as props) and
 * calls `onAttachTerminal` only when the mount actually attaches, which makes
 * the native attach exactly as late as the web pane's.
 *
 * Prop parity with the web pane is deliberate: the route renders ONE
 * <TerminalPane> and Metro picks the platform file. `onOpenIssue` is accepted
 * but not yet honoured — ref-link underlines need the issue projection inside
 * the webview and are deferred (the web pane documents the POD-724 behavior
 * this will mirror).
 */
export function TerminalPane({
  sessionId,
  active,
  onControlState,
}: {
  sessionId: SessionId
  active: boolean
  onOpenIssue?: (issueId: IssueId) => void
  onControlState?: (state: TerminalControlState) => void
}) {
  const hub = useHub()
  const connected = useConnected()
  const spawnPending = useSpawnPending(sessionId)
  // The row this pane's grid comes from (POD-3239 B1), marshalled to the DOM
  // component as two primitives — see TerminalDomProps.
  const session = useSessionContextSession(sessionId)
  const insets = useSafeAreaInsets()
  const reduceMotion = useReduceMotion()
  const animateKeyboard = useCallback(
    (event: KeyboardEvent) => {
      if (Platform.OS !== 'ios' || !active || reduceMotion || event.duration <= 0) return
      // Match KeyboardAvoidingView's UIKit timing and minimum accepted duration.
      const duration = Math.max(10, event.duration)
      LayoutAnimation.configureNext({
        duration,
        update: { duration, type: LayoutAnimation.Types[event.easing] || 'keyboard' },
      })
    },
    [active, reduceMotion],
  )
  // The console container already reserves the home-indicator area. Only the
  // remaining window overlap belongs here, including a hardware shortcut bar.
  const keyboardInset = Math.max(0, useKeyboardLift(animateKeyboard) - insets.bottom)

  const domRef = useRef<TerminalDomHandle>(null)
  const connRef = useRef<SessionConnection | null>(null)
  const onControlStateRef = useRef(onControlState)
  onControlStateRef.current = onControlState

  /**
   * THE RENDERER LEASE LIVES ON THIS SIDE OF THE BRIDGE. On web, mountSession
   * holds it through `hub.registerRenderedSession`; the bridge hub deliberately
   * has no such method (the lease belongs to the connection that owns the
   * socket). It is NOT cosmetic presence: the server's `viewVisible` gate
   * ignores resize/geometry claims from a connection that has not declared the
   * session rendered — without the lease, the phone's take-control claim is
   * silently dropped (observed live).
   */
  const releaseLeaseRef = useRef<(() => void) | null>(null)
  const activeRef = useRef(active)
  activeRef.current = active
  const syncLease = useCallback(
    (wantsLease: boolean) => {
      if (wantsLease && releaseLeaseRef.current === null) {
        releaseLeaseRef.current = hub.registerRenderedSession(sessionId, {
          mode: 'native',
          focused: true,
        })
      } else if (!wantsLease && releaseLeaseRef.current !== null) {
        releaseLeaseRef.current()
        releaseLeaseRef.current = null
      }
    },
    [hub, sessionId],
  )
  useEffect(() => {
    syncLease(active && connRef.current !== null)
  }, [active, syncLease])

  // ---- DOM → native: the bridge's action props -----------------------------
  // All stable callbacks: a changed function prop identity re-marshals the
  // whole prop bag into the webview, so churn here is bridge traffic.

  const onAttachTerminal = useCallback(async () => {
    if (connRef.current) return
    const conn = hub.attach(sessionId, {
      onFrame: (bytes) => domRef.current?.frame(encodeFrameBytes(bytes)),
      onState: (state: ConnectionState) => domRef.current?.connState(state),
      // Only older servers use this callback; pictures reset through onFrame.
      onReset: () => domRef.current?.reset(),
      onAttached: () => domRef.current?.attached(),
    })
    connRef.current = conn
    // Declare the rendered session BEFORE any fit/control message from the
    // webview lands, mirroring mountSession's own ordering ("acquire before
    // any fit/control message so the server's visibility gate … sees one
    // ordered truth on this socket").
    syncLease(activeRef.current)
    // Seed the webview's state mirror so its first synchronous `state()` reads
    // (role gating, epoch tracking) see the live connection, not the default.
    domRef.current?.connState(conn.state())
  }, [hub, sessionId, syncLease])

  const onDetachTerminal = useCallback(async () => {
    if (!connRef.current) return
    connRef.current = null
    syncLease(false)
    hub.detach(sessionId)
  }, [hub, sessionId, syncLease])

  const onSendInput = useCallback(async (data: string) => {
    connRef.current?.sendInput(data)
  }, [])
  // A statement made before the native connection exists is dropped: the
  // webview's mount states its box again on the attach.
  const onViewportRequest = useCallback(async (request: ViewportStatement) => {
    connRef.current?.sendViewportRequest(request)
  }, [])

  const onControlEvent = useCallback(async (view: TerminalDomControlEvent) => {
    onControlStateRef.current?.({
      ...view,
      // The action crosses back INTO the webview: the mount's takeControl is
      // what carries this phone's measured viewport on the claim (POD-724).
      takeControl: () => domRef.current?.takeControl(),
    })
  }, [])

  // The webview normally detaches through its own unmount cleanup, but a torn
  // down webview (screen pop, content-process kill) cannot run page JS — so the
  // native side is the detach of last resort. `hub.detach` is idempotent.
  useEffect(
    () => () => {
      releaseLeaseRef.current?.()
      releaseLeaseRef.current = null
      if (connRef.current) {
        connRef.current = null
        hub.detach(sessionId)
      }
    },
    [hub, sessionId],
  )

  return (
    <View
      testID="terminal-keyboard-avoider"
      style={[styles.pane, { paddingBottom: keyboardInset }]}
    >
      <TerminalDom
        ref={domRef}
        dom={{
          // The pane is one fixed page, never a scrolling document; the crop
          // viewport inside owns panning. Transparent so `styles.pane` is the
          // ground during webview startup — no white flash.
          scrollEnabled: false,
          automaticallyAdjustContentInsets: false,
          contentInsetAdjustmentBehavior: 'never',
          // Expo's DOM webview forwards this to its WKWebView subclass.
          // The page already provides Submit and the terminal key rows.
          hideKeyboardAccessoryView: true,
          style: styles.webview,
        }}
        sessionId={sessionId}
        active={active}
        connected={connected}
        spawnPending={spawnPending}
        cols={session?.geometry.cols}
        rows={session?.geometry.rows}
        onAttachTerminal={onAttachTerminal}
        onDetachTerminal={onDetachTerminal}
        onSendInput={onSendInput}
        onViewportRequest={onViewportRequest}
        onControlState={onControlEvent}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  pane: {
    flex: 1,
    minHeight: 0,
    overflow: 'hidden',
    // Match the DOM page in either appearance, including webview startup.
    backgroundColor: appearancePalette.dark.bg,
  },
  webview: {
    flex: 1,
    backgroundColor: 'transparent',
  },
})

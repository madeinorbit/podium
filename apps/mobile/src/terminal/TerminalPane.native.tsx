import type { ConnectionState, SessionConnection } from '@podium/client-core/socket-transport'
import type { IssueId, SessionId } from '@podium/model'
import { useCallback, useEffect, useRef } from 'react'
import { KeyboardAvoidingView, Platform, StyleSheet, View } from 'react-native'
import { useConnected, useHub, useSpawnPending } from '../client/hooks'
import { useKeyboardHeight } from '../hooks/useKeyboardHeight'
import { color } from '../theme/theme'
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
 * frames/state/reset/attach IN through the imperative handle, input/resize/
 * control claims OUT through the async function props.
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
  // The keyboard belongs to the webview's focus, but UIKit's notifications are
  // app-wide, so the native side still sees it come up. See ACCESSORY_INSET.
  const keyboardUp = useKeyboardHeight() > 0 && Platform.OS === 'ios'

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
   * silently dropped and the pane sits in "fitting" forever (observed live).
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
  const onSendResize = useCallback(async (cols: number, rows: number) => {
    connRef.current?.sendResize(cols, rows)
  }, [])
  const onReportViewport = useCallback(async (cols: number, rows: number) => {
    connRef.current?.reportViewport(cols, rows)
  }, [])
  const onRequestControl = useCallback(async (geometry: { cols: number; rows: number } | null) => {
    connRef.current?.requestControl(geometry ?? undefined)
  }, [])
  const onRedraw = useCallback(async () => {
    connRef.current?.redraw()
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
    // The soft keyboard belongs to the webview's own focus, so the native side
    // only has to keep the pane above it; inset padding when it shows.
    <KeyboardAvoidingView behavior="padding" style={styles.pane}>
      <View style={[styles.body, keyboardUp ? styles.bodyAboveAccessory : null]}>
        <TerminalDom
          ref={domRef}
          dom={{
            // The pane is one fixed page, never a scrolling document; the crop
            // viewport inside owns panning. Transparent so `styles.pane` is the
            // ground during webview startup — no white flash.
            scrollEnabled: false,
            contentInsetAdjustmentBehavior: 'never',
            style: styles.webview,
          }}
          sessionId={sessionId}
          active={active}
          connected={connected}
          spawnPending={spawnPending}
          onAttachTerminal={onAttachTerminal}
          onDetachTerminal={onDetachTerminal}
          onSendInput={onSendInput}
          onSendResize={onSendResize}
          onReportViewport={onReportViewport}
          onRequestControl={onRequestControl}
          onRedraw={onRedraw}
          onControlState={onControlEvent}
        />
      </View>
    </KeyboardAvoidingView>
  )
}

/**
 * WKWebView's own form accessory — the floating ⌃ ⌄ ✓ capsule iOS puts over the
 * keyboard for the focused xterm input — is a SEPARATE WINDOW. It is not part of
 * the keyboard frame KeyboardAvoidingView compensates for, so it lands on top of
 * the page: the terminal's last rows and the page's Submit/Newline/Paste bar go
 * under it, which are exactly the rows you are typing at (2026-08-28, device).
 * Nothing measures it, so this is its height plus the margin it floats on.
 */
const ACCESSORY_INSET = 56

const styles = StyleSheet.create({
  pane: {
    flex: 1,
    minHeight: 0,
    overflow: 'hidden',
    // The page paints `color.bg` itself; this is the ground behind the webview
    // while it boots, so the reveal is dark-on-dark.
    backgroundColor: color.bg,
  },
  // KeyboardAvoidingView owns its own paddingBottom while the keyboard is up, so
  // the accessory inset has to ride on a child rather than fight it for the prop.
  body: { flex: 1, minHeight: 0 },
  bodyAboveAccessory: { paddingBottom: ACCESSORY_INSET },
  webview: {
    flex: 1,
    backgroundColor: 'transparent',
  },
})

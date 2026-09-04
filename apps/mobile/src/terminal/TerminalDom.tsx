'use dom'

/**
 * THE NATIVE PANE'S TERMINAL PAGE — xterm inside the app's own webview.
 *
 * This is an Expo DOM component: Metro bundles it as a WEB page and the native
 * pane renders it on `@expo/dom-webview` (already autolinked in this binary —
 * the same runtime ArtifactViewer uses for HTML artifacts; NO new native
 * dependency). It runs the real `mountSession` from @podium/terminal-client —
 * the identical xterm mount, server-grid crop and fit policy as the Expo-web
 * pane — over the bridge in ./terminal-dom-bridge, because the webview cannot
 * authenticate its own /client socket (see that module's header). Frames and
 * connection state arrive through the imperative handle; keystrokes, resizes
 * and control claims leave through the async function props.
 */

import type { SessionId } from '@podium/model'
import { MobileTerminalKeyboard, useTerminalSession } from '@podium/terminal-client-react'
// The concrete module, not `expo/dom`: this app's tsconfig resolves module
// suffixes `.web` first, and expo's `dom.web.d.ts` (the web no-op surface)
// does not re-export the prop types.
import type { DOMProps, JSONValue } from 'expo/build/dom/dom.types'
import { useDOMImperativeHandle } from 'expo/dom'
import type { Ref } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { LEGACY_MOBILE_KEYBOARD_THEME, MOBILE_APPEARANCE } from './terminal-appearance'
import {
  type TerminalControlView,
  terminalControlCopy,
  terminalControlView,
} from './terminal-control'
import {
  type BridgeConnectionState,
  createTerminalBridge,
  type TerminalDomActions,
  type TerminalDomControlEvent,
  type TerminalDomHandle,
} from './terminal-dom-bridge'
import { terminalStatusLine } from './terminal-status'

interface TerminalDomProps extends TerminalDomActions {
  sessionId: string
  active: boolean
  connected: boolean
  spawnPending: boolean
  /**
   * The session's last-known grid and what it is worth (POD-3239 B1), marshalled
   * across the DOM bridge from the native side's store. Primitives rather than an
   * object because everything crossing this boundary is serialized, and the pair
   * is read once at mount.
   */
  cols?: number
  rows?: number
  geometryState?: 'current' | 'unknown' | 'absent'
  /** Control-state publication for the screen header (role/phase/grid/ready);
   *  the native wrapper re-binds `takeControl` onto it. */
  onControlState(view: TerminalDomControlEvent): Promise<void>
  ref?: Ref<TerminalDomHandle>
  dom?: DOMProps
}

/** Terminal canvas backdrop — DEFAULT_THEME.background in terminal-client. The
 *  page ground is the app's `color.bg` so the crop gutters read as app chrome,
 *  and it is painted on <html> too so nothing ever flashes white during load. */
const TERMINAL_BG = '#0e0e12'
const PAGE_BG = '#16171a' // theme.ts color.bg
const STATUS_FG = '#a8adb6' // theme.ts color.textDim
const CAPTION_FG = '#848a94' // theme.ts color.textFaint

const PAGE_CSS = `
  html, body, #root { margin: 0; padding: 0; height: 100%; background: ${PAGE_BG}; }
  * { box-sizing: border-box; }
`

export default function TerminalDom({
  sessionId,
  active,
  connected,
  spawnPending,
  cols,
  rows,
  geometryState,
  onAttachTerminal,
  onDetachTerminal,
  onSendInput,
  onSendResize,
  onReportViewport,
  onRequestControl,
  onRedraw,
  onControlState,
  ref,
}: TerminalDomProps) {
  // Latest native actions through one ref, so the bridge (built once per
  // session) never calls a stale proxy after a props re-marshal.
  const actionsRef = useRef<TerminalDomActions>({
    onAttachTerminal,
    onDetachTerminal,
    onSendInput,
    onSendResize,
    onReportViewport,
    onRequestControl,
    onRedraw,
  })
  actionsRef.current = {
    onAttachTerminal,
    onDetachTerminal,
    onSendInput,
    onSendResize,
    onReportViewport,
    onRequestControl,
    onRedraw,
  }
  const onControlStateRef = useRef(onControlState)
  onControlStateRef.current = onControlState

  // Only the session identity rebuilds the bridge — it reads the latest
  // actions through actionsRef, which is stable by construction.
  const bridge = useMemo(
    () => createTerminalBridge(sessionId as SessionId, actionsRef),
    [sessionId],
  )

  const [controlView, setControlView] = useState<TerminalControlView>({
    role: 'spectator',
    phase: 'spectating',
    cols: 80,
    rows: 24,
  })

  // Same lifecycle as the Expo-web pane: hold the mount until the transport is
  // up and the spawn is confirmed (both facts are the NATIVE side's and arrive
  // as props); `active` flips eligibility on the live mount without remounting.
  const { viewportRef, containerRef, toolbarRef, mountedRef, ready, outputSeen } =
    useTerminalSession({
      hub: bridge.hub,
      sessionId: sessionId as SessionId,
      enabled: connected && !spawnPending,
      active,
      focusOnMount: false,
      focusWhenReady: true,
      appearance: MOBILE_APPEARANCE,
      // A phone that is merely looking must not resize a desktop-driven PTY —
      // identical presentation and policy to TerminalPane.web.tsx (POD-3239 B3).
      crop: 'scroll',
      // Born at W, like every other surface (B1).
      ...(cols !== undefined && rows !== undefined ? { initialGeometry: { cols, rows } } : {}),
      geometryState: geometryState ?? 'unknown',
      onState: (state) => setControlView(terminalControlView(state)),
    })

  // The receiving half of the bridge: the native wrapper drives these through
  // the DOM ref proxy. Registered against the live bridge so a session change
  // re-points the handle at the new mount's callbacks.
  // Arguments arrive as JSONValue by the bridge's contract; the narrowing
  // casts restore the shapes the NATIVE side (typed by TerminalDomHandle)
  // actually sends.
  useDOMImperativeHandle(
    ref as Ref<never>,
    () => ({
      frame(b64: JSONValue) {
        bridge.push.frame(b64 as string)
      },
      connState(state: JSONValue) {
        bridge.push.state(state as unknown as BridgeConnectionState)
      },
      reset() {
        bridge.push.reset()
      },
      attached() {
        bridge.push.attached()
      },
      takeControl() {
        mountedRef.current?.takeControl()
      },
    }),
    [bridge, mountedRef],
  )

  useEffect(() => {
    void onControlStateRef.current({ ...controlView, ready })
  }, [controlView, ready])

  const status = terminalStatusLine({ connected, spawnPending, ready, outputSeen })
  const showCaption = connected && !spawnPending && ready
  const caption = terminalControlCopy({ ...controlView, ready, takeControl: () => {} }).caption

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        minHeight: 0,
        overflow: 'hidden',
        background: PAGE_BG,
      }}
    >
      <style>{PAGE_CSS}</style>
      {status !== null ? <div style={statusStyle}>{status}</div> : null}
      {/* Same one-line caption discipline as the web pane: appears with the
          attach, then only ever changes its TEXT (POD-724). */}
      {showCaption ? <div style={captionStyle}>{caption}</div> : null}
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
          background: TERMINAL_BG,
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
        theme={LEGACY_MOBILE_KEYBOARD_THEME}
      />
    </div>
  )
}

const statusStyle = {
  fontFamily: MOBILE_APPEARANCE.fontFamily,
  fontWeight: 400,
  color: STATUS_FG,
  fontSize: 15, // theme.ts font.small
  padding: 12,
} as const

// Chrome, not terminal output: sans and the micro step, so it reads as the app
// talking about the grid rather than as another line printed into it.
const captionStyle = {
  fontFamily: 'ui-sans-serif, system-ui, sans-serif',
  fontWeight: 400,
  color: CAPTION_FG,
  fontSize: 11, // theme.ts font.micro
  padding: '6px 12px', // theme.ts space.md horizontal
} as const

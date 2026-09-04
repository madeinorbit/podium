import type {
  ConnectionState,
  SessionCallbacks,
  SessionConnection,
  SocketHub,
} from '@podium/client-core/socket-transport'
import type { SessionId } from '@podium/model'
import type { TerminalControlView } from './terminal-control'

/**
 * PTY OUTPUT CROSSES THIS SEAM AS BASE64, NOT AS TEXT.
 *
 * The hub delivers PTY output as raw bytes, because a terminal stream is not
 * guaranteed to be text: a multi-byte UTF-8 rune can straddle two frames, and
 * a program is free to emit bytes that decode to nothing at all. Every Expo
 * DOM call is serialized into an `injectJavaScript` evaluation, so the wire
 * here is a JSON string and the bytes need an encoding to survive it. Decoding
 * to text would corrupt exactly the two cases above; base64 is byte-exact, and
 * it is the encoding the hub itself already uses for the same reason on the
 * socket wire (socket-hub.ts).
 */
export function encodeFrameBytes(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

/** Inverse of {@link encodeFrameBytes}, run inside the webview. */
export function decodeFrameBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}

/**
 * THE SEAM BETWEEN THE NATIVE HUB AND THE WEBVIEW TERMINAL.
 *
 * The native pane renders xterm inside an Expo DOM component ('use dom' on
 * `@expo/dom-webview`) — but the webview CANNOT open its own authenticated
 * /client socket: the server's WS upgrade accepts credentials only as a session
 * cookie or an `Authorization` bearer header (apps/server/src/server.ts
 * `principalForClient` → auth-route's `resolveClientCredential`), a browser
 * `WebSocket` can set neither, and `isAllowedWsOrigin` refuses the DOM bundle's
 * `file://` page origin against any non-loopback host. The app's ONE
 * authenticated SocketHub therefore stays on the native side, and this module
 * is the wire between it and the mount running in the page:
 *
 *   native → DOM   PTY frames / connection state / reset / attached, delivered
 *                  through the DOM component's imperative handle
 *                  ({@link TerminalDomHandle}).
 *   DOM → native   input, resize, viewport reports, control claims, delivered
 *                  through async function props ({@link TerminalDomActions}).
 *
 * Inside the webview, {@link createTerminalBridge} impersonates just enough of
 * SocketHub/SessionConnection for `mountSession` to run UNCHANGED — the same
 * xterm mount, server-grid crop and fit policy the Expo-web pane uses. The
 * bridge holds a mirror of the native connection's last published
 * ConnectionState so the mount's synchronous `connection.state()` reads stay
 * answerable; every mutation is forwarded to the real connection, whose own
 * `onState` echo refreshes the mirror.
 */

/** ConnectionState crosses the webview bridge as plain JSON — every field is a
 *  primitive, a plain object, or null (PresenceIdentity is a zod wire shape). */
export type BridgeConnectionState = ConnectionState

/** What the DOM component publishes for the screen header's control action.
 *  `takeControl` cannot cross the bridge as a value, so the native wrapper
 *  re-attaches it as a call back into the webview. */
export interface TerminalDomControlEvent extends TerminalControlView {
  ready: boolean
}

/**
 * The imperative surface the native wrapper drives via the DOM ref proxy.
 * Methods only, arguments JSON-serializable — Expo serializes each call into
 * an `injectJavaScript` evaluation, which comfortably sustains PTY frame rates
 * (tens of small text frames per second).
 */
export interface TerminalDomHandle {
  /** One PTY output frame, base64 of the raw bytes — see {@link encodeFrameBytes}. */
  frame(b64: string): void
  /** The native SessionConnection's latest full state. */
  connState(state: BridgeConnectionState): void
  /** A full replay is incoming — clear before the buffered frames land. */
  reset(): void
  /** The server confirmed the attach (PTY bound, ready for input). */
  attached(): void
  /** The header's explicit takeover — runs the MOUNT's takeControl so this
   *  phone's measured viewport rides on the claim (POD-724). */
  takeControl(): void
}

/** The native side of the bridge: async function props on the DOM component. */
export interface TerminalDomActions {
  /** The webview mount attached — attach the real hub connection now. Deferred
   *  to this moment so the one-shot attach frame is never spent before the
   *  renderer exists to receive the replay (mirrors POD-1613's gate). */
  onAttachTerminal(): Promise<void>
  onDetachTerminal(): Promise<void>
  onSendInput(data: string): Promise<void>
  onSendResize(cols: number, rows: number): Promise<void>
  onReportViewport(cols: number, rows: number): Promise<void>
  onRequestControl(geometry: { cols: number; rows: number } | null): Promise<void>
  onRedraw(): Promise<void>
}

/** The mirror's pre-attach value — the same posture a fresh SessionConnection
 *  reports: disconnected spectator on the default grid, `outputSeen` optimistic
 *  (a mount that has heard nothing must not accuse the PTY of silence). */
export function initialBridgeState(sessionId: SessionId): BridgeConnectionState {
  return {
    connected: false,
    clientId: '',
    controllerId: null,
    controllerIdentity: null,
    outcome: null,
    sessionId,
    role: 'spectator',
    cols: 80,
    rows: 24,
    requestedGeometry: null,
    epoch: 0,
    lastSeq: -1,
    outputSeen: true,
  }
}

export interface TerminalBridge {
  /** Hand to `mountSession` (typed as the real hub; implements exactly the
   *  subset the mount uses: attach/detach — `registerRenderedSession` is
   *  optional there and deliberately absent here). */
  hub: SocketHub
  /** The receiving half the DOM component wires into its imperative handle. */
  push: {
    frame(b64: string): void
    state(next: BridgeConnectionState): void
    reset(): void
    attached(): void
  }
}

/**
 * Build the webview-side bridge for one session. `actions` is a ref-like box so
 * the bridge always calls the LATEST native action props without rebuilding —
 * the mount holds its connection for the lifetime of the webview.
 */
export function createTerminalBridge(
  sessionId: SessionId,
  actions: { readonly current: TerminalDomActions },
): TerminalBridge {
  let cb: SessionCallbacks = {}
  let state = initialBridgeState(sessionId)
  let attached = false

  const connection = {
    sessionId,
    state: () => state,
    sendInput: (data: string) => {
      void actions.current.onSendInput(data)
    },
    sendResize: (cols: number, rows: number) => {
      void actions.current.onSendResize(cols, rows)
    },
    reportViewport: (cols: number, rows: number) => {
      void actions.current.onReportViewport(cols, rows)
    },
    requestControl: (geometry?: { cols: number; rows: number }) => {
      void actions.current.onRequestControl(geometry ?? null)
    },
    redraw: () => {
      void actions.current.onRedraw()
    },
  } as unknown as SessionConnection

  const hub = {
    attach: (_sessionId: SessionId, callbacks: SessionCallbacks = {}) => {
      cb = callbacks
      // Latched: a re-mount that attaches while already attached only swaps the
      // callbacks, exactly as the real hub's attach does for a live connection.
      if (!attached) {
        attached = true
        void actions.current.onAttachTerminal()
      }
      return connection
    },
    detach: () => {
      cb = {}
      if (attached) {
        attached = false
        void actions.current.onDetachTerminal()
      }
    },
  } as unknown as SocketHub

  return {
    hub,
    push: {
      frame: (b64) => cb.onFrame?.(decodeFrameBytes(b64)),
      state: (next) => {
        state = next
        cb.onState?.(next)
      },
      reset: () => cb.onReset?.(),
      attached: () => cb.onAttached?.(),
    },
  }
}

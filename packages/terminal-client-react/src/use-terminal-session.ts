import {
  type ConnectionState,
  type MountedSession,
  mountSession,
  type SocketHub,
} from '@podium/terminal-client'
import type { RefObject } from 'react'
import { useEffect, useRef, useState } from 'react'

export interface UseTerminalSessionOptions {
  /** The hub this session attaches through. Null/undefined → nothing mounts (a
   *  not-yet-connected SocketHub, e.g. while useSocketHub is still connecting). */
  hub: SocketHub | null | undefined
  sessionId: string
  /**
   * Mount gate (default true). Flip false for a state with no live PTY to attach
   * to (hibernated/exited) or before the server has confirmed the session
   * (optimistic spawn, #119) — the terminal is torn down/held back, not just
   * hidden. Flipping it back on re-mounts.
   */
  enabled?: boolean
  /**
   * Foreground/visible eligibility (default true). Only an active terminal on a
   * visible page drives the PTY size and may claim control. Toggling this does
   * NOT remount — it flips {@link MountedSession.setActive} on the live
   * instance, so a chat/native (or tab) toggle never tears down the terminal.
   */
  active?: boolean
  /** Focus the terminal the instant it mounts (mountSession's own default is
   *  true — pass false when a "Starting…" overlay should own focus instead). */
  focusOnMount?: boolean
  /**
   * Focus the terminal once it becomes BOTH active and ready (default false).
   * The web panel prefers this over `focusOnMount` so the soft keyboard doesn't
   * pop over the "Starting…" overlay on a fresh mobile spawn.
   */
  focusWhenReady?: boolean
  /** Expose the browser-test hook (`globalThis.__podium`) — see mountSession. */
  test?: boolean
  readyTimeoutMs?: number
  /** Per-frame callback (mountSession's onFrame) — e.g. sampling the rendered
   *  prompt. Latest identity is used; changing it never remounts. */
  onFrame?: () => void
  onState?: (state: ConnectionState) => void
  /**
   * Fires synchronously right after this mount's `mountSession()` call resolves
   * — the one hook for app-specific per-mount wiring (file-link providers,
   * draft-flush machinery, …) that needs the live {@link MountedSession}. May
   * return a cleanup, run before dispose. Only the identity captured at mount
   * time is used — set state or refs from it, don't rely on later renders.
   */
  // biome-ignore lint/suspicious/noConfusingVoidType: a callback may have no cleanup
  onMounted?: (mounted: MountedSession) => void | (() => void)
}

export interface UseTerminalSessionResult {
  /** Attach to the terminal's container element. */
  containerRef: RefObject<HTMLDivElement | null>
  /** Attach to the optional mobile key-toolbar element. Render it in the same
   *  commit as (or before) the mount effect runs, or not at all. */
  toolbarRef: RefObject<HTMLDivElement | null>
  /** The live MountedSession, null while unmounted. Stable ref identity. */
  mountedRef: RefObject<MountedSession | null>
  /** True once the session is usable (attach confirmed / first frame / backstop). */
  ready: boolean
  /** True while the view is pinned to the live tail — drives "Jump to bottom". */
  atBottom: boolean
}

/**
 * The one React binding over @podium/terminal-client's imperative
 * `mountSession`: owns the mount/unmount lifecycle, keeps the terminal mounted
 * across active/hidden toggles (size/focus eligibility flips on the live
 * instance instead of remounting — see {@link MountedSession.setActive}), and
 * surfaces ready/at-bottom state a panel typically needs for its own chrome
 * (a "Starting…" overlay, a "Jump to bottom" pill).
 */
export function useTerminalSession(opts: UseTerminalSessionOptions): UseTerminalSessionResult {
  const {
    hub,
    sessionId,
    enabled = true,
    active = true,
    focusOnMount,
    focusWhenReady = false,
  } = opts
  const containerRef = useRef<HTMLDivElement | null>(null)
  const toolbarRef = useRef<HTMLDivElement | null>(null)
  const mountedRef = useRef<MountedSession | null>(null)
  const [ready, setReady] = useState(false)
  const [atBottom, setAtBottom] = useState(true)

  // Latest callbacks via refs so identity churn on every render never tears
  // down and re-attaches the terminal (only [hub, sessionId, enabled] do that).
  const onFrameRef = useRef(opts.onFrame)
  onFrameRef.current = opts.onFrame
  const onStateRef = useRef(opts.onState)
  onStateRef.current = opts.onState
  const onMountedRef = useRef(opts.onMounted)
  onMountedRef.current = opts.onMounted
  // Mount-time-only options: read via refs inside the effect so they don't
  // need to sit in its dependency array (they're constants for a given mount).
  const testRef = useRef(opts.test)
  testRef.current = opts.test
  const focusOnMountRef = useRef(focusOnMount)
  focusOnMountRef.current = focusOnMount
  const readyTimeoutMsRef = useRef(opts.readyTimeoutMs)
  readyTimeoutMsRef.current = opts.readyTimeoutMs
  // Initial eligibility for the mount call itself; runtime toggles go through
  // the setActive effect below without remounting.
  const activeRef = useRef(active)
  activeRef.current = active

  useEffect(() => {
    if (!hub || !enabled) return
    const el = containerRef.current
    if (!el) return
    setReady(false)
    setAtBottom(true)
    const mounted = mountSession(el, {
      hub,
      sessionId,
      active: activeRef.current,
      ...(toolbarRef.current ? { toolbarEl: toolbarRef.current } : {}),
      ...(testRef.current ? { test: true } : {}),
      ...(focusOnMountRef.current !== undefined ? { focusOnMount: focusOnMountRef.current } : {}),
      ...(readyTimeoutMsRef.current !== undefined
        ? { readyTimeoutMs: readyTimeoutMsRef.current }
        : {}),
      onReady: () => setReady(true),
      onFrame: () => onFrameRef.current?.(),
      onState: (state) => onStateRef.current?.(state),
    })
    mountedRef.current = mounted
    const offScroll = mounted.view.onScroll(() => setAtBottom(mounted.view.atBottom()))
    const cleanupMounted = onMountedRef.current?.(mounted)
    return () => {
      cleanupMounted?.()
      offScroll()
      mounted.dispose()
      mountedRef.current = null
    }
  }, [hub, sessionId, enabled])

  // Eligibility flips on the live instance — never a remount (warm toggles).
  useEffect(() => {
    mountedRef.current?.setActive(active && enabled)
  }, [active, enabled])

  // Deferred focus: once ready and this is the active surface, hand it the
  // keyboard. Opt-in — see focusWhenReady.
  useEffect(() => {
    if (focusWhenReady && active && enabled && ready) mountedRef.current?.view.focus()
  }, [focusWhenReady, active, enabled, ready])

  return { containerRef, toolbarRef, mountedRef, ready, atBottom }
}

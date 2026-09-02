import type {
  ConnectionState,
  SessionConnection,
  SocketHub,
} from '@podium/client-core/socket-transport'
import { extractCodexPromptDraft } from '@podium/composer'
import type { SessionId } from '@podium/model'
import { DomViewportSource } from './dom-viewport'
import type { Grid } from './session-viewport'
import {
  createTerminalDiagnosticRecorder,
  terminalDiagnosticsSnapshot,
} from './terminal-diagnostics'
import {
  colorSchemeReport,
  DEFAULT_FONT_SIZE,
  DEFAULT_THEME,
  MONO_STACK,
  type TerminalAppearance,
  TerminalView,
} from './terminal-view'
import { mountKeyToolbar } from './toolbar'

export interface MountSessionOptions {
  hub: SocketHub
  sessionId: SessionId
  toolbarEl?: HTMLElement
  test?: boolean
  /** Opt-in input-event→paint diagnostics. Disabled by default. */
  echoLatencyEnabled?: boolean
  onState?: (state: ConnectionState) => void
  /**
   * Fires once, on the first non-empty PTY frame. NOTE: this fires only when output
   * actually lands — it is NOT a reliable readiness signal, because a session that
   * reattaches with an empty replay buffer (e.g. after a server restart) and an idle
   * child blocked on input produces no frame. Use {@link onReady} to gate the
   * "Starting…" overlay; keep this for output-specific work.
   */
  onFirstFrame?: () => void
  /**
   * Fires ONCE the session is ready to use: the moment the server confirms the
   * attach (the PTY is bound), or the first real frame lands, or the
   * {@link readyTimeoutMs} backstop elapses — whichever is first. Unlike
   * onFirstFrame this does NOT wait for output, so a session idling at a prompt
   * (empty replay buffer) is recognised as ready instead of hanging the panel's
   * "Starting…" overlay forever. Prefer this over onFirstFrame for gating it.
   */
  onReady?: () => void
  /**
   * Backstop for {@link onReady}: if neither an attach nor a frame arrives within
   * this many ms, fire onReady anyway so a stalled handshake can never trap the UI
   * in a permanent "Starting…" overlay. Defaults to {@link READY_TIMEOUT_MS}.
   */
  readyTimeoutMs?: number
  /**
   * Fires on every PTY frame written to the view. The panel uses this to sample
   * the rendered prompt region (debounced) and mirror the native input into the
   * shared chat draft. Distinct from onFirstFrame (which fires once).
   */
  onFrame?: () => void
  /**
   * Focus the terminal as soon as it mounts (default true). The panel sets this
   * false so the soft keyboard doesn't pop up over the "Starting…" overlay on a
   * mobile spawn — it focuses itself once the first frame lands instead.
   */
  focusOnMount?: boolean
  /**
   * Whether this panel is the active, foreground tab. Only an active panel on a
   * visible page may drive the PTY size (and claim control). Defaults to true so
   * existing single-panel callers are unaffected. Toggle at runtime via
   * MountedSession.setActive — the panel is NOT remounted on tab switches.
   */
  active?: boolean
  /** Initial rendering appearance (font, line height, theme). Change at runtime
   *  via {@link MountedSession.setAppearance} — never a remount. */
  appearance?: TerminalAppearance
  /** Optional crop viewport around the xterm host. Defaults to the host itself. */
  viewportEl?: HTMLElement
  /**
   * How this client reconciles its container with the PTY's one authoritative
   * grid. `control` (default) keeps the existing latest-active-client policy:
   * revealing the pane takes control and fits the PTY to this container.
   * `server-grid` keeps a spectator at the server grid and lets its container
   * crop/pan; it reports its fitted viewport for a later explicit takeover but
   * does not preempt another device merely because the pane became visible.
   */
  /**
   * HOW THIS VIEWER PRESENTS A BOX THAT IS NOT W (POD-3239 B3 / MODEL rule 2).
   *
   * `clip` (default, desktop): the box hides what does not fit. `scroll`
   * (mobile): the box scrolls over it. Both use the same two-element structure —
   * an outer viewport that IS the box, and an inner host xterm sizes to
   * cols x cell — and in both, a box LARGER than W pads with the terminal
   * background rather than stretching anything.
   *
   * EXPLICIT, never inferred from CSS. It also picks the renderer, and getting
   * that wrong is invisible until someone scrolls: xterm's WebGL canvas does not
   * repaint regions revealed by scrolling an independent overflow ancestor, so
   * `scroll` must be on the DOM renderer.
   *
   * There is no `transform: scale` in either mode. A scaled terminal is a
   * picture of a terminal.
   *
   * It is ALSO the one thing that separates the two claiming policies
   * (`claimsOnReveal` below), which is why it replaced `gridMode` outright
   * rather than sitting beside it. See the note there.
   */
  crop?: 'clip' | 'scroll'
  /**
   * THE SIZE THIS BUFFER IS BORN AT (POD-3239 B1 / MODEL rule 2).
   *
   * The session's last-known grid W, straight from the store. A terminal that
   * knows W constructs at W, so the very first painted frame is already the right
   * shape — no default is ever painted and nothing has to move it afterwards.
   *
   * Omitted only when there is genuinely no last-known grid (an older server that
   * does not send one). xterm's own 80x24 default then stands, and the attach
   * corrects it.
   */
  initialGeometry?: { cols: number; rows: number }
  /**
   * What {@link initialGeometry} is WORTH (MODEL rule 6). `unknown` — the
   * default — RENDERS: inside the system W can only change through the daemon,
   * so last-known is right until the first ask corrects it. `absent` means there
   * is no pty and the caller should not be mounting at all; the panel's own gate
   * owns that decision, and this is here so a mount cannot silently paint a grid
   * for a session that has none.
   */
  geometryState?: 'current' | 'unknown' | 'absent'
}

export interface MountedSession {
  connection: SessionConnection
  view: TerminalView
  /** Send user input, taking control first when a server-grid spectator starts
   *  interacting. The atomic claim makes the first byte land as controller. */
  sendInput(data: string): void
  /**
   * Claim control of the shared PTY WITHOUT typing anything (POD-724).
   *
   * A server-grid spectator (the phone) is deliberately not driving the PTY
   * size, so a wide desktop TUI arrives cropped and has to be panned. The only
   * way to be sized for this screen used to be the implicit takeover inside
   * {@link sendInput} — you had to send a keystroke into someone else's session
   * to be able to READ it. This is that takeover made explicit, and it is on the
   * mount rather than on `connection` because the viewport sample belongs with
   * the fit logic: THIS client's measured grid rides on the control claim, so
   * the server applies both in one mutation instead of trusting whatever the
   * debounced resize observer last sent.
   * Control mode has nothing to withhold, so there it is just the request.
   */
  takeControl(): void
  /** Toggle/reset input-event→paint diagnostics without remounting the PTY. */
  setEchoLatencyEnabled(enabled: boolean): void
  setActive(active: boolean): void
  /** Apply a new appearance to the live terminal and re-fit: a font-metric
   *  change alters the cell size, so the grid (and the PTY, via resize) must
   *  reconcile to the same container. Theme-only changes end up a no-op fit. */
  setAppearance(appearance: TerminalAppearance): void
  dispose(): void
}

/** Default {@link MountSessionOptions.readyTimeoutMs}: reveal the terminal even if the
 *  attach handshake stalls, so the "Starting…" overlay can never hang permanently. */
export const READY_TIMEOUT_MS = 2000

/**
 * Codex can paint a composer before startup work (notably MCP initialization)
 * redraws it. Its safe synthetic-input boundary is stricter than "some output":
 * DECSET 2004 must be enabled and the dim-stripped empty composer must be on
 * screen. The browser harness additionally holds this predicate through a quiet
 * window so a later redraw resets the wait. [spec:SP-e639]
 */
export function codexInputReady(
  view: Pick<TerminalView, 'bracketedPasteMode' | 'screenText'>,
): boolean {
  if (!view.bracketedPasteMode()) return false
  return extractCodexPromptDraft(view.screenText({ dropDim: true }).split('\n')) === ''
}

export function mountSession(el: HTMLElement, opts: MountSessionOptions): MountedSession {
  const { hub, sessionId } = opts
  const crop = opts.crop ?? 'clip'
  const viewportEl = opts.viewportEl ?? el
  const diagnostics = createTerminalDiagnosticRecorder(sessionId)
  // BORN AT W (B1). `absent` is the one state that must not paint a grid — there
  // is no pty behind the row — so it falls back to xterm's own default, which the
  // panel keeps behind its transcript/overlay.
  const birthGeometry = opts.geometryState === 'absent' ? undefined : opts.initialGeometry
  const view = new TerminalView({
    ...(opts.appearance ?? {}),
    ...(birthGeometry ? { cols: birthGeometry.cols, rows: birthGeometry.rows } : {}),
    // xterm's WebGL canvas does not repaint sections revealed by scrolling an
    // independent overflow ancestor, so a scrolling crop must be on the DOM
    // renderer. Keyed off the EXPLICIT presentation mode (B3) rather than off a
    // policy flag that happened to imply it, or off CSS nobody reads back.
    renderer: crop === 'scroll' ? 'dom' : 'auto',
    diagnostics: (event, data) => diagnostics.record(event, data),
  })
  view.mount(el)

  // The background last applied to the view — a later setAppearance compares
  // against it to detect a real colour change (issue recolour, user theme
  // edit) worth reporting to a mode-2031 subscriber.
  let lastBackground = (opts.appearance?.theme ?? DEFAULT_THEME).background

  let active = opts.active ?? true
  /**
   * HAS THE SERVER TOLD US ANYTHING YET? (POD-3239 B2 / MODEL rule 1.)
   *
   * False until `onAttached`. Before that, every `onState` is ignored FOR
   * GEOMETRY — a pre-attach state carries no grid at all now, and the emits that
   * used to carry a fabricated one (`requestControl`, `welcome`) are exactly how
   * a mounted terminal got dragged to 80x24 before the attach had said anything.
   *
   * After it, the attach snapshot is W and the buffer follows the server
   * unconditionally: visible or hidden, controller or spectator.
   */
  let authoritative = false
  let serverGrid: Grid = { cols: view.cols(), rows: view.rows() }
  const pageVisible = (): boolean =>
    typeof document === 'undefined' || document.visibilityState === 'visible'
  const eligible = (): boolean => active && pageVisible()
  const trace = (event: string, data: Record<string, unknown> = {}): void => {
    diagnostics.record(event, {
      active,
      pageVisible: pageVisible(),
      eligible: eligible(),
      authoritative,
      serverGrid: { ...serverGrid },
      crop,
      ...data,
      view: view.diagnosticSnapshot(),
    })
  }
  const sameGrid = (left: Grid, right: Grid): boolean =>
    left.cols === right.cols && left.rows === right.rows

  trace('mount')

  const proposeViewport = (): Grid | undefined =>
    viewportEl === el ? view.proposeFit() : view.proposeFitIn(viewportEl)

  /**
   * THE ONE ASK (POD-3239 B4 / MODEL rules 3 and 4).
   *
   * Every trigger that used to have its own path — reveal, reconnect, a box
   * change, an appearance change, a font arriving — ends here, sends one
   * message, and waits for nothing. There is no ladder because nothing is
   * waiting on this measurement to RENDER: the buffer is already at W and stays
   * there until the server reports otherwise, so a measurement that is not
   * available yet costs nothing. The ResizeObserver on the box fires when the
   * layout the ladder used to poll for actually happens, and asks then.
   *
   * An unmeasurable box still ASKS when the ask is a claim, carrying the current
   * W — because the claim is the point (rule 4) and "I want control, at the size
   * you already have" is exactly the honest request there.
   */
  function ask(reason: string, claimControl: boolean): void {
    if (!eligible()) {
      trace('ask:skipped', { reason, claimControl, cause: 'ineligible' })
      return
    }
    const measured = proposeViewport()
    if (!measured && !claimControl) {
      // Nothing to say and nothing to claim. The observer will ask once the box
      // has a size.
      trace('ask:skipped', { reason, claimControl, cause: 'unmeasurable' })
      return
    }
    if (measured) everMeasured = true
    const geometry = measured ?? { ...serverGrid }
    // A NON-CLAIMING ASK REPEATS NOTHING. A reveal fires the box observer as
    // well (display:none → visible is a resize), so the settling burst that
    // follows would otherwise re-state a box nobody has changed. A CLAIM always
    // sends: the claim is the point, and the size is incidental to it (rule 4).
    if (!claimControl && lastAsked && sameGrid(lastAsked, geometry)) {
      trace('ask:skipped', { reason, geometry, cause: 'unchanged' })
      return
    }
    lastAsked = { ...geometry }
    trace('ask:sent', { reason, geometry, claimControl, measured: measured !== undefined })
    connection.sendViewportRequest({
      geometry,
      // This mount IS the native renderer, and it only asks while eligible —
      // which is what `visible` means. Read by the server FROM THE MESSAGE, so a
      // request that overtakes its own `viewState` is still judged correctly.
      visible: true,
      mode: 'native',
      claimControl,
    })
  }

  /**
   * WHO CLAIMS ON REVEAL (MODEL rule 4 / B5) — today's policy, unchanged.
   *
   * Desktop takes control by being foregrounded (last-foregrounded-wins). A
   * phone is a spectator that states its box and claims only when the operator
   * says so, because a phone glancing at a session must not resize the desk it
   * is watching.
   *
   * READ OFF `crop`, and this is the ONLY place that inference is made. It is
   * the whole of what `gridMode` used to decide, and the flag is gone (B8): a
   * scrolling crop and a spectator claim policy are the same client — the
   * phone — and a fourth combination has no product behind it. If one ever does,
   * it is this line that grows an option, not five call sites that re-derive one.
   */
  const claimsOnReveal = (): boolean => crop !== 'scroll'

  /** The last box this mount stated, so a repeat is not re-sent. Cleared on a
   *  reconnect: a new server has heard nothing from us. */
  let lastAsked: Grid | null = null
  /**
   * Has this mount ever successfully measured its box?
   *
   * The one case the box observer cannot cover: the VIEWPORT has a size, but
   * xterm has not rendered yet, so there is no `.xterm-screen` to derive a cell
   * size from and the measurement fails. No later resize of the box follows —
   * nothing about the box changed — so without this the pane would sit at
   * whatever the server last said until the operator moved something. xterm's
   * first render is the event that makes it measurable, and it is what asks.
   */
  let everMeasured = false

  // FONT READINESS. A web font that has not loaded yet measures at the fallback
  // metrics, so the box reads a grid the terminal will not actually have once
  // the real face arrives — and nothing else would ever re-ask, because no box
  // changed. Bounded at 3 s: a font that never arrives must not leave the pane
  // waiting on it, and the measurement it would have corrected is at worst one
  // ask stale.
  const FONT_READY_TIMEOUT_MS = 3000
  let fontGeneration = 0
  let currentAppearance: TerminalAppearance = opts.appearance ?? {}
  function awaitFontReadiness(): void {
    const generation = ++fontGeneration
    const fonts = (document as unknown as { fonts?: FontFaceSet }).fonts
    if (typeof document === 'undefined' || !fonts || typeof fonts.load !== 'function') return
    const size = currentAppearance.fontSize ?? DEFAULT_FONT_SIZE
    // `fontFamily` is a comma list ending in `monospace`; each face has to be
    // asked for by name, so the list is split rather than passed through whole.
    const families = (currentAppearance.fontFamily ?? MONO_STACK)
      .split(',')
      .map((family: string) => family.trim().replace(/^['"]|['"]$/g, ''))
      .filter((family: string) => family.length > 0 && family !== 'monospace')
    const settle = (source: string): void => {
      if (generation !== fontGeneration) return
      trace('font:ready', { source, families })
      ask('font-ready', false)
    }
    // One generation-guarded listener, so a face that finishes after the bound
    // still triggers the re-measure instead of being lost.
    const onLoadingDone = (): void => {
      fonts.removeEventListener?.('loadingdone', onLoadingDone)
      settle('loadingdone')
    }
    fonts.addEventListener?.('loadingdone', onLoadingDone)
    fontDisposers.push(() => fonts.removeEventListener?.('loadingdone', onLoadingDone))
    void Promise.race([
      Promise.all(
        families.map((family: string) =>
          fonts.load(`${size}px "${family}"`).catch(() => undefined),
        ),
      ),
      new Promise((resolve) => setTimeout(resolve, FONT_READY_TIMEOUT_MS)),
    ]).then(() => settle('load'))
  }
  const fontDisposers: Array<() => void> = []

  /**
   * This pane became the foreground of a visible page — a reveal, or a mount
   * that started active. One ask, and a repaint for the canvas that a hidden
   * pane's `display:none` may have freed.
   */
  function becomeEligible(reason: string): void {
    if (!eligible()) {
      trace('eligible:skipped', { reason })
      return
    }
    trace('eligible:became', { reason })
    view.forceRepaint()
    ask(reason, claimsOnReveal())
  }

  /**
   * A true REVEAL — the panel was hidden with `display:none` (a tab switch) or
   * the page was backgrounded, either of which frees the WebGL canvas's backing
   * store so it comes back blank.
   *
   * There is no sizing to catch up on: the buffer followed the server while it
   * was hidden (rule 2). So a reveal is a repaint plus one ask, and on the
   * desktop that ask carries a claim even when the size has not moved, because
   * the claim is the point (rule 4).
   */
  function reveal(): void {
    if (!eligible()) {
      trace('reveal:skipped')
      return
    }
    trace('reveal:start')
    // The canvas comes back blank whatever the size turns out to be, so recover
    // it FIRST rather than making the repaint conditional on a measurement.
    view.repaintRecover()
    ask('reveal', claimsOnReveal())
  }

  /**
   * Move the buffer to the server's grid, and only ever to the server's grid
   * (MODEL rule 2). The clear + repaint are kept: xterm reflows the old buffer
   * into the new shape, and for an alt-screen TUI that content is garbage until
   * the app's own SIGWINCH repaint arrives, so blank-then-clean beats shredded
   * mid-width fragments.
   */
  function applyServerGrid(state: ConnectionState, source: string): void {
    const { cols, rows } = state
    if (cols === undefined || rows === undefined) return
    serverGrid = { cols, rows }
    if (view.cols() === cols && view.rows() === rows) return
    trace('geometry:applied', { state, source })
    view.resize(cols, rows)
    view.clear()
    // A resize/reflow can leave the GPU canvas showing only the cells that moved
    // or changed (the "caret at top, my text at bottom, rest black" symptom).
    view.forceRepaint()
  }

  let lastEpoch = -1
  // Defense in depth for embedders that deliver onState directly. Production
  // geometry ordering is enforced before emission by
  // SessionConnection.acceptGeometryRevision.
  let lastGeometryRevision: number | undefined
  let geometryTimelineResetPending = false
  let firstFrameSeen = false
  // Tracks whether we've seen an attach before, so onAttached can tell a fresh mount
  // (sizing already driven by the mount/setActive path) from a RECONNECT (where we must
  // re-assert the size — see the onAttached handler).
  let everAttached = false
  let lastTracedState = ''
  let lastRole: ConnectionState['role'] = 'spectator'

  // Ready = "usable, drop the Starting… overlay". Fires on the FIRST of: the server
  // confirming the attach (onAttached), the first real frame, or the timeout backstop
  // — so an idle child with an empty replay buffer is never mistaken for still booting.
  let ready = false
  let readyTimer: ReturnType<typeof setTimeout> | undefined
  const markReady = (source: 'attach' | 'frame' | 'timeout'): void => {
    if (ready) return
    ready = true
    if (readyTimer !== undefined) clearTimeout(readyTimer)
    trace('ready', { source })
    opts.onReady?.()
  }
  readyTimer = setTimeout(() => markReady('timeout'), opts.readyTimeoutMs ?? READY_TIMEOUT_MS)

  const connection = hub.attach(sessionId, {
    onAttached: () => {
      trace('connection:attached', { reconnect: everAttached, connection: connection.state() })
      markReady('attach')
      geometryTimelineResetPending = false
      // THE ATTACH SNAPSHOT IS THE FIRST AUTHORITATIVE W, AND IT IS APPLIED HERE
      // (B2). `attached` sets cols/rows and emits its state BEFORE this callback
      // runs (0b C3), so there is no later event to wait for — a mount that
      // waited would sit at its birth grid until something unrelated moved it.
      authoritative = true
      // A NEW SERVER HAS HEARD NOTHING FROM US, so the dedup memory goes with
      // the old one — otherwise a reconnect's ask would be suppressed as a
      // repeat of something only the previous server was ever told.
      lastAsked = null
      applyServerGrid(connection.state(), 'attach')
      // RECONNECT IS AN ASK (B4). A restarted server rebuilt this session and
      // reset who was driving; the buffer has already followed its attach
      // snapshot above, and this says what box we actually have and re-claims.
      // Skip the FIRST attach — the mount/setActive path has just asked, and a
      // second identical claim would bump the controller epoch for nothing.
      if (everAttached && eligible()) becomeEligible('reconnect')
      everAttached = true
    },
    onFrame: (bytes) => {
      view.write(bytes)
      if (!firstFrameSeen && bytes.length > 0) {
        firstFrameSeen = true
        opts.onFirstFrame?.()
        markReady('frame')
      }
      opts.onFrame?.()
    },
    // A full replay is incoming (fresh mount, or a reconnect whose gap outran the
    // server's buffer): wipe before the buffered frames rebuild the screen. A
    // resuming reconnect does NOT fire this — it keeps the screen and appends only
    // what it missed, so a network blip no longer flashes the whole terminal.
    onReset: () => {
      trace('connection:reset', { connection: connection.state() })
      lastEpoch = connection.state().epoch
      lastGeometryRevision = undefined
      geometryTimelineResetPending = false
      view.clear()
    },
    onGeometryTimelineReset: () => {
      // A restarted server may resume with no frames; reset ordering without
      // clearing the screen. onReset owns the full-replay clear below.
      lastGeometryRevision = undefined
      geometryTimelineResetPending = true
    },
    onState: (state) => {
      const signature = JSON.stringify([
        state.connected,
        state.role,
        state.cols,
        state.rows,
        state.epoch,
        state.controllerId,
        state.geometryRevision ?? null,
        state.requestedGeometry?.cols ?? null,
        state.requestedGeometry?.rows ?? null,
        state.outputSeen,
      ])
      if (signature !== lastTracedState) {
        lastTracedState = signature
        trace('connection:state', { state })
      }
      const geometryRevision = state.geometryRevision
      const staleGeometry =
        geometryRevision !== undefined &&
        lastGeometryRevision !== undefined &&
        geometryRevision < lastGeometryRevision
      if (staleGeometry) {
        trace('connection:stale-geometry-state', {
          state,
          acceptedRevision: lastGeometryRevision,
        })
      } else if (geometryRevision !== undefined) {
        lastGeometryRevision = geometryRevision
      }
      const geometrySuppressed = geometryTimelineResetPending || staleGeometry
      // THE FENCES ARE GONE (POD-3239 B3/B8), and they are gone because their
      // premise is. `assertedControlGrid`, `pendingRequestedGrid` and
      // `holdClaimedGrid` all existed to protect a grid this client had applied
      // OPTIMISTICALLY from its own measurement, against a server state that had
      // not caught up. Nothing applies a local measurement any more (rule 2), so
      // there is never a local grid to hold and never a disagreement to arbitrate:
      // the only ordering question left is "is this state stale?", and the
      // geometry revision above answers it.
      if (authoritative && !geometrySuppressed) applyServerGrid(state, 'state')
      const roleChanged = state.role !== lastRole
      // Update before an atomic claim emits its local pending state; otherwise
      // that nested notification would look like a second role transition and
      // recursively claim again.
      lastRole = state.role
      if (roleChanged && eligible()) {
        // The server made this client the controller (it is the only viewer), or
        // took it away again. Either way its box is worth stating: as a
        // controller it can be sized to, and as a spectator its recorded
        // viewport is what a later sole-renderer promotion needs. Not
        // platform-conditional — it is true of any viewer whose role moved — and
        // the dedup makes it free when the box was already stated.
        ask('role-change', false)
      }
      // Clear only on an in-session epoch bump — a controller takeover repaints the
      // grid for the new owner. The (re)attach clear is owned by onReset above, so a
      // plain reconnect that resumes from our cursor leaves the screen intact.
      if (state.connected) {
        if (lastEpoch === -1) lastEpoch = state.epoch
        else if (state.epoch !== lastEpoch) {
          trace('connection:epoch-clear', { from: lastEpoch, to: state.epoch })
          lastEpoch = state.epoch
          view.clear()
        }
      }
      el.dataset.role = state.role
      el.dataset.epoch = String(state.epoch)
      // A role transition may synchronously create a pending geometry claim.
      // Publish the connection's latest state so UI never overwrites “fitting”
      // with the stale pre-claim controller snapshot from this callback.
      opts.onState?.(connection.state())
    },
  })
  connection.setEchoLatencyEnabled?.(opts.echoLatencyEnabled ?? false)

  // A renderer lease is the per-CONNECTION answer to “who has this terminal on
  // screen?”. It complements person-level multiplayer presence: the same user
  // may have a desktop and phone, and both must count independently for sizing.
  // Acquire before any fit/control message so the server's visibility gate and
  // sole-renderer policy see one ordered truth on this socket.
  let releaseRendererLease: (() => void) | null = null
  const syncRendererLease = (): void => {
    // Optional guard keeps older embedders/test doubles source-compatible
    // during the additive client-core rollout.
    if (typeof hub.registerRenderedSession !== 'function') return
    if (eligible() && releaseRendererLease === null) {
      releaseRendererLease = hub.registerRenderedSession(sessionId, {
        mode: 'native',
        focused: true,
      })
    } else if (!eligible() && releaseRendererLease !== null) {
      releaseRendererLease()
      releaseRendererLease = null
    }
  }

  // An output frame is not yet a visible echo: xterm parses asynchronously and
  // the browser still has to paint its canvas/DOM. Wait for xterm's render event,
  // then cross the next animation frame before closing the sample. When the
  // probe is off this listener does one boolean check per render and schedules
  // nothing.
  let echoPaintRaf: number | undefined
  const offEchoRender =
    typeof view.onRender === 'function'
      ? view.onRender(() => {
          // FIRST RENDER = FIRST MEASURABLE (B4). See `everMeasured`.
          if (!everMeasured) ask('first-render', false)
          if (!connection.echoPaintPending?.() || echoPaintRaf !== undefined) return
          echoPaintRaf = requestAnimationFrame(() => {
            echoPaintRaf = undefined
            connection.markEchoPaint?.()
          })
        })
      : () => {}

  // Becoming the active tab of a visible page claims control (last-foregrounded-wins)
  // and states this client's box. We never ask while ineligible, so a hidden tab
  // cannot pin the shared PTY to its stale grid.
  syncRendererLease()
  if (active) becomeEligible('mount')
  // A web font that has not loaded yet measures at fallback metrics, so ask
  // again when the real faces arrive (B4).
  awaitFontReadiness()

  // The takeover itself, shared by the implicit path (first keystroke) and the
  // explicit one a client can offer as an action (POD-724). Whichever triggers
  // it, the server-grid spectator carries its OWN viewport on the control claim,
  // so the server applies ownership and size atomically. The resize observer is
  // debounced, so the grid is sampled synchronously HERE — a takeover that
  // immediately follows a rotation or a keyboard change must not pin the shared
  // PTY to the previous size. The role transition in onState then fits/repaints.
  function takeControl(): void {
    ask('take-control', true)
  }

  // Paste + arrows now live in the panel's React action row / D-pad above the key
  // bar, so the bar itself no longer renders a Paste key.
  const sendInput = (data: string, inputEventAt?: number): void => {
    // THE REVEAL MOUSE FENCE IS GONE (POD-3239 B8). It withheld SGR motion
    // reports through a reveal because the buffer might still be at a grid the
    // pty had left, so a mouse coordinate would name the wrong cell. Under rule
    // 2 the buffer is ALWAYS at W — it followed the server while it was hidden —
    // so the precondition it waited for now holds by construction, and holding
    // input on it would only ever be a delay.
    //
    // A spectator that starts typing means it, on any platform: take control
    // first so the first byte lands as controller, on this client's own grid.
    if (connection.state().role === 'spectator') takeControl()
    connection.sendInput(data, inputEventAt)
  }

  const toolbar = opts.toolbarEl ? mountKeyToolbar(opts.toolbarEl, { sendInput }) : null

  // Route keyboard input through the toolbar so an armed modifier (e.g. Ctrl)
  // transforms the next character the soft keyboard sends.
  const offInput = view.onData((data, inputEventAt) =>
    sendInput(toolbar ? toolbar.applyModifiers(data) : data, inputEventAt),
  )

  // Container-size changes (ResizeObserver + visualViewport) re-fit the grid. This
  // is the backstop that catches EVERY layout path — pane drags, dock toggles, and
  // the display:none → visible transition (ResizeObserver fires on it) — not just
  // window resizes. Debounced: a layout transition emits a burst of intermediate
  // sizes, and fitting each one would sendResize → SIGWINCH-flash the TUI per step.
  const VIEWPORT_FIT_DEBOUNCE_MS = 60
  let viewportFitTimer: ReturnType<typeof setTimeout> | undefined
  const viewport = new DomViewportSource(viewportEl)
  const offViewport = viewport.onChange((size) => {
    trace('viewport:changed', { viewport: size })
    if (viewportFitTimer !== undefined) clearTimeout(viewportFitTimer)
    viewportFitTimer = setTimeout(() => {
      viewportFitTimer = undefined
      // A BOX CHANGE NEVER CLAIMS (B4). The window got wider, or a dock opened;
      // that is a reason to ask for a different size, never a reason to take a
      // session away from whoever is driving it.
      ask('box-change', false)
    }, VIEWPORT_FIT_DEBOUNCE_MS)
  })

  const onPageResume = (source: 'visibility-change' | 'focus' | 'pageshow'): void => {
    trace(`page:${source}`)
    syncRendererLease()
    if (eligible()) reveal() // page returning to the foreground is a reveal (canvas was freed)
  }
  const onVisibility = (): void => onPageResume('visibility-change')
  const onWindowFocus = (): void => onPageResume('focus')
  const onPageShow = (): void => onPageResume('pageshow')
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibility)
  }
  if (typeof window !== 'undefined') {
    // Some Chromium/PWA paths restore focus without delivering a useful
    // visibility transition to the app. These events are cheap, and reveal's
    // generation guard coalesces duplicate callbacks from one tab return.
    window.addEventListener('focus', onWindowFocus)
    window.addEventListener('pageshow', onPageShow)
  }

  if (opts.focusOnMount !== false) view.focus()

  let testApi: unknown
  if (opts.test) {
    const api = {
      state: () => connection.state(),
      echoLatency: () => connection.echoLatency(),
      diagnostics: () => terminalDiagnosticsSnapshot(sessionId),
      // Client switch-latency traces [POD-701]. Read through the introspection
      // global the collector registers (client-core), so the terminal package
      // never imports it — an empty list before the collector module loads.
      switchTraces: () =>
        (
          globalThis as { __podiumSwitchTraces?: { recent(): unknown[] } }
        ).__podiumSwitchTraces?.recent() ?? [],
      screenHash: (screenOpts?: { dropDim?: boolean }) => view.screenHash(screenOpts),
      screenText: () => view.screenText(),
      codexInputReady: () => codexInputReady(view),
      sendInput,
      setEchoLatencyEnabled: (enabled: boolean) => connection.setEchoLatencyEnabled?.(enabled),
      // The same takeover the product's own action performs — one name, one
      // meaning, so a browser test cannot pass against a path nothing ships.
      takeControl,
      sessions: () => hub.sessions(),
      attach: (id: SessionId) => hub.attach(id),
      simulateKeyboard: (inset: number) => {
        // Percentage heights don't resolve when the parent has auto height, so we
        // compute the explicit pixel value from the element's current rendered height.
        // This ensures FitAddon sees a genuinely smaller container and recomputes rows.
        // With flex:1 layouts, flex-grow overrides a plain height. We set flex:none +
        // explicit height so the element actually renders at the smaller size.
        // FitAddon reads getComputedStyle(el).height, so the reflow must complete first.
        // We ensure the inset is at least 50% of the container so that row reduction
        // is reliable across different viewport sizes (e.g. fullscreen vs 70vh).
        if (inset > 0) {
          const currentH = viewportEl.getBoundingClientRect().height
          const effectiveInset = Math.max(inset, Math.ceil(currentH * 0.5))
          const newH = `${Math.max(1, currentH - effectiveInset)}px`
          viewportEl.style.flex = 'none'
          viewportEl.style.height = newH
          // Force a synchronous reflow so FitAddon reads the updated height
          void viewportEl.offsetHeight
        } else {
          viewportEl.style.flex = ''
          viewportEl.style.height = ''
          void viewportEl.offsetHeight
        }
        // The same one ask the product sends, so a browser test cannot pass
        // against a path nothing ships (POD-3239 B4).
        ask('simulate-keyboard', false)
      },
    }
    testApi = api
    ;(globalThis as unknown as { __podium?: unknown }).__podium = api
  }

  return {
    connection,
    view,
    sendInput,
    takeControl,
    setEchoLatencyEnabled(enabled: boolean): void {
      connection.setEchoLatencyEnabled?.(enabled)
    },
    setActive(next: boolean): void {
      if (next === active) return
      active = next
      trace('panel:active-change', { next })
      syncRendererLease()
      // Becoming active = a reveal: the panel was display:none (its WebGL canvas freed),
      // so recover the renderer after layout, not just refresh immediately.
      if (active) {
        // The E2E API follows the pane a real click activated, even though warm
        // hidden panes remain mounted and retain their own terminal views.
        if (testApi) (globalThis as unknown as { __podium?: unknown }).__podium = testApi
        reveal()
      }
      // going inactive: do nothing — never resize a hidden panel
    },
    setAppearance(appearance: TerminalAppearance): void {
      // Colour-scheme report (contour mode 2031): when the running app
      // subscribed and the background genuinely changed, tell it so it can
      // re-query OSC 11 and repaint (Claude Code's `theme: auto`). The report
      // is PTY input, so it obeys the controller-only input rule — a
      // spectator's local appearance never speaks for the session.
      const nextBackground = (appearance.theme ?? DEFAULT_THEME).background
      if (
        nextBackground !== lastBackground &&
        view.colorSchemeNotifyEnabled() &&
        connection.state().role === 'controller'
      ) {
        connection.sendInput(colorSchemeReport(nextBackground))
      }
      lastBackground = nextBackground
      view.setAppearance(appearance)
      currentAppearance = appearance
      trace('appearance:change')
      // A font-metric change altered the cell size, so the same box now holds a
      // different grid — ask (B4). A theme-only change measures the same and the
      // server finds the request equal to W, which costs nothing.
      ask('appearance', false)
      // …and the new family may not be loaded yet, so re-arm the readiness
      // probe. Its generation guard retires the previous one.
      awaitFontReadiness()
    },
    dispose() {
      trace('dispose')
      if (readyTimer !== undefined) clearTimeout(readyTimer)
      if (viewportFitTimer !== undefined) clearTimeout(viewportFitTimer)
      releaseRendererLease?.()
      releaseRendererLease = null
      fontGeneration += 1
      while (fontDisposers.length) fontDisposers.pop()?.()
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility)
      }
      if (typeof window !== 'undefined') {
        window.removeEventListener('focus', onWindowFocus)
        window.removeEventListener('pageshow', onPageShow)
      }
      offInput()
      offEchoRender()
      if (echoPaintRaf !== undefined) cancelAnimationFrame(echoPaintRaf)
      offViewport()
      toolbar?.dispose()
      viewport.dispose()
      hub.detach(sessionId)
      view.dispose()
    },
  }
}

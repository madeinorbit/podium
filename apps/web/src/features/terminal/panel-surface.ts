/**
 * THE AGENT PANEL'S ARBITRATION, AS A STATE MACHINE (POD-408).
 *
 * `AgentPanel` used to decide what it shows by RENDER ORDER: a nested ternary
 * (`inTransit ? … : hibernated ? … : exited ? … : …`) with the same four booleans
 * re-spelled at eight other call sites — the mount gate, the `active` gate, the
 * mode segment, Take control, the offer dock, the dock's resize effect. The
 * states were real; only the ternary knew their names, and nothing could name a
 * TRANSITION between them at all. This file is that machine with its states
 * written down.
 *
 * Everything here is pure: no JSX, no DOM, no store, no React. `use-panel-surface`
 * binds it; `AgentPanel` renders one `switch` over the result.
 *
 * WHY THIS IS NOT A POD-330 SLICE, in either direction.
 *
 * NOT PUBLISHED: `panelSurface` has exactly ONE consumer (`AgentPanel`) and no
 * plausible second — `apps/mobile` renders no equivalent panel, and the arbitration
 * takes per-PANE arguments (`paneActive`, `spawnConfirmed`) that no store snapshot
 * carries. Publishing a slice for one reader is the god object behind a nicer
 * hook, which is the call POD-409 already made for the automation composer. It
 * lives beside the only feature that renders it.
 *
 * NOT RE-DERIVED: what the shared modules already answer comes from them —
 * `effectivePanelMode` (client-core `ui-state`, also read by the engine's
 * viewState reporter through `st.panelMode`) decides chat-vs-native, and
 * `sessionMenuEligibility` (2 existing consumers) decides whether hibernate
 * applies. Neither rule is restated here.
 *
 * VIEWSTATE IS THE VISIBILITY FOUNDATION. `paneActive` is the same flag
 * `PanelDeck` uses to `display:none` a warm-but-hidden panel and the same one
 * the engine's `reportViewState` derives `visible` from. Every PTY-SIZE
 * operation therefore hangs off `ptySizingAllowed`, which requires it: a hidden
 * panel measures `getBoundingClientRect().height === 0`, and a `fit()` +
 * `sendResize()` from that measurement re-grids a live PTY to a box nobody is
 * looking at.
 */

import type { PanelMode } from '@podium/client-core/ui-state'
import type { TerminalOutlook } from '@podium/client-core/viewmodels'
import type { SessionMeta, SessionStatus } from '@podium/model/browser'

/** The two live views. Identical to the persisted `PanelMode` — a live panel's
 *  view IS the panel mode; the read-only surfaces have no mode. */
export type PanelView = PanelMode

/** What a session with no process shows: its transcript (chat-capable) or the
 *  recovery pane (a shell, which has none). */
export type ReadOnlyView = 'transcript' | 'recovery'

/**
 * The panel's arbitrated surface — four states, one of them with a view axis.
 *
 * | state     | when                                    | shows |
 * |-----------|-----------------------------------------|-------|
 * | `transit` | the session is moving to another machine | the handover veil, over the pane's own colour |
 * | `parked`  | hibernated (process stopped, resumable)  | transcript + wake banner, or the recovery pane |
 * | `ended`   | exited (process gone)                    | transcript + exit banner, or the recovery pane |
 * | `live`    | everything else, including a pending spawn | chat overlay and/or the terminal |
 *
 * Precedence is the ternary's, unchanged: transit wins over parked wins over
 * ended. It is written as a switch rather than nesting because the ORDER is the
 * rule — a move stops the process, so a moving session is also briefly a parked
 * one, and the veil must win or the operator watches the pane fall through every
 * read-only state on the way.
 */
export type PanelSurface =
  | { readonly kind: 'transit' }
  | { readonly kind: 'parked'; readonly view: ReadOnlyView }
  | { readonly kind: 'ended'; readonly view: ReadOnlyView }
  | { readonly kind: 'pending' }
  | { readonly kind: 'live'; readonly view: PanelView }

export function panelSurface(input: {
  /** The session's wire status; `undefined` when no row has arrived yet. */
  readonly status: SessionStatus | undefined
  /** The handover veil owns the pane ([spec:SP-3f7a]). */
  readonly inTransit: boolean
  /** A structured transcript exists, so a read-only state can show it. */
  readonly chatCapable: boolean
  /** The persisted/derived chat-vs-native pick — only consulted when live. */
  readonly mode: PanelMode
  /**
   * Whether this session will have a terminal — `unknown` until the daemon has
   * said (POD-2290). Only ever consulted for a session that is still starting.
   */
  readonly terminal: TerminalOutlook
}): PanelSurface {
  if (input.inTransit) return { kind: 'transit' }
  const view: ReadOnlyView = input.chatCapable ? 'transcript' : 'recovery'
  if (input.status === 'hibernated') return { kind: 'parked', view }
  if (input.status === 'exited') return { kind: 'ended', view }
  /**
   * NOTHING IS COMMITTED WHILE THE SESSION IS STILL COMING UP AND NOBODY HAS
   * SAID WHICH VIEW IT HAS (POD-2290, round two).
   *
   * This state exists because of what the first round got wrong. It read an
   * absent driver family as "assume a terminal", which is the right reading for
   * a legacy row and the WRONG one for a session that has not started yet — and
   * a measured `opencode` spawn spends twelve seconds there. The operator got
   * the dead pane for twelve seconds and then watched the panel change under
   * them when the fact landed, switcher and all.
   *
   * The honest answer during that window is not a guess in either direction: it
   * is that the panel does not know yet, and it says so with one placeholder
   * and no controls it might have to take away.
   *
   * SCOPED TO `starting` DELIBERATELY. A LIVE session with no family is not
   * waiting for anything — it is a legacy row, an older daemon, or a daemon
   * that has not reconnected since a server restart — and every one of those
   * has a terminal. Those fall through to `live` and behave exactly as they did
   * before this state existed.
   */
  if (input.terminal === 'unknown' && (input.status === undefined || input.status === 'starting')) {
    return { kind: 'pending' }
  }
  // No row yet (optimistic spawn, first paint) reads as LIVE, exactly as the
  // ternary's fall-through did: the "Starting…" overlay covers the wait and
  // `spawnConfirmed` — not this function — holds the PTY mount back.
  return { kind: 'live', view: input.mode }
}

/**
 * Everything the panel used to re-spell from `!hibernated && !exited && …`.
 *
 * Each gate is one sentence, and each is derived from the surface rather than
 * from the booleans behind it, so a fifth state cannot be added without every
 * gate being asked about it.
 */
export interface PanelGates {
  /** The PTY may attach or remain attached. AgentPanel combines this with its
   *  one-way runtime request, so an initial chat surface stays renderer-free
   *  while a terminal loaded earlier remains warm. */
  readonly terminalMounted: boolean
  /**
   * The native pane's DOM exists at all — the terminal container, its startup
   * overlay and the prompt chrome.
   *
   * SEPARATE FROM `terminalMounted` because the two answer different questions
   * (POD-2290). The container is deliberately kept in the DOM while chat is on
   * top (`display:none`), which is what makes the chat↔native toggle warm; and
   * it is deliberately rendered BEFORE the PTY may attach, because the startup
   * overlay inside it is what covers the wait for an optimistic spawn. So
   * "mounted" cannot gate it in either direction. What it must not survive is a
   * session that has no terminal to keep warm and no attach to wait for: there
   * the overlay is a spinner over a wait that will never end.
   */
  readonly nativePaneRendered: boolean
  /** The native view is showing, but there is no terminal behind it — the
   *  explicit "this agent has no terminal" state, never a spinner. */
  readonly noTerminalPaneShown: boolean
  /** The PTY is the surface the operator is looking at — drives focus
   *  eligibility (`useTerminalSession`'s `active`) and nothing else. */
  readonly terminalActive: boolean
  /** A `fit()` + `sendResize()` may run. Requires a VISIBLE pane: a hidden one
   *  measures zero and would re-grid the PTY to a box nobody can see. */
  readonly ptySizingAllowed: boolean
  /** The chat/native segmented control is offered. */
  readonly modeSwitchOffered: boolean
  /** "Take control" is offered in the overflow menu. */
  readonly takeControlOffered: boolean
  /** The native offer dock may render beneath the PTY. */
  readonly offerDockOffered: boolean
}

export function panelGates(
  surface: PanelSurface,
  input: {
    /** This pane is the visible one — PanelDeck's `visible`, the engine's
     *  viewState `visible`, and the panel's `active` prop are all this flag. */
    readonly paneActive: boolean
    /** The server has reconciled the optimistically-spawned session (#119). */
    readonly spawnConfirmed: boolean
    readonly chatCapable: boolean
    /** There is an engine or harness-client terminal behind the native view —
     *  `sessionHasTerminal`, false for embedded drivers (POD-2290). */
    readonly terminalCapable: boolean
    /**
     * The switcher has ALREADY been offered for this session at least once
     * (POD-2290 round two, the operator's "the native and chat button
     * vanished?!").
     *
     * A control that disappears under the cursor is not a state change the user
     * can read as anything but a fault, so once this panel has offered the
     * switch it keeps offering it — even if the driver family later says the
     * terminal is gone, which a re-spawn onto a different driver can genuinely
     * do. What that costs is a switch to a pane with no PTY, and
     * `nativePaneRendered` is deliberately NOT made sticky with it: the pane
     * that opens says it has no terminal instead of spinning.
     */
    readonly switchAlreadyOffered: boolean
    /** Login repair is only actionable in the native terminal. */
    readonly loginRequired?: boolean
  },
): PanelGates {
  const live = surface.kind === 'live'
  const native = live && surface.view === 'native'
  const active = native && input.paneActive
  return {
    /**
     * `terminalCapable` GATES THE MOUNT AS WELL AS THE SWITCH, and not merely
     * for symmetry (POD-2290). Mounting issues a `hub.attach` for a session no
     * daemon will ever bind a PTY to: the request is answered by nobody, `ready`
     * stays false forever, and that unresolvable wait IS the "Starting
     * <Harness>…" spinner the operator was stuck behind. The mode derivation
     * already keeps such a session on chat, so this gate is unreachable through
     * it — which is exactly why it is stated here rather than assumed. A gate
     * that holds only because another module happens to agree is not a gate.
     */
    terminalMounted: live && input.spawnConfirmed && input.terminalCapable,
    nativePaneRendered: live && input.terminalCapable,
    // The sticky switcher's landing place. Reachable only when a session that
    // once had a terminal stopped having one, which is the one case the sticky
    // rule above deliberately keeps open — and the pane it opens states that
    // rather than animating over it.
    noTerminalPaneShown: native && !input.terminalCapable,
    terminalActive: active,
    ptySizingAllowed: active,
    // Two views, or no switch — and then never taken back. The segmented
    // control is a choice between chat and a terminal, so it is not offered
    // where the terminal cannot exist; but a session that HAS offered it keeps
    // it, because withdrawing a control mid-session is a worse lie than an
    // occasionally useless one.
    modeSwitchOffered:
      live &&
      input.chatCapable &&
      !input.loginRequired &&
      (input.terminalCapable || input.switchAlreadyOffered),
    takeControlOffered: native,
    offerDockOffered: native,
  }
}

/** Chat exists where a structured transcript does. Prefer the server's observed
 *  signal (lights up any future transcript provider with no edit here); fall
 *  back to the known transcript harnesses so chat is offered immediately, before
 *  the first transcript frame arrives. */
export function panelChatCapable(
  session: SessionMeta | undefined,
  defaultForKind: (kind: SessionMeta['agentKind']) => boolean,
): boolean {
  if (!session) return false
  return session.transcriptAvailable ?? defaultForKind(session.agentKind)
}

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
import type { SessionMeta, SessionStatus } from '@podium/model'

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
}): PanelSurface {
  if (input.inTransit) return { kind: 'transit' }
  const view: ReadOnlyView = input.chatCapable ? 'transcript' : 'recovery'
  if (input.status === 'hibernated') return { kind: 'parked', view }
  if (input.status === 'exited') return { kind: 'ended', view }
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
  /** The PTY may attach. True for a warm, HIDDEN panel too — that is the point
   *  of the warm set: switching back catches up instead of re-attaching. */
  readonly terminalMounted: boolean
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
  },
): PanelGates {
  const live = surface.kind === 'live'
  const native = live && surface.view === 'native'
  const active = native && input.paneActive
  return {
    terminalMounted: live && input.spawnConfirmed,
    terminalActive: active,
    ptySizingAllowed: active,
    modeSwitchOffered: live && input.chatCapable,
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

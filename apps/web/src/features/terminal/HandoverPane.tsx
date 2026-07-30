import type { SessionMeta } from '@podium/protocol'
import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

/** Enough cells to overflow any pane width; the wire clips and masks its ends,
 *  so the count only has to be generous, never measured. */
const WIRE_CELLS = 348
/** The rail the carets travel on. */
const WIRE_BASE = '─'.repeat(WIRE_CELLS)
/** 12-cell period, matching podium-wire's 12ch travel — sparse enough that the
 *  carets read as things moving down the rail, not as a dotted line. The gap is
 *  no-break spaces: HTML collapses ordinary runs of spaces and the pattern would
 *  come out three cells wide. */
const WIRE_FLOW = `▸${' '.repeat(11)}`.repeat(WIRE_CELLS / 12)

/** How long the arrival state holds over the (already remounting) terminal —
 *  long enough to READ "resumed on <machine>" after a move that took tens of
 *  seconds, short enough that it never feels like a wait of its own. */
export const HANDOVER_ARRIVED_HOLD_MS = 1600
/** Length of the dissolve — matches `.handover-veil`'s transition in motion.css. */
const HANDOVER_FADE_MS = 340

/** m:ss — mono tabular digits, so the seconds column never shifts width. */
export function formatHandoverElapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export type HandoverView = {
  /** Machine the session is leaving (its machine at the moment the move began). */
  from: string | undefined
  /** Machine it is moving to. */
  to: string
  phase: 'transit' | 'arrived'
}

/**
 * The move as the panel needs to render it ([spec:SP-3f7a]).
 *
 * `handoffTarget` is the server's in-flight overlay: present for the whole move,
 * gone the moment the session is either resumed on the target or rolled back to
 * its source. Which of the two happened is readable without another wire field —
 * the machine the session ended up on — so a failed move dissolves the veil at
 * once (its error toast does the explaining) and only a real arrival earns the
 * arrival beat.
 */
export function useHandoverView(session: SessionMeta | undefined): HandoverView | null {
  const target = session?.handoffTarget
  const [view, setView] = useState<HandoverView | null>(null)
  // Read through refs: the effect must fire on the TRANSITIONS of handoffTarget
  // only, and sample the machine name at that instant (both change in the same
  // broadcast when the move ends).
  const machineRef = useRef<string | undefined>(undefined)
  machineRef.current = session?.machineName
  const inFlightRef = useRef<string | undefined>(undefined)
  const sourceRef = useRef<string | undefined>(undefined)

  useEffect(() => {
    if (target) {
      // Entering the move: the session still sits on its source machine here.
      if (!inFlightRef.current) sourceRef.current = machineRef.current
      inFlightRef.current = target
      setView({ from: sourceRef.current, to: target, phase: 'transit' })
      return
    }
    const finished = inFlightRef.current
    inFlightRef.current = undefined
    // Nothing was in flight for this panel (the common case: mounted after, or
    // never during, a move) — and a rolled-back move never reaches the target.
    if (!finished) return
    if (machineRef.current !== finished) {
      setView(null)
      return
    }
    setView({ from: sourceRef.current, to: finished, phase: 'arrived' })
    const hold = setTimeout(() => setView(null), HANDOVER_ARRIVED_HOLD_MS)
    return () => clearTimeout(hold)
  }, [target])

  return view
}

/**
 * A session moving to another machine takes over its own pane.
 *
 * The move stops the agent, ships its worktree and conversation, and resumes it
 * elsewhere — so the panel underneath would otherwise fall through every
 * read-only state on the way (parked transcript, cold terminal) and flicker the
 * operator through views they didn't ask for. This covers that whole window with
 * one statement: where the agent is going, that it is on its way, and that it
 * comes back by itself. Motion is the transit wire alone — character cells
 * marching source → target in the reserved working blue (motion.css), the same
 * "the machine is busy" voice as the braille spinner.
 *
 * Rendered as an overlay so the terminal can already be reattaching behind the
 * arrival beat, which dissolves into it.
 */
export function HandoverPane({
  view,
  background,
}: {
  view: HandoverView
  /** The terminal's own surface colour, so the dissolve reveals no seam. */
  background: string
}): JSX.Element {
  const arrived = view.phase === 'arrived'
  const [seconds, setSeconds] = useState(0)
  const [out, setOut] = useState(false)

  useEffect(() => {
    if (arrived) return
    const tick = setInterval(() => setSeconds((s) => s + 1), 1000)
    return () => clearInterval(tick)
  }, [arrived])

  // The arrival beat holds, then the veil dissolves into the live terminal.
  useEffect(() => {
    if (!arrived) return
    const fade = setTimeout(() => setOut(true), HANDOVER_ARRIVED_HOLD_MS - HANDOVER_FADE_MS)
    return () => clearTimeout(fade)
  }, [arrived])

  return (
    <div
      data-testid="handover-pane"
      role="status"
      aria-live="polite"
      // Below the 40px session header (which keeps identifying the session), over
      // everything else in the pane.
      className={cn(
        'handover-veil absolute inset-x-0 bottom-0 top-[40px] z-30 flex flex-col items-center justify-center text-center',
        out && 'handover-veil-out',
      )}
      style={{ backgroundColor: background, boxShadow: 'inset 0 3px 6px -3px rgb(0 0 0 / 0.85)' }}
    >
      <p className="m-0 px-6 text-[19px] font-semibold leading-[1.2] tracking-[-0.015em] text-balance text-(--handover-ink)">
        {arrived ? `Resumed on ${view.to}` : `Handing over to ${view.to}`}
      </p>
      <p className="m-0 mt-[9px] max-w-[52ch] px-6 text-[11.5px] leading-[1.55] text-balance text-(--handover-muted)">
        {arrived
          ? 'Its terminal is reattaching — the conversation carries on.'
          : 'The agent is parked while its worktree and conversation move across. It comes back by itself.'}
      </p>
      {/* The route, spanning the pane: the two stations sit at the far ends and
          the stream crosses everything between them. Carved with hairlines
          rather than lifted — nothing here is a card. */}
      <div
        className={cn(
          'mt-[30px] flex w-full items-center gap-[16px] border-y issue-hairline-28 issue-hairline-slate-22 px-[22px] py-[15px] font-mono text-[11px] leading-none',
          arrived && 'handover-wire-done',
        )}
        style={{ backgroundColor: 'color-mix(in srgb, var(--issue) 6%, transparent)' }}
      >
        <span
          className="min-w-0 max-w-[38%] truncate text-(--handover-dim)"
          title={view.from ?? 'this machine'}
        >
          {view.from ?? 'this machine'}
        </span>
        <span className="handover-wire" aria-hidden="true">
          <span className="handover-wire-base">{WIRE_BASE}</span>
          <span className="handover-wire-flow">{WIRE_FLOW}</span>
        </span>
        <span
          className={cn(
            'flex min-w-0 max-w-[46%] items-center gap-[7px]',
            arrived ? 'text-(--handover-ink)' : 'text-(--handover-bright)',
          )}
          title={view.to}
        >
          {arrived && (
            <span className="morph-tick-in flex-none text-live" aria-hidden="true">
              ✓
            </span>
          )}
          <span className="truncate">{view.to}</span>
        </span>
      </div>
      {/* The wire is the progress signal; this is the only honest number to put
          beside it — how long the move has been on screen. */}
      <span className="mt-[19px] flex items-baseline gap-[8px]">
        <span className="label-mono text-(--handover-label)">Elapsed</span>
        <span className="mono-timer text-[10px] text-(--handover-dim)">
          {formatHandoverElapsed(seconds)}
        </span>
      </span>
    </div>
  )
}

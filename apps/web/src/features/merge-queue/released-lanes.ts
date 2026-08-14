import { useEffect, useState } from 'react'
import { lockGroupKind, type QueueGroupKind, type QueuePanelState } from './merge-queue-model'

/**
 * A lane the client watched disappear.
 *
 * Nothing on the server records this: `lock.status` answers with what is held
 * RIGHT NOW, and a released lease leaves no row behind. The panel's whole
 * legibility problem (POD-1076) is that an operator only ever meets a lane that
 * is already gone, so a lane they know exists reads as a lane the panel refuses
 * to list. Remembering what vanished, from readings the client actually took,
 * turns the mechanic into something you can watch happen — arrive, run, fade.
 *
 * It invents no state: every entry is a name that WAS in a reading and is not
 * in the current one, and it decays on its own.
 */
export interface ReleasedLane {
  name: string
  kind: QueueGroupKind
  /** Epoch ms of the first reading that no longer carried this lane. */
  releasedAt: number
}

export interface LaneHistory {
  /** Lane names in the last reading, sorted, so comparison is order-free. */
  held: readonly string[]
  /** Newest first. */
  released: readonly ReleasedLane[]
}

export const EMPTY_LANE_HISTORY: LaneHistory = { held: [], released: [] }

/**
 * How long a released lane stays visible. Long enough to cover stepping away
 * from the desk and coming back, short enough that the tail is history rather
 * than a second, staler list of lanes competing with the live ones.
 */
export const RELEASED_LANE_TTL_MS = 30 * 60 * 1000

function sameNames(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((name, index) => name === b[index])
}

/**
 * Fold one reading into the history: what left is stamped, what came back stops
 * being history, and what aged out is dropped.
 *
 * Returns the SAME object when nothing moved, because this runs on every poll
 * and a fresh object each time would re-render the panel once a second.
 */
export function advanceLaneHistory(
  history: LaneHistory,
  heldNow: readonly string[],
  at: number,
): LaneHistory {
  const held = [...heldNow].sort()
  const heldSet = new Set(held)
  const cutoff = at - RELEASED_LANE_TTL_MS

  // A lane that is held again is live, not history — it re-enters the band
  // above rather than lingering in two places at once.
  const kept = history.released.filter(
    (lane) => !heldSet.has(lane.name) && lane.releasedAt > cutoff,
  )
  const gone = history.held.filter((name) => !heldSet.has(name))
  const released =
    gone.length === 0
      ? kept
      : [
          ...gone.map(
            (name): ReleasedLane => ({ name, kind: lockGroupKind(name), releasedAt: at }),
          ),
          ...kept,
        ]

  const unchanged =
    sameNames(history.held, held) &&
    released.length === history.released.length &&
    released.every((lane, index) => lane === history.released[index])

  return unchanged ? history : { held, released }
}

/**
 * `null` while no reading has landed, so nothing is diffed against nothing.
 *
 * A space is an unambiguous separator here: `LOCK_NAME_PATTERN` admits no
 * whitespace, so no name can be split in two by the round trip.
 */
function heldKeyOf(state: QueuePanelState): string | null {
  if (state.status !== 'ready') return null
  return state.locks
    .map((lock) => lock.name)
    .sort()
    .join(' ')
}

/**
 * The released tail for the live panel. Held apart from the view so the view
 * stays a pure function of its props and the memory has one owner.
 */
export function useReleasedLanes(state: QueuePanelState): readonly ReleasedLane[] {
  const [history, setHistory] = useState<LaneHistory>(EMPTY_LANE_HISTORY)
  const heldKey = heldKeyOf(state)

  useEffect(() => {
    if (heldKey === null) return
    const names = heldKey === '' ? [] : heldKey.split(' ')
    setHistory((previous) => advanceLaneHistory(previous, names, Date.now()))
  }, [heldKey])

  // Ageing out is the only thing that happens without a reading, so it needs a
  // clock of its own — otherwise a quiet repository keeps a two-hour-old tail.
  const hasTail = history.released.length > 0
  useEffect(() => {
    if (!hasTail) return
    const timer = window.setInterval(() => {
      setHistory((previous) => advanceLaneHistory(previous, previous.held, Date.now()))
    }, 60_000)
    return () => window.clearInterval(timer)
  }, [hasTail])

  return history.released
}

/** Past tense and coarse: this is history, not a clock that has to be exact. */
export function formatReleasedAgo(millis: number): string {
  const minutes = Math.floor(Math.max(0, millis) / 60_000)
  if (minutes < 1) return 'just now'
  return `${minutes}m ago`
}

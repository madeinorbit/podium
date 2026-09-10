/**
 * ONE OWNER OF THE APPLIED SIZE, AND ONE OPERATION THAT APPLIES IT — the
 * module's own contract (POD-3290, amended by POD-3809).
 *
 * Five properties, and each one is what stops a particular lie:
 *
 *   1. Only `apply()` produces an `AppliedGeometry`. If an object literal ever
 *      typechecks as one again, a site can invent a size and hand it to the
 *      builder — which is exactly how `{ cols: 120, rows: 40 }` reached four
 *      binds. Pinned with `@ts-expect-error`, so a weakened brand FAILS
 *      TYPECHECK rather than quietly passing this suite.
 *   2. `bindFrame` and `geometryAppliedFrame` read the record and take no
 *      geometry, so absence in the record is absence on the wire.
 *   3. Nothing outside this module writes either frame. That is a grep over the
 *      daemon's real sources, not a claim about them.
 *   4. AN APPLY REPORTS (POD-3809). The write and the report are one call, in
 *      the order flush → dispatch → record → report, and a dispatch that could
 *      not put the session at the size records and reports nothing.
 *   5. AND THERE IS NO SECOND WAY IN. `structural` below walks the class's own
 *      surface: any method that can leave a size in the record must have put
 *      one on the wire. A future `applyQuietly()` fails here rather than
 *      shipping the silence this issue was.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { asSessionId } from '@podium/model'
import type { DaemonMessage } from '@podium/protocol/daemon'
import { describe, expect, it } from 'vitest'
import {
  type AppliedGeometry,
  AppliedGeometryRecord,
  appliedGeometryFor,
  bindFrame,
  geometryAppliedFrame,
} from './applied-geometry'

const SESSION = asSessionId('s-applied')
const OTHER = asSessionId('s-other')

/** A record wired to a spy, plus the two things an apply is allowed to do to
 *  the world: the frames it sent and the sessions it flushed, in one timeline
 *  so their ORDER is assertable and not merely their occurrence. */
function recording(): {
  record: AppliedGeometryRecord
  sent: DaemonMessage[]
  timeline: string[]
} {
  const sent: DaemonMessage[] = []
  const timeline: string[] = []
  const record = new AppliedGeometryRecord({
    send: (msg) => {
      sent.push(msg)
      timeline.push(
        msg.type === 'geometryApplied'
          ? `report:${msg.geometry.cols}x${msg.geometry.rows}`
          : `send:${msg.type}`,
      )
    },
    flush: (sessionId) => timeline.push(`flush:${sessionId}`),
  })
  return { record, sent, timeline }
}

const FACTS = {
  sessionId: SESSION,
  cmd: 'abduco -a podium-s-applied',
  cwd: '/w',
  agentKind: 'claude-code',
} as const

describe('only an apply site can produce an applied geometry', () => {
  it('refuses an object literal at COMPILE time', () => {
    // @ts-expect-error an unbranded literal is not a size this daemon applied
    const forged: AppliedGeometry = { cols: 120, rows: 40 }
    // The assertion that matters is the line above: if the brand is ever
    // weakened, `@ts-expect-error` becomes unused and typecheck goes red.
    expect(forged).toEqual({ cols: 120, rows: 40 })
  })

  it('hands back the value it recorded, so an apply site needs no second lookup', () => {
    const { record } = recording()
    const applied = record.apply(SESSION, 132, 43)
    expect(applied).toEqual({ cols: 132, rows: 43 })
    expect(record.applied(SESSION)).toEqual({ cols: 132, rows: 43 })
  })

  it('keeps sessions apart and forgets one without touching the other', () => {
    const { record } = recording()
    record.apply(SESSION, 100, 30)
    record.apply(OTHER, 80, 24)
    record.forget(SESSION)
    expect(record.applied(SESSION)).toBeUndefined()
    expect(record.applied(OTHER)).toEqual({ cols: 80, rows: 24 })
  })

  it('is per daemon: one record per host, and two hosts never share one', () => {
    const a = { appliedGeometry: undefined, send: () => {} }
    const b = { appliedGeometry: undefined, send: () => {} }
    expect(appliedGeometryFor(a)).toBe(appliedGeometryFor(a))
    expect(appliedGeometryFor(a)).not.toBe(appliedGeometryFor(b))
    appliedGeometryFor(a).apply(SESSION, 100, 30)
    // A restarted daemon reattaching a surviving master gets a fresh record and
    // therefore a bare bind — the stale-belief bug, closed by construction.
    expect(appliedGeometryFor(b).applied(SESSION)).toBeUndefined()
  })
})

describe('the frames read the record and take no geometry of their own', () => {
  it('binds BARE when nothing was applied', () => {
    const bind = bindFrame(recording().record, FACTS)
    // ABSENT, not present-and-empty: the server reads absence as "W is unknown
    // to me", and `geometry: undefined` would be a different statement.
    expect(bind).not.toHaveProperty('geometry')
    expect(bind).toMatchObject({ type: 'bind', sessionId: SESSION, cmd: FACTS.cmd })
  })

  it('binds with the applied grid once there is one — the ARMED half', () => {
    const { record } = recording()
    record.apply(SESSION, 120, 40)
    expect(bindFrame(record, FACTS)).toMatchObject({ geometry: { cols: 120, rows: 40 } })
  })

  it('binds bare for a host with no record at all', () => {
    expect(bindFrame(undefined, FACTS)).not.toHaveProperty('geometry')
  })

  it('reports the applied grid, and reports NOTHING when none was applied', () => {
    const { record } = recording()
    expect(geometryAppliedFrame(record, SESSION)).toBeUndefined()
    record.apply(SESSION, 90, 28)
    expect(geometryAppliedFrame(record, SESSION)).toEqual({
      type: 'geometryApplied',
      sessionId: SESSION,
      geometry: { cols: 90, rows: 28 },
      cause: 'request',
    })
  })

  it('states the LAST size applied, not the first', () => {
    const { record } = recording()
    record.apply(SESSION, 80, 24)
    record.apply(SESSION, 200, 60)
    expect(bindFrame(record, FACTS)).toMatchObject({ geometry: { cols: 200, rows: 60 } })
  })
})

/**
 * APPLYING IS REPORTING (POD-3809, stage 7).
 *
 * Stage 5 made a fabricated size unwritable. It did not make a REAL size
 * announceable-by-construction, and three of the daemon's apply sites said
 * nothing — including both of the two a headed driver session goes through. So
 * the write and the report are one call now, and these are its terms.
 */
describe('an apply is a report: one call, one order, no way to write in silence', () => {
  it('flushes, dispatches, records and reports — in that order', () => {
    const { record, timeline } = recording()
    const dispatched: Array<[number, number]> = []

    record.apply(SESSION, 120, 40, (cols, rows) => {
      // Stamped from INSIDE the dispatch, so the position of `dispatch:` in the
      // timeline is where the resize really went out — not where we said it did.
      timeline.push('dispatch:120x40')
      dispatched.push([cols, rows])
      return true
    })

    // The flush is FIRST because the bytes it releases were produced at the old
    // grid: a resize that reached the pty before them could have queued new-grid
    // output behind old-grid output on a viewer that has not been told yet.
    expect(timeline).toEqual([`flush:${SESSION}`, 'dispatch:120x40', 'report:120x40'])
    expect(dispatched).toEqual([[120, 40]])
  })

  it('reports a birth too — no dispatch means the terminal was CREATED at the size', () => {
    const { record, sent, timeline } = recording()

    // A client terminal opened at 100x30, or a pty spawned at it. There is
    // nothing left to send the session, and that is exactly the case that used
    // to report nothing at all.
    expect(record.apply(SESSION, 100, 30)).toEqual({ cols: 100, rows: 30 })

    expect(timeline).toEqual([`flush:${SESSION}`, 'report:100x30'])
    expect(sent).toEqual([
      {
        type: 'geometryApplied',
        sessionId: SESSION,
        geometry: { cols: 100, rows: 30 },
        cause: 'request',
      },
    ])
  })

  it('records and reports NOTHING when the dispatch could not apply it', () => {
    const { record, sent } = recording()

    // What `clientTerminals.resize` answers for a session with no terminal yet:
    // the request is still a request, so there is no applied grid to state.
    expect(record.apply(SESSION, 200, 60, () => false)).toBeUndefined()

    expect(record.applied(SESSION)).toBeUndefined()
    expect(sent).toEqual([])
    // ARMED: the same call with a dispatch that SUCCEEDS both records and reports,
    // so the emptiness above is the refusal and not a dead code path.
    expect(record.apply(SESSION, 200, 60, () => true)).toEqual({ cols: 200, rows: 60 })
    expect(sent).toHaveLength(1)
  })

  it('reports once per apply, at the size applied', () => {
    const { record, sent } = recording()
    record.apply(SESSION, 80, 24)
    record.apply(SESSION, 132, 43)
    record.apply(OTHER, 90, 28)
    expect(
      sent.map((m) =>
        m.type === 'geometryApplied'
          ? `${m.sessionId}:${m.geometry.cols}x${m.geometry.rows}`
          : m.type,
      ),
    ).toEqual([`${SESSION}:80x24`, `${SESSION}:132x43`, `${OTHER}:90x28`])
  })

  it('applies with no flush port at all — a partial host still reports', () => {
    // A fixture, or a host assembled before its scheduler. Losing the ordering
    // guarantee is not a reason to lose the report as well.
    const sent: DaemonMessage[] = []
    const record = new AppliedGeometryRecord({ send: (msg) => sent.push(msg) })
    record.apply(SESSION, 111, 33)
    expect(sent).toHaveLength(1)
  })
})

/**
 * THE STRUCTURAL GATE — the one that has to survive the NEXT person.
 *
 * The bug this issue fixed was not a wrong line; it was a missing one, three
 * times over, because "apply here, and remember to report" is an instruction
 * and instructions are forgotten. The counts can only stop drifting if there is
 * one count, so what is asserted here is that the class offers no SECOND way to
 * put a size into the record.
 *
 * It walks the class's own surface rather than naming `apply`, which is the
 * whole point: a future `applyQuietly(sessionId, cols, rows)` — the exact shape
 * of the mistake — is discovered by this test without anyone editing it.
 */
describe('structural: every way to write a size into the record also puts it on the wire', () => {
  const methods = Object.getOwnPropertyNames(AppliedGeometryRecord.prototype).filter(
    (name) => name !== 'constructor',
  )

  it('finds the class surface, so the gate below cannot pass vacuously', () => {
    // If this ever reads zero the loop below would assert nothing at all.
    expect(methods).toContain('apply')
    expect(methods.length).toBeGreaterThanOrEqual(3)
  })

  it.each(methods)('%s: leaves a size behind only if it sent one', (name) => {
    const sent: DaemonMessage[] = []
    const record = new AppliedGeometryRecord({ send: (msg) => sent.push(msg) })
    const call = (
      record as unknown as Record<string, ((...args: unknown[]) => unknown) | undefined>
    )[name]
    if (!call) return
    try {
      // The apply shape. A method that takes something else either throws or
      // writes nothing, and either way it is not a way to record a size.
      call.call(record, SESSION, 120, 40)
    } catch {
      return
    }
    if (record.applied(SESSION) === undefined) return
    expect(
      sent,
      `${name}() left an applied size in the record without reporting it — that is the silent apply POD-3809 removed`,
    ).not.toEqual([])
  })

  it('is ARMED: a record whose send goes nowhere is not constructible without one', () => {
    // @ts-expect-error a record with nowhere to report to is the silent apply
    const silent = new AppliedGeometryRecord()
    expect(silent).toBeInstanceOf(AppliedGeometryRecord)
  })
})

/**
 * THE GREP GATE. Two frames carry a daemon's claim about a grid, and this walks
 * the daemon's real sources to prove that only this module builds either one.
 * A future site that writes `type: 'bind'` by hand — with or without a
 * geometry — is what this catches, because that is the shape the four hardcoded
 * `120x40` announcements had.
 */
describe('no other daemon source builds a bind or a geometryApplied frame', () => {
  const root = join(import.meta.dirname, '..')

  function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) return sources(path)
      if (!entry.name.endsWith('.ts') || entry.name.includes('.test.')) return []
      return [path]
    })
  }

  it.each(["type: 'bind'", "type: 'geometryApplied'"])('%s appears in one file only', (literal) => {
    const writers = sources(root)
      .filter((path) => readFileSync(path, 'utf8').includes(literal))
      .map((path) => path.slice(root.length + 1))
    expect(writers).toEqual(['control/applied-geometry.ts'])
  })

  it('finds real files to check, so the gate above cannot pass vacuously', () => {
    expect(sources(root).length).toBeGreaterThan(50)
  })
})

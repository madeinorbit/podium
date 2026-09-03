/**
 * ONE OWNER OF THE APPLIED SIZE — the module's own contract (POD-3290).
 *
 * Three properties, and each one is what stops a particular lie:
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
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { asSessionId } from '@podium/model'
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
    const record = new AppliedGeometryRecord()
    const applied = record.apply(SESSION, 132, 43)
    expect(applied).toEqual({ cols: 132, rows: 43 })
    expect(record.applied(SESSION)).toEqual({ cols: 132, rows: 43 })
  })

  it('keeps sessions apart and forgets one without touching the other', () => {
    const record = new AppliedGeometryRecord()
    record.apply(SESSION, 100, 30)
    record.apply(OTHER, 80, 24)
    record.forget(SESSION)
    expect(record.applied(SESSION)).toBeUndefined()
    expect(record.applied(OTHER)).toEqual({ cols: 80, rows: 24 })
  })

  it('is per daemon: one record per host, and two hosts never share one', () => {
    const a = { appliedGeometry: undefined } as { appliedGeometry?: AppliedGeometryRecord }
    const b = { appliedGeometry: undefined } as { appliedGeometry?: AppliedGeometryRecord }
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
    const bind = bindFrame(new AppliedGeometryRecord(), FACTS)
    // ABSENT, not present-and-empty: the server reads absence as "W is unknown
    // to me", and `geometry: undefined` would be a different statement.
    expect(bind).not.toHaveProperty('geometry')
    expect(bind).toMatchObject({ type: 'bind', sessionId: SESSION, cmd: FACTS.cmd })
  })

  it('binds with the applied grid once there is one — the ARMED half', () => {
    const record = new AppliedGeometryRecord()
    record.apply(SESSION, 120, 40)
    expect(bindFrame(record, FACTS)).toMatchObject({ geometry: { cols: 120, rows: 40 } })
  })

  it('binds bare for a host with no record at all', () => {
    expect(bindFrame(undefined, FACTS)).not.toHaveProperty('geometry')
  })

  it('reports the applied grid, and reports NOTHING when none was applied', () => {
    const record = new AppliedGeometryRecord()
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
    const record = new AppliedGeometryRecord()
    record.apply(SESSION, 80, 24)
    record.apply(SESSION, 200, 60)
    expect(bindFrame(record, FACTS)).toMatchObject({ geometry: { cols: 200, rows: 60 } })
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

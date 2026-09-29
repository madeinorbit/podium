/**
 * THE SIZE EVENT'S REPORT AND THE TWO FRAMES THAT CARRY A SIZE — the module's
 * own contract (POD-4723, design rev 3; replaces POD-3290's applied-size
 * record).
 *
 * Three properties, and each one is what stops a particular lie:
 *
 *   1. The frames state exactly the size they are handed, and a bind with no
 *      size is bare — "attached; I cannot state a size".
 *   2. A report FLUSHES FIRST: held output was drawn at the old grid, and the
 *      report is a control frame that could overtake it.
 *   3. Only the size event reports. `reportSize` has one caller,
 *      `onSessionSize`, which only the host's WELCOME/RESIZED reach — so no
 *      ask, dispatch or bind site can ever report a size the kernel did not
 *      state. That is a grep over the daemon's real sources, not a claim.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { asSessionId } from '@podium/model'
import type { DaemonMessage } from '@podium/protocol/daemon'
import { describe, expect, it } from 'vitest'
import { bindFrame, geometryAppliedFrame, reportSize } from './applied-geometry'

const SESSION = asSessionId('s-applied')

const FACTS = {
  sessionId: SESSION,
  cmd: 'podium-host attach podium-s-applied',
  cwd: '/w',
  agentKind: 'claude-code',
} as const

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    if (!entry.name.endsWith('.ts') || entry.name.includes('.test.')) return []
    return [path]
  })
}

describe('the frames state the size they are handed, and nothing else', () => {
  it('binds BARE when there is no size', () => {
    const frame = bindFrame(undefined, FACTS)
    expect(frame).toMatchObject({ type: 'bind', sessionId: SESSION })
    expect('geometry' in frame).toBe(false)
  })

  it('binds with the connection size when there is one', () => {
    expect(bindFrame({ cols: 122, rows: 39 }, FACTS).geometry).toEqual({ cols: 122, rows: 39 })
  })

  it('reports exactly the size handed to it', () => {
    expect(geometryAppliedFrame(SESSION, { cols: 90, rows: 30 })).toEqual({
      type: 'geometryApplied',
      sessionId: SESSION,
      geometry: { cols: 90, rows: 30 },
      cause: 'request',
    })
  })
})

describe('a report flushes first', () => {
  it('flushes the held output, then reports — in that order', () => {
    const timeline: string[] = []
    reportSize(
      {
        send: (msg: DaemonMessage) =>
          timeline.push(msg.type === 'geometryApplied' ? `report:${msg.geometry.cols}x${msg.geometry.rows}` : msg.type),
        outputScheduler: { flushNow: (id) => timeline.push(`flush:${id}`) },
      },
      SESSION,
      { cols: 120, rows: 40 },
    )
    expect(timeline).toEqual([`flush:${SESSION}`, 'report:120x40'])
  })

  it('reports with no scheduler at all — a partial host still reports', () => {
    const sent: DaemonMessage[] = []
    reportSize({ send: (msg) => sent.push(msg) }, SESSION, { cols: 80, rows: 24 })
    expect(sent).toHaveLength(1)
  })
})

describe('only the size event reports', () => {
  const root = join(import.meta.dirname, '..')

  it('reportSize is called from exactly one function: onSessionSize', () => {
    const callers = sources(root).flatMap((path) => {
      const text = readFileSync(path, 'utf8')
      return [...text.matchAll(/reportSize\(/g)].map(() => path.slice(root.length + 1))
    })
    // One definition, one call — and the call sits inside onSessionSize.
    expect(callers.sort()).toEqual(['control/applied-geometry.ts', 'control/session.ts'])
    const session = readFileSync(join(root, 'control/session.ts'), 'utf8')
    const body = session.slice(session.indexOf('export function onSessionSize('))
    expect(body.slice(0, body.indexOf('\n}\n'))).toContain(
      'reportSize(ctx, sessionId, size, birth)',
    )
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

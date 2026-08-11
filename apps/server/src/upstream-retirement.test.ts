/**
 * THE OPERATOR REPORT for work parked by the upstream retirement (POD-309, ADR 5 D8:
 * "silent discard of poison/pending work is forbidden").
 *
 * WHAT EACH ARM'S REFUSAL DEPENDS ON — the question this run has learned to ask of
 * every gate. Both arms here depend on ONE thing: what the injected source returns.
 * There is no clock to arrange, no network, no environment fact a test host might not
 * be able to produce. The silent arm is reached by returning `[]` and the loud arm by
 * returning rows, so neither is a branch the suite can only hope it hit.
 *
 * The ordering of the cases matters as much as their content. `reports nothing` is an
 * absence claim, and a `reportParkedUpstreamMutations` that had been gutted to
 * `return 0` would satisfy it perfectly — so the loud case runs the SAME function
 * against rows and asserts the count, the event and the message. Each is the other's
 * control.
 */

import { describe, expect, it, vi } from 'vitest'
import { captureLogs } from './test-support/capture-logs'
import {
  type ParkedUpstreamSource,
  type RetirementEventSink,
  reportParkedUpstreamMutations,
} from './upstream-retirement'

type AppendedEvent = Parameters<RetirementEventSink['appendEvent']>[0]

function sink(): RetirementEventSink & { events: AppendedEvent[] } {
  const events: AppendedEvent[] = []
  return {
    events,
    appendEvent(e) {
      events.push(e)
      return events.length
    },
  }
}

const source = (
  rows: { mutationId: string; proc: string; queuedAt: number }[],
): ParkedUpstreamSource => ({ listParkedUpstreamMutations: () => rows })

const AT = Date.UTC(2026, 6, 30, 12, 0, 0)

describe('reportParkedUpstreamMutations', () => {
  it('reports NOTHING when the archived outbox is empty — no event, no warning', () => {
    const events = sink()
    const logs = captureLogs()
    try {
      expect(reportParkedUpstreamMutations(source([]), events, () => AT)).toBe(0)
      expect(events.events).toEqual([])
      expect(logs.records).toEqual([])
    } finally {
      logs.restore()
    }
  })

  it('surfaces every parked mutation on BOTH channels — the durable event and the log', () => {
    const events = sink()
    const logs = captureLogs()
    try {
      const count = reportParkedUpstreamMutations(
        source([
          { mutationId: 'm1', proc: 'close', queuedAt: Date.UTC(2026, 6, 1) },
          { mutationId: 'm2', proc: 'update', queuedAt: Date.UTC(2026, 6, 2) },
        ]),
        events,
        () => AT,
      )
      expect(count).toBe(2)

      // ---- the durable channel: queryable long after the journal has rotated ----
      expect(events.events).toHaveLength(1)
      const event = events.events[0]
      expect(event?.kind).toBe('upstream.retired_pending')
      expect(event?.ts).toBe(new Date(AT).toISOString())
      // The IDENTITY of each parked mutation must ride the event, not just a count: an
      // operator re-applying this work by hand needs to know WHICH mutations, and a
      // bare `{ count: 2 }` is a notice they cannot act on.
      expect(event?.payload).toEqual({
        count: 2,
        mutations: [
          {
            mutationId: 'm1',
            proc: 'close',
            queuedAt: new Date(Date.UTC(2026, 6, 1)).toISOString(),
          },
          {
            mutationId: 'm2',
            proc: 'update',
            queuedAt: new Date(Date.UTC(2026, 6, 2)).toISOString(),
          },
        ],
      })

      // ---- the log channel: visible to whoever is watching the boot right now ----
      // The IDENTITIES ride a field now rather than a formatted sentence, so this
      // asserts the same promise the durable event above makes — an operator can
      // see WHICH mutations, not just how many — without depending on wording.
      const warned = logs.at('warn')[0]
      expect(warned).toMatchObject({
        parked: 2,
        mutations: [
          expect.objectContaining({ mutationId: 'm1', proc: 'issues.close' }),
          expect.objectContaining({ mutationId: 'm2', proc: 'issues.update' }),
        ],
      })
      // It must still say what to DO. A notice that reports a loss without naming a
      // remedy reads as a crash, and an operator's first instinct is to delete the
      // table — so the remedy stays in the MESSAGE, where a human reads it.
      expect(String(warned?.msg)).toContain('PARKED')
      expect(String(warned?.msg)).toContain('upstream_outbox')
    } finally {
      logs.restore()
    }
  })

  it('a database with no archived table does not stop the boot', () => {
    const events = sink()
    const logs = captureLogs()
    try {
      const throwing: ParkedUpstreamSource = {
        listParkedUpstreamMutations: () => {
          throw new Error('no such table: upstream_outbox')
        },
      }
      expect(reportParkedUpstreamMutations(throwing, events, () => AT)).toBe(0)
      expect(events.events).toEqual([])
    } finally {
      logs.restore()
    }
  })

  /**
   * A failed durable append must not swallow the warning that already went out, and
   * must not take the server down. The count is still the truth about what is parked —
   * that is what makes the return value usable by a caller that wants to react.
   */
  it('still warns and still reports the count when the durable append fails', () => {
    const logs = captureLogs()
    try {
      const broken: RetirementEventSink = {
        appendEvent() {
          throw new Error('events table is locked')
        },
      }
      expect(
        reportParkedUpstreamMutations(
          source([{ mutationId: 'm1', proc: 'close', queuedAt: AT }]),
          broken,
          () => AT,
        ),
      ).toBe(1)
      expect(logs.at('warn')[0]).toMatchObject({
        mutations: [expect.objectContaining({ mutationId: 'm1' })],
      })
    } finally {
      logs.restore()
    }
  })
})

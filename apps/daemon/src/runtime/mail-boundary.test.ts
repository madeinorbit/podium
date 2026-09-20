import type { AgentSessionHandle, RuntimeEvent } from '@podium/agent-runtime'
import { asSessionId } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import { composeMailContext, createAckReminderInjector, createMailInjector } from '../mail-injector'
import {
  createMailContinuation,
  MAIL_BOUNDARY_OPTIONS,
  respondToMailBoundary,
} from './mail-boundary'

const id = asSessionId('mail-boundary')
function event(
  epoch: number,
  phase: 'started' | 'completed',
  origin: 'human' | 'mail' = 'human',
): RuntimeEvent {
  return {
    t: 'turn',
    provenance: 'live',
    turnEpoch: epoch,
    at: '2026-09-18T00:00:00.000Z',
    observerGeneration: 1,
    cursor: { segmentId: 'test', components: { seq: epoch } },
    ev:
      phase === 'started'
        ? { ev: 'started', turnEpoch: epoch, origin }
        : { ev: 'completed', turnEpoch: epoch, verdict: 'done' },
  } as RuntimeEvent
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

function world(context: (sessionId: typeof id) => Promise<string | null>) {
  const send = vi.fn(async () => ({ outcome: 'accepted', turnEpoch: 2 }))
  const handle = { binding: { sessionId: id }, send } as unknown as AgentSessionHandle
  let current = true
  const errors = vi.fn()
  const boundary = createMailContinuation(handle, context, () => current, errors)
  return {
    send,
    errors,
    boundary,
    replace: () => {
      current = false
    },
  }
}

describe('driver mail continuation', () => {
  it('claims duplicate completions before awaiting and attributes the continuation', async () => {
    let resolve!: (text: string) => void
    const context = vi.fn(
      () =>
        new Promise<string>((done) => {
          resolve = done
        }),
    )
    const w = world(context)
    w.boundary(event(1, 'started'))
    w.boundary(event(1, 'completed'))
    w.boundary(event(1, 'completed'))
    await settle()
    expect(context).toHaveBeenCalledTimes(1)
    resolve('read inbox from coordinator')
    await settle()
    expect(w.send).toHaveBeenCalledExactlyOnceWith(
      { text: 'read inbox from coordinator' },
      MAIL_BOUNDARY_OPTIONS,
    )
    w.boundary(event(2, 'started', 'mail'))
    w.boundary(event(2, 'completed'))
    w.boundary(event(1, 'started'))
    w.boundary(event(1, 'completed'))
    await settle()
    expect(context).toHaveBeenCalledTimes(1)
  })

  it('does not consume reminders for an already displaced handle', async () => {
    const context = vi.fn(async () => 'mail')
    const w = world(context)
    w.replace()
    w.boundary(event(1, 'started'))
    w.boundary(event(1, 'completed'))
    await settle()
    expect(context).not.toHaveBeenCalled()
  })

  it.each(['replacement', 'new turn'] as const)('discards relay work after %s', async (change) => {
    let resolve!: (text: string) => void
    const w = world(
      () =>
        new Promise<string>((done) => {
          resolve = done
        }),
    )
    w.boundary(event(1, 'started'))
    w.boundary(event(1, 'completed'))
    await settle()
    if (change === 'replacement') w.replace()
    else w.boundary(event(2, 'started'))
    resolve('stale mail')
    await settle()
    expect(w.send).not.toHaveBeenCalled()
  })

  it('continues an initial prompt whose start was bootstrapped but completion is live', async () => {
    const w = world(async () => 'mail')
    w.boundary({ ...event(1, 'started'), provenance: 'bootstrap' })
    w.boundary(event(1, 'completed'))
    await settle()
    expect(w.send).toHaveBeenCalledTimes(1)
  })

  it('ignores replay, completion without a live start and unsuccessful completion', async () => {
    const context = vi.fn(async () => 'mail')
    const w = world(context)
    w.boundary(event(1, 'completed'))
    w.boundary({ ...event(2, 'started'), provenance: 'bootstrap' })
    w.boundary({ ...event(2, 'completed'), provenance: 'bootstrap' })
    w.boundary(event(2, 'completed'))
    w.boundary(event(3, 'started'))
    const done = event(3, 'completed')
    w.boundary({
      ...done,
      ev: { ev: 'completed', turnEpoch: 3, verdict: 'interrupted' },
    } as RuntimeEvent)
    await settle()
    expect(context).not.toHaveBeenCalled()
  })

  it.each(['empty', 'failed'] as const)('fails open for %s relay', async (mode) => {
    const w = world(async () => {
      if (mode === 'failed') throw new Error('offline')
      return null
    })
    w.boundary(event(1, 'started'))
    w.boundary(event(1, 'completed'))
    await settle()
    expect(w.send).not.toHaveBeenCalled()
  })

  it('bounds a hung relay and does not deliver its late answer', async () => {
    vi.useFakeTimers()
    try {
      let resolve!: (text: string) => void
      const w = world(
        () =>
          new Promise<string>((done) => {
            resolve = done
          }),
      )
      w.boundary(event(1, 'started'))
      w.boundary(event(1, 'completed'))
      await vi.advanceTimersByTimeAsync(2_500)
      resolve('late')
      await vi.advanceTimersByTimeAsync(1)
      expect(w.send).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('mail boundary policy composition', () => {
  it('does not consume persisted ack reminders when unread mail wins or another poll is pending', async () => {
    let resolve!: (value: { ok: boolean; result: { unread: number } }) => void
    const ack = vi.fn(async () => ({ ok: true, result: [{ id: 'm1', from: 'parent' }] }))
    const source = composeMailContext(
      createMailInjector(
        () =>
          new Promise((done) => {
            resolve = done
          }),
      ),
      createAckReminderInjector(ack),
    )
    const first = source.pendingContext(id)
    expect(await source.pendingContext(id)).toBeNull()
    resolve({ ok: true, result: { unread: 2 } })
    expect(await first).toContain('2 message(s)')
    expect(ack).not.toHaveBeenCalled()
  })

  it('does not consume a reminder after a timed-out unread lookup eventually returns', async () => {
    vi.useFakeTimers()
    try {
      let resolve!: (value: { ok: boolean; result: { unread: number } }) => void
      const ack = vi.fn(async () => ({ ok: true, result: [{ id: 'm1', from: 'parent' }] }))
      const source = composeMailContext(
        createMailInjector(
          () =>
            new Promise((done) => {
              resolve = done
            }),
        ),
        createAckReminderInjector(ack),
      )
      const pending = respondToMailBoundary(source.pendingContext, id, { hook_event_name: 'Stop' })
      await vi.advanceTimersByTimeAsync(2_500)
      expect(await pending).toBeNull()
      resolve({ ok: true, result: { unread: 0 } })
      await vi.advanceTimersByTimeAsync(1)
      expect(ack).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('can deliver at a later boundary after a relay never settles', async () => {
    vi.useFakeTimers()
    try {
      let calls = 0
      const source = composeMailContext(
        createMailInjector(async () => {
          calls++
          if (calls === 1) return new Promise<never>(() => {})
          return { ok: true, result: { unread: 1 } }
        }),
      )
      const first = respondToMailBoundary(source.pendingContext, id, { hook_event_name: 'Stop' })
      await vi.advanceTimersByTimeAsync(2_500)
      expect(await first).toBeNull()
      const second = await respondToMailBoundary(source.pendingContext, id, {
        hook_event_name: 'Stop',
      })
      expect(JSON.parse(second!)).toMatchObject({ decision: 'block' })
      expect(calls).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('honors an already expired shared hook deadline before polling', async () => {
    const controller = new AbortController()
    controller.abort()
    const context = vi.fn(async () => 'mail')
    expect(
      await respondToMailBoundary(context, id, { hook_event_name: 'Stop' }, controller.signal),
    ).toBeNull()
    expect(context).not.toHaveBeenCalled()
  })

  it('honors the server persisted single reminder beyond cooldown and driver recreation', async () => {
    let reminded = false
    let clock = 0
    const relay = vi.fn(async () => {
      const rows = reminded ? [] : [{ id: 'm1', from: 'coordinator' }]
      reminded = true
      return { ok: true, result: rows }
    })
    const first = createAckReminderInjector(relay, () => clock)
    const reason = await first.pendingContext(id)
    expect(reason).toContain('m1 (from coordinator)')
    expect(await first.pendingContext(id)).toBeNull()
    expect(relay).toHaveBeenCalledTimes(1)
    clock = 60_000
    expect(await first.pendingContext(id)).toBeNull()
    expect(await createAckReminderInjector(relay).pendingContext(id)).toBeNull()
  })

  it('does not poll either policy under an active stop hook', async () => {
    const context = vi.fn(async () => 'mail')
    expect(
      await respondToMailBoundary(context, id, { hook_event_name: 'Stop', stop_hook_active: true }),
    ).toBeNull()
    expect(context).not.toHaveBeenCalled()
  })
})

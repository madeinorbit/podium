import { describe, expect, it } from 'vitest'
import {
  composeResponders,
  createAckReminderInjector,
  createMailInjector,
  MAIL_BLOCK_COOLDOWN_MS,
} from './mail-injector'

const unreadRelay = (unread: number) => async () => ({ ok: true, result: { unread } })

describe('mail injector', () => {
  it('blocks on Stop when the issue has unread mail', async () => {
    const inj = createMailInjector(unreadRelay(2))
    const body = await inj.respondTo('s1', { hook_event_name: 'Stop', stop_hook_active: false })
    const parsed = JSON.parse(body ?? 'null')
    expect(parsed.decision).toBe('block')
    expect(parsed.reason).toContain('podium issue mail inbox')
    expect(parsed.reason).toContain('podium issue mail claim')
  })

  it('denies one Grok PreToolUse call with the durable inbox pointer', async () => {
    const inj = createMailInjector(unreadRelay(1))
    expect(await inj.respondTo('g1', { hookEventName: 'Stop' })).toBeNull()
    const body = await inj.respondTo('g1', {
      hookEventName: 'PreToolUse',
      toolName: 'Bash',
    })
    const parsed = JSON.parse(body ?? 'null')
    expect(parsed.decision).toBe('deny')
    expect(parsed.reason).toContain('podium issue mail inbox')
  })
  it('coalesces senders into the pointer when the server supplies them (#237)', async () => {
    const inj = createMailInjector(async () => ({
      ok: true,
      result: { unread: 2, senders: ['issue:#212', 'superagent'] },
    }))
    const body = await inj.respondTo('s1', { hook_event_name: 'Stop' })
    const parsed = JSON.parse(body ?? 'null')
    expect(parsed.reason).toContain('2 message(s) from issue:#212, superagent')
    expect(parsed.reason).toContain('podium issue mail inbox')
  })

  it('returns null when stop_hook_active (loop guard)', async () => {
    let calls = 0
    const inj = createMailInjector(async () => {
      calls++
      return { ok: true, result: { unread: 5 } }
    })
    expect(
      await inj.respondTo('s1', { hook_event_name: 'Stop', stop_hook_active: true }),
    ).toBeNull()
    expect(calls).toBe(0) // guard short-circuits before the relay
  })

  it('returns null when unread is zero', async () => {
    const inj = createMailInjector(unreadRelay(0))
    expect(await inj.respondTo('s1', { hook_event_name: 'Stop' })).toBeNull()
  })

  it('returns null on relay failure, throw, or malformed result', async () => {
    expect(
      await createMailInjector(async () => ({ ok: false })).respondTo('s1', {
        hook_event_name: 'Stop',
      }),
    ).toBeNull()
    expect(
      await createMailInjector(async () => {
        throw new Error('boom')
      }).respondTo('s1', { hook_event_name: 'Stop' }),
    ).toBeNull()
    expect(
      await createMailInjector(async () => ({ ok: true, result: 'nope' })).respondTo('s1', {
        hook_event_name: 'Stop',
      }),
    ).toBeNull()
  })

  it('rate-guards repeat blocks per session for 60s', async () => {
    let clock = 1_000_000
    const inj = createMailInjector(unreadRelay(1), () => clock)
    expect(await inj.respondTo('s1', { hook_event_name: 'Stop' })).not.toBeNull()
    clock += MAIL_BLOCK_COOLDOWN_MS - 1
    expect(await inj.respondTo('s1', { hook_event_name: 'Stop' })).toBeNull()
    // Other sessions are unaffected.
    expect(await inj.respondTo('s2', { hook_event_name: 'Stop' })).not.toBeNull()
    clock += 1
    expect(await inj.respondTo('s1', { hook_event_name: 'Stop' })).not.toBeNull()
  })

  it('ignores non-Stop events and junk payloads', async () => {
    const inj = createMailInjector(unreadRelay(3))
    expect(await inj.respondTo('s1', { hook_event_name: 'SessionStart' })).toBeNull()
    expect(await inj.respondTo('s1', { hook_event_name: 'UserPromptSubmit' })).toBeNull()
    expect(await inj.respondTo('s1', null)).toBeNull()
    expect(await inj.respondTo('s1', 'garbage')).toBeNull()
  })
})

describe('composeResponders', () => {
  it('returns the first non-null response and skips throwers', async () => {
    const composed = composeResponders(
      async () => null,
      async () => {
        throw new Error('broken responder')
      },
      async () => '"second"',
      async () => '"third"',
    )
    expect(await composed('s1', {})).toBe('"second"')
  })

  it('returns null when all responders decline', async () => {
    const composed = composeResponders(
      async () => null,
      async () => null,
    )
    expect(await composed('s1', {})).toBeNull()
  })
})

describe('ack reminder injector (#237) [spec:SP-34d7 acks]', () => {
  const reminders = (rows: unknown) => async () => ({ ok: true, result: rows })

  it('blocks ONCE with a per-message reply pointer', async () => {
    const inj = createAckReminderInjector(
      reminders([
        { id: 'msg_1', from: 'issue:#212', body: 'do x' },
        { id: 'msg_2', from: 'superagent', body: 'do y' },
      ]),
    )
    const body = await inj.respondTo('s1', { hook_event_name: 'Stop' })
    const parsed = JSON.parse(body ?? 'null')
    expect(parsed.decision).toBe('block')
    expect(parsed.reason).toContain('podium mail reply msg_1')
    expect(parsed.reason).toContain('podium mail reply msg_2')
    expect(parsed.reason).toContain('only reminder')
    // The SERVER marked them reminded — an empty next answer never blocks again.
    const inj2 = createAckReminderInjector(reminders([]))
    expect(await inj2.respondTo('s1', { hook_event_name: 'Stop' })).toBeNull()
  })

  it('uses Grok PreToolUse denial for the one acknowledgement reminder', async () => {
    const inj = createAckReminderInjector(
      reminders([{ id: 'msg_grok', from: 'issue:#550', body: 'verify hooks' }]),
    )
    const body = await inj.respondTo('g1', {
      hookEventName: 'PreToolUse',
      toolName: 'Read',
    })
    const parsed = JSON.parse(body ?? 'null')
    expect(parsed.decision).toBe('deny')
    expect(parsed.reason).toContain('podium mail reply msg_grok')
  })
  it('honours the loop guard and cooldown, and fails open', async () => {
    let clock = 1_000_000
    const inj = createAckReminderInjector(
      reminders([{ id: 'm', from: 'x', body: 'b' }]),
      () => clock,
    )
    expect(
      await inj.respondTo('s1', { hook_event_name: 'Stop', stop_hook_active: true }),
    ).toBeNull()
    expect(await inj.respondTo('s1', { hook_event_name: 'Stop' })).not.toBeNull()
    clock += MAIL_BLOCK_COOLDOWN_MS - 1
    expect(await inj.respondTo('s1', { hook_event_name: 'Stop' })).toBeNull()
    // old server (unknown router) / errors: never block
    expect(
      await createAckReminderInjector(async () => ({ ok: false })).respondTo('s2', {
        hook_event_name: 'Stop',
      }),
    ).toBeNull()
    expect(
      await createAckReminderInjector(async () => {
        throw new Error('boom')
      }).respondTo('s2', { hook_event_name: 'Stop' }),
    ).toBeNull()
  })
})

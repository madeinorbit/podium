import { describe, it, expect } from 'vitest'
import { createMailInjector, composeResponders, MAIL_BLOCK_COOLDOWN_MS } from './mail-injector'

const unreadRelay = (unread: number) => async () => ({ ok: true, result: { unread } })

describe('mail injector', () => {
  it('blocks on Stop when the issue has unread mail', async () => {
    const inj = createMailInjector(unreadRelay(2))
    const body = await inj.respondTo('s1', { hook_event_name: 'Stop', stop_hook_active: false })
    const parsed = JSON.parse(body!)
    expect(parsed.decision).toBe('block')
    expect(parsed.reason).toContain("podium issue mail inbox")
    expect(parsed.reason).toContain("podium issue mail claim")
  })

  it('returns null when stop_hook_active (loop guard)', async () => {
    let calls = 0
    const inj = createMailInjector(async () => { calls++; return { ok: true, result: { unread: 5 } } })
    expect(await inj.respondTo('s1', { hook_event_name: 'Stop', stop_hook_active: true })).toBeNull()
    expect(calls).toBe(0) // guard short-circuits before the relay
  })

  it('returns null when unread is zero', async () => {
    const inj = createMailInjector(unreadRelay(0))
    expect(await inj.respondTo('s1', { hook_event_name: 'Stop' })).toBeNull()
  })

  it('returns null on relay failure, throw, or malformed result', async () => {
    expect(await createMailInjector(async () => ({ ok: false })).respondTo('s1', { hook_event_name: 'Stop' })).toBeNull()
    expect(await createMailInjector(async () => { throw new Error('boom') }).respondTo('s1', { hook_event_name: 'Stop' })).toBeNull()
    expect(await createMailInjector(async () => ({ ok: true, result: 'nope' })).respondTo('s1', { hook_event_name: 'Stop' })).toBeNull()
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
      async () => { throw new Error('broken responder') },
      async () => '"second"',
      async () => '"third"',
    )
    expect(await composed('s1', {})).toBe('"second"')
  })

  it('returns null when all responders decline', async () => {
    const composed = composeResponders(async () => null, async () => null)
    expect(await composed('s1', {})).toBeNull()
  })
})

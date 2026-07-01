import { describe, it, expect } from 'vitest'
import { createPrimeInjector } from './prime-injector'

const okRelay = (text: string) => async () => ({ ok: true, result: text })

describe('prime injector', () => {
  it('injects additionalContext on SessionStart, once', async () => {
    let calls = 0
    const inj = createPrimeInjector(async () => { calls++; return { ok: true, result: 'PRIME' } })
    const first = await inj.respondTo('s1', { hook_event_name: 'SessionStart' })
    expect(JSON.parse(first!)).toEqual({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'PRIME' } })
    const second = await inj.respondTo('s1', { hook_event_name: 'UserPromptSubmit' })
    expect(second).toBeNull() // already primed
    expect(calls).toBe(1)
  })

  it('re-injects after a PreCompact', async () => {
    const inj = createPrimeInjector(okRelay('PRIME2'))
    await inj.respondTo('s1', { hook_event_name: 'SessionStart' })
    expect(await inj.respondTo('s1', { hook_event_name: 'PreCompact' })).toBeNull()
    const again = await inj.respondTo('s1', { hook_event_name: 'UserPromptSubmit' })
    expect(JSON.parse(again!).hookSpecificOutput.additionalContext).toBe('PRIME2')
  })

  it('returns null when relay fails or result is empty', async () => {
    const bad = createPrimeInjector(async () => ({ ok: false }))
    expect(await bad.respondTo('s1', { hook_event_name: 'SessionStart' })).toBeNull()
    const empty = createPrimeInjector(async () => ({ ok: true, result: '' }))
    expect(await empty.respondTo('s2', { hook_event_name: 'SessionStart' })).toBeNull()
  })

  it('ignores non-context events', async () => {
    const inj = createPrimeInjector(okRelay('X'))
    expect(await inj.respondTo('s1', { hook_event_name: 'PostToolUse' })).toBeNull()
    expect(await inj.respondTo('s1', { hook_event_name: 'Stop' })).toBeNull()
  })
})

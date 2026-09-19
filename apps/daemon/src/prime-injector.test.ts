import { asSessionId } from '@podium/model'
import { describe, it, expect } from 'vitest'
import { createPrimeInjector } from './prime-injector'

const okRelay = (text: string) => async () => ({ ok: true, result: text })

describe('prime injector', () => {
  it('injects additionalContext on SessionStart, once', async () => {
    let calls = 0
    const inj = createPrimeInjector(async () => { calls++; return { ok: true, result: 'PRIME' } })
    const first = await inj.respondTo(asSessionId('s1'), { hook_event_name: 'SessionStart' })
    expect(JSON.parse(first!)).toEqual({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'PRIME' } })
    const second = await inj.respondTo(asSessionId('s1'), { hook_event_name: 'UserPromptSubmit' })
    expect(second).toBeNull() // already primed
    expect(calls).toBe(1)
  })

  it('re-injects after a PreCompact', async () => {
    const inj = createPrimeInjector(okRelay('PRIME2'))
    await inj.respondTo(asSessionId('s1'), { hook_event_name: 'SessionStart' })
    expect(await inj.respondTo(asSessionId('s1'), { hook_event_name: 'PreCompact' })).toBeNull()
    const again = await inj.respondTo(asSessionId('s1'), { hook_event_name: 'UserPromptSubmit' })
    expect(JSON.parse(again!).hookSpecificOutput.additionalContext).toBe('PRIME2')
  })

  it('returns null when relay fails or result is empty', async () => {
    const bad = createPrimeInjector(async () => ({ ok: false }))
    expect(await bad.respondTo(asSessionId('s1'), { hook_event_name: 'SessionStart' })).toBeNull()
    const empty = createPrimeInjector(async () => ({ ok: true, result: '' }))
    expect(await empty.respondTo(asSessionId('s2'), { hook_event_name: 'SessionStart' })).toBeNull()
  })

  it('ignores non-context events', async () => {
    const inj = createPrimeInjector(okRelay('X'))
    expect(await inj.respondTo(asSessionId('s1'), { hook_event_name: 'PostToolUse' })).toBeNull()
    expect(await inj.respondTo(asSessionId('s1'), { hook_event_name: 'Stop' })).toBeNull()
  })

  // Grok's native hooks speak camelCase; the legacy responder the removal
  // deletes must have behaved identically for it, or the deletion itself
  // changes Grok's prime behaviour.
  it('answers camelCase hook payloads exactly like snake_case', async () => {
    let calls = 0
    const inj = createPrimeInjector(async () => { calls++; return { ok: true, result: 'PRIME' } })
    const first = await inj.respondTo(asSessionId('g1'), { hookEventName: 'SessionStart' })
    expect(JSON.parse(first!)).toEqual({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'PRIME' },
    })
    expect(await inj.respondTo(asSessionId('g1'), { hookEventName: 'UserPromptSubmit' })).toBeNull()
    expect(calls).toBe(1)
    expect(await inj.respondTo(asSessionId('g1'), { hookEventName: 'PreCompact' })).toBeNull()
    const again = await inj.respondTo(asSessionId('g1'), { hookEventName: 'UserPromptSubmit' })
    expect(JSON.parse(again!).hookSpecificOutput.additionalContext).toBe('PRIME')
    expect(calls).toBe(2)
  })

  it('ignores camelCase non-context events', async () => {
    const inj = createPrimeInjector(okRelay('X'))
    expect(await inj.respondTo(asSessionId('g1'), { hookEventName: 'PreToolUse' })).toBeNull()
    expect(await inj.respondTo(asSessionId('g1'), { hookEventName: 'Stop' })).toBeNull()
  })
})

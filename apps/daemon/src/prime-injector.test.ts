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

  // CODEX POST-COMPACTION RE-PRIME (this issue): Codex compacts without a
  // PreCompact subscription — Podium's hooks.json never installs one, because
  // PreCompact supports only the common output fields, never additionalContext
  // — so the only post-compaction signal is SessionStart with source 'compact'
  // (per the Codex release hooks reference: SessionStart matcher source runs
  // on startup|resume|clear|compact). The codec re-arms on that source before
  // priming, so the agent gets its scoped context back. Verified against the
  // real Codex 0.155.0 binary for the consumption half (stdout additionalContext
  // lands as developer-role hooks.additional_context messages); live
  // post-compaction firing was quota-blocked and rests on the vendor reference
  // until then. Do NOT fix by subscribing PreCompact (which cannot carry
  // context).
  it('re-primes on a post-compaction SessionStart (source compact)', async () => {
    const inj = createPrimeInjector(okRelay('PRIME2'))
    await inj.respondTo(asSessionId('s1'), { hook_event_name: 'SessionStart', source: 'startup' })
    const reprimed = await inj.respondTo(asSessionId('s1'), {
      hook_event_name: 'SessionStart',
      source: 'compact',
    })
    expect(JSON.parse(reprimed!).hookSpecificOutput.additionalContext).toBe('PRIME2')
    // The re-prime consumes the new incarnation: the next prompt stays silent.
    expect(
      await inj.respondTo(asSessionId('s1'), { hook_event_name: 'UserPromptSubmit' }),
    ).toBeNull()
  })

  it('re-primes on a camelCase post-compaction SessionStart (source compact)', async () => {
    const inj = createPrimeInjector(okRelay('PRIME2'))
    await inj.respondTo(asSessionId('g1'), { hookEventName: 'SessionStart', source: 'startup' })
    const reprimed = await inj.respondTo(asSessionId('g1'), {
      hookEventName: 'SessionStart',
      source: 'compact',
    })
    expect(JSON.parse(reprimed!).hookSpecificOutput.additionalContext).toBe('PRIME2')
    expect(
      await inj.respondTo(asSessionId('g1'), { hookEventName: 'UserPromptSubmit' }),
    ).toBeNull()
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

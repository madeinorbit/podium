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

  // REAL-HARNESS GAP, PINNED (this issue, POD-4395): Codex compacts without a
  // PreCompact subscription — Podium's hooks.json never installs one — so the
  // only post-compaction signal is SessionStart with source 'compact' (per the
  // Codex release hooks reference: SessionStart matcher source runs on
  // startup|resume|clear|compact, and PreCompact supports only the common
  // output fields, never additionalContext). This mapping reads only the event
  // name, so that SessionStart answers null: Codex is NOT re-primed after
  // compaction today. The fix is to re-arm on SessionStart source=compact, not
  // to subscribe PreCompact (which cannot carry context). Verified against the
  // real Codex 0.155.0 binary for the consumption half (stdout additionalContext
  // lands as developer-role hooks.additional_context messages); live
  // post-compaction firing was not driven (quota-blocked) and rests on the
  // vendor reference until then.
  it('does not re-prime on a post-compaction SessionStart (source compact)', async () => {
    const inj = createPrimeInjector(okRelay('PRIME2'))
    await inj.respondTo(asSessionId('s1'), { hook_event_name: 'SessionStart', source: 'startup' })
    expect(
      await inj.respondTo(asSessionId('s1'), { hook_event_name: 'SessionStart', source: 'compact' }),
    ).toBeNull()
    expect(
      await inj.respondTo(asSessionId('s1'), { hookEventName: 'SessionStart', source: 'compact' }),
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

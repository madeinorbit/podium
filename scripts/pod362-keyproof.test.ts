import { describe, expect, it } from 'vitest'
import { machineScopedKey, parseMachineScopedKey, resumeKey } from '../packages/model/src/ids/keys'

describe('POD-362 machineScopedKey adoption is byte-compatible for real ids', () => {
  it('produces the SAME bytes the ad-hoc `${machineId}\\n${nativeId}` produced', () => {
    for (const [m, n] of [
      ['__local__', 'abc-123'],
      ['mach_7f3a', 'sess-file-1'],
      ['__local__', ''],
    ] as const) {
      // The literal the 8 adopted sites used before POD-362.
      expect(machineScopedKey(m, n)).toBe(`${m}\n${n}`)
    }
  })

  it('and it ESCAPES a hostile nativeId, which the ad-hoc form did NOT', () => {
    const hostile = 'a\nb'
    // The ad-hoc form collides: ('m','a\nb') and ('m\na','b') are one string.
    expect(`m\n${hostile}`).toBe(`m\na\nb`)
    expect(`${'m\na'}\n${'b'}`).toBe(`m\na\nb`)
    // The helper does not.
    expect(machineScopedKey('m', hostile)).not.toBe(machineScopedKey('m\na', 'b'))
    expect(parseMachineScopedKey(machineScopedKey('m', hostile))).toEqual({
      machineId: 'm',
      nativeId: hostile,
    })
  })
})

describe('POD-362 resumeKey adoption is byte-compatible too', () => {
  it('matches the ad-hoc `${kind}:${value}` for every real resume ref shape', () => {
    for (const [k, v] of [
      ['claude', '0199f2aa-1c3d-7c9e-9a2b-1f2e3d4c5b6a'],
      ['codex', 'rollout-2026-07-30T12-00-00'],
      ['', ''], // session-identity's own `?? ''` default must still round-trip
    ] as const) {
      expect(resumeKey(k, v)).toBe(`${k}:${v}`)
    }
  })

  it('and it fixes the collision the ad-hoc form had', () => {
    // ('a','b:c') and ('a:b','c') are ONE string under the ad-hoc form.
    expect(`a:${'b:c'}`).toBe(`${'a:b'}:c`)
    expect(resumeKey('a', 'b:c')).not.toBe(resumeKey('a:b', 'c'))
  })
})

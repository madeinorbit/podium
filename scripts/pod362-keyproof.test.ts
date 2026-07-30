import { describe, expect, it } from 'vitest'
import { machineScopedKey, parseMachineScopedKey } from '../packages/model/src/ids/keys'

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

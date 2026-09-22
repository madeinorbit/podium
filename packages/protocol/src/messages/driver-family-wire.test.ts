import { DriverFamilyWire, Inventory } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { SessionBinding } from './runtime'

/**
 * AN OLDER PEER'S `embedded` STILL PARSES, AS `server` (POD-4612).
 *
 * The Claude stream engine joined the server family; a daemon or server built
 * before that reports it as `embedded`. Peers upgrade out of order, so the
 * parsers WIDEN — they accept the old value — and normalize it where it
 * enters, so nothing downstream has a third family to branch on. Refusing it
 * would drop the whole frame the family rides in.
 */
describe('DriverFamilyWire', () => {
  it('reads the two families as themselves', () => {
    expect(DriverFamilyWire.parse('server')).toBe('server')
    expect(DriverFamilyWire.parse('terminal')).toBe('terminal')
  })

  it("normalizes an older peer's 'embedded' to 'server'", () => {
    expect(DriverFamilyWire.parse('embedded')).toBe('server')
  })

  it('still refuses a value no peer ever sent', () => {
    expect(DriverFamilyWire.safeParse('hybrid').success).toBe(false)
  })

  it('normalizes it inside the frames that carry it', () => {
    const binding = SessionBinding.parse({
      sessionId: 'legacy-claude-session',
      driver: 'claude-sdk',
      family: 'embedded',
      harness: 'claude-code',
      workdir: '/project',
      resume: { kind: 'claude-session', value: 'legacy-ref' },
      process: { key: 'claude-sdk:legacy-claude-session' },
      bindingVersion: 1,
    })
    expect(binding.family).toBe('server')

    const inventory = Inventory.parse({
      os: 'linux',
      arch: 'x64',
      agents: [],
      runtimeDrivers: [{ harness: 'claude-code', id: 'claude-sdk', family: 'embedded' }],
    })
    expect(inventory.runtimeDrivers).toEqual([
      { harness: 'claude-code', id: 'claude-sdk', family: 'server' },
    ])
  })
})

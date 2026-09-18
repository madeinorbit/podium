import { describe, expect, it } from 'vitest'
import hostFixtures from '../../../protocol/src/__fixtures__/golden/host.json'
import { machinesMaterialSignature, VOLATILE_MACHINE_PATHS } from './machines-material'

// These clocks describe history/authority, not heartbeat freshness.
const MATERIAL_TIMESTAMP_PATHS = [
  ['revokedAt'],
  ['harnessVersions', '*', 'firstSeen'],
  ['harnessVersions', '*', 'lastSeen'],
  ['harnessVersions', '*', 'verifiedThrough'],
]

describe('machine material signature', () => {
  it('classifies every timestamp path in the protocol machine fixtures', () => {
    const classified = new Set([...VOLATILE_MACHINE_PATHS, ...MATERIAL_TIMESTAMP_PATHS]
      .map((path) => JSON.stringify(path)))
    const found = new Set<string>()
    const scan = (value: unknown, path: string[]): void => {
      if (Array.isArray(value)) {
        for (const item of value) scan(item, [...path, '*'])
      } else if (value !== null && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) {
          const next = [...path, key]
          if (/(At|Seen|Through)$/.test(key)) found.add(JSON.stringify(next))
          scan(child, next)
        }
      }
    }
    const frames = hostFixtures.cases.filter((entry) => entry.schema === 'MachinesChangedMessage')
    expect(frames.length).toBeGreaterThan(0)
    for (const frame of frames) {
      const wire = frame.wire as { machines?: unknown[] }
      for (const machine of wire.machines ?? []) scan(machine, [])
    }
    expect([...found].filter((path) => !classified.has(path))).toEqual([])
    for (const path of VOLATILE_MACHINE_PATHS) expect(found.has(JSON.stringify(path))).toBe(true)
  })

  it('fails open for non-JSON input', () => {
    expect(machinesMaterialSignature([{ id: 'a', value: 1n } as { id: string }])).toBeUndefined()
  })

  it('preserves unknown dotted keys, nested array order, and harness history', () => {
    const signature = (extra: object) => machinesMaterialSignature([{ id: 'a', ...extra }])
    expect(signature({ 'services.server.observedAt': 'one' }))
      .not.toBe(signature({ 'services.server.observedAt': 'two' }))
    expect(signature({ future: [1, 2] })).not.toBe(signature({ future: [2, 1] }))
    expect(signature({ harnessVersions: [{ lastSeen: 'one' }] }))
      .not.toBe(signature({ harnessVersions: [{ lastSeen: 'two' }] }))
  })
})

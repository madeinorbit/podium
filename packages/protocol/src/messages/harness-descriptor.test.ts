import { asMachineId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { encodeDaemonMessage as encode, parseDaemonMessage } from '../daemon'
import { HarnessDescriptorWire } from './inventory'

/**
 * Wire descriptor versioning (POD-4475): the schema widens the parser first,
 * so an older client renders a newer harness inside the schema it already
 * has. Unknown fields are ignored, missing optionals render, and a newer
 * schemaVersion still parses (the client reads the fields it knows).
 */
describe('harness descriptor wire (POD-4475)', () => {
  const descriptor = {
    schemaVersion: 1,
    kind: 'future-cli',
    // POD-4529: the Accounts hub reads the vendor backend label off the
    // served descriptor instead of a hand-written table.
    provider: 'future',
    label: 'Future CLI',
    shortLabel: 'Future',
    icon: { id: 'future-cli', viewBox: '0 0 24 24', d: 'M12 2v20' },
    brand: { bg: '#123456', fg: '#ffffff' },
    capabilities: { argvPrompt: true, effort: true, systemPrompt: false },
    catalog: {
      models: [{ value: 'f1', label: 'F1', efforts: ['low'] }],
      efforts: ['low'],
      liveMerge: 'live-wins-when-non-empty',
    },
    login: { command: 'future login', installHint: 'Install Future.', signedOutHint: null },
  }

  it('parses a full descriptor', () => {
    expect(HarnessDescriptorWire.parse(descriptor)).toEqual({
      ...descriptor,
      login: { command: 'future login', installHint: 'Install Future.', signedOutHint: null },
    })
  })

  it('ignores an extra field from a newer daemon', () => {
    const parsed = HarnessDescriptorWire.parse({ ...descriptor, futureFlag: true, nested: { x: 1 } })
    expect('futureFlag' in parsed).toBe(false)
    expect('nested' in parsed).toBe(false)
    expect(parsed.label).toBe('Future CLI')
    // ...while the provider it states is kept, not stripped.
    expect(parsed.provider).toBe('future')
  })

  it('renders when every optional field is missing', () => {
    // Cast to an open record: the point is that these keys MAY be absent.
    const { brand: _b, login: _l, defaults: _d, available: _a, sections: _s, ...minimal } = {
      ...descriptor,
    } as Record<string, unknown>
    void _b
    void _l
    void _d
    void _a
    void _s
    const parsed = HarnessDescriptorWire.parse(minimal)
    expect(parsed.kind).toBe('future-cli')
    expect(parsed.brand).toBeUndefined()
    expect(parsed.available).toBeUndefined()
    expect(parsed.sections).toBeUndefined()
  })

  it('still parses a newer schemaVersion, reading the fields it knows', () => {
    const parsed = HarnessDescriptorWire.parse({ ...descriptor, schemaVersion: 2 })
    expect(parsed.schemaVersion).toBe(2)
    expect(parsed.label).toBe('Future CLI')
  })

  it('round-trips descriptors inside inventoryReport', () => {
    const inventory = {
      os: 'linux' as const,
      arch: 'x64' as const,
      agents: [],
      tools: [],
    }
    const msg = {
      type: 'inventoryReport' as const,
      machineId: asMachineId('m1'),
      inventory,
      descriptors: [descriptor],
    }
    expect(parseDaemonMessage(encode(msg))).toEqual(msg)
  })

  it('an older daemon that sends no descriptors still parses', () => {
    const msg = {
      type: 'inventoryReport' as const,
      machineId: asMachineId('m1'),
      inventory: { os: 'linux' as const, arch: 'x64' as const, agents: [], tools: [] },
    }
    expect(parseDaemonMessage(encode(msg))).toEqual(msg)
  })
})

/**
 * Unknown-harness behaviour (POD-4475 amendment): a client build that has
 * never heard of a harness renders it from the served descriptor — name,
 * icon, models and supported controls inside the schema it already has —
 * and unsupported operations fail with a typed refusal. Nothing crashes.
 *
 * DISCIPLINE: this file imports ONLY the browser entry (`./browser.js`) and
 * protocol types. Importing the registry or any adapter would give the test
 * the very knowledge the client build under test must NOT have — a mocked
 * absence proves nothing (coordinator, DONE WHEN 2).
 */
import type { HarnessDescriptorWire } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import {
  BUNDLED_DESCRIPTORS,
  bundledDescriptorFor,
  effortOptionsForDescriptor,
  modelOptionsForDescriptor,
  parseServedDescriptors,
  refuseUnsupportedOperation,
  resolveDescriptors,
  type ResolvedDescriptor,
} from './browser.js'

/** A served descriptor for a harness this build never shipped (no adapter,
 *  no fixture, no registry row) — plus one field from a newer schema. */
function futureCliDescriptor(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: 'future-cli',
    label: 'Future CLI',
    shortLabel: 'Future',
    icon: { id: 'future-cli', viewBox: '0 0 24 24', d: 'M12 2v20' },
    brand: { bg: '#123456', fg: '#ffffff' },
    capabilities: { argvPrompt: false, effort: true, systemPrompt: false },
    catalog: {
      models: [{ value: 'f1', label: 'F1', efforts: ['low'] }],
      efforts: ['low', 'high'],
      liveMerge: 'live-wins-when-non-empty',
    },
    login: { command: 'future login' },
    available: { installed: true, loggedIn: true },
    // Newer-schema field: an older client must ignore it, not choke on it.
    provider: 'future',
  }
}

describe('unknown harness renders from the served descriptor', () => {
  it('the bundled copy knows nothing about it', () => {
    expect(bundledDescriptorFor('future-cli')).toBeUndefined()
    expect(BUNDLED_DESCRIPTORS.some((d) => d.kind === 'future-cli')).toBe(false)
  })

  it('parses, resolves and renders name, icon, models and controls', () => {
    const served = parseServedDescriptors([futureCliDescriptor()])
    expect(served).toHaveLength(1)
    const resolved = resolveDescriptors(served)
    const found = resolved.find((d) => d.kind === 'future-cli')
    expect(found?.label).toBe('Future CLI')
    expect(found?.shortLabel).toBe('Future')
    expect(found?.icon.d).toBe('M12 2v20')
    expect(modelOptionsForDescriptor(found as ResolvedDescriptor)).toEqual([
      { value: 'auto', label: 'Auto' },
      { value: 'f1', label: 'F1', efforts: ['low'] },
    ])
    // Effort supported per served capabilities: the picker shows the ladder.
    expect(effortOptionsForDescriptor(found as ResolvedDescriptor, undefined)).toEqual([
      { value: 'auto', label: 'Auto' },
      { value: 'low', label: 'Low' },
      { value: 'high', label: 'High' },
    ])
  })

  it('an unsupported operation fails with a typed refusal, nothing crashes', () => {
    const served = parseServedDescriptors([futureCliDescriptor()])
    const resolved = resolveDescriptors(served)
    const found = resolved.find((d) => d.kind === 'future-cli') as ResolvedDescriptor
    // argvPrompt is false for this harness: routing a first prompt via argv
    // must be refused with a typed reason, not silently misdelivered.
    const refusal = refuseUnsupportedOperation(found, 'argv-prompt')
    expect(refusal).toEqual({
      kind: 'harness-operation-unsupported',
      harness: 'future-cli',
      operation: 'argv-prompt',
    })
    // A supported operation is no refusal at all.
    expect(refuseUnsupportedOperation(found, 'effort')).toBeUndefined()
  })

  it('a garbage frame renders nothing and crashes nothing', () => {
    expect(parseServedDescriptors([null, 42, 'x', { kind: 7 }])).toEqual([])
    expect(parseServedDescriptors('nope')).toEqual([])
  })
})

describe('schema versioning', () => {
  it('a missing optional field renders (offline shape has no availability)', () => {
    const { available: _a, sections: _s, login: _l, ...minimal } = futureCliDescriptor()
    void _a
    void _s
    void _l
    const [parsed] = parseServedDescriptors([minimal]) as [HarnessDescriptorWire]
    expect(parsed.kind).toBe('future-cli')
    const resolved = resolveDescriptors([parsed]).find((d) => d.kind === 'future-cli')
    expect(resolved?.label).toBe('Future CLI')
    // Availability unknown: render enabled, refuse honestly at spawn.
    expect(resolved?.available).toBeUndefined()
  })
})

import type { MachineWire } from '@podium/model/browser'
import { describe, expect, it } from 'vitest'
import { machineVersionSkew } from './machine-version-skew'
import { machineNeedsUpdate } from './version-skew'

type Subject = Parameters<typeof machineVersionSkew>[0]

function machine(over: Partial<MachineWire> = {}): Subject {
  return {
    inventory: { podiumVersion: '0.1.0' },
    targetVersion: '0.1.1',
    versionState: 'behind',
    ...over,
  } as Subject
}

describe('machineVersionSkew', () => {
  it('says nothing about a machine that is on its target', () => {
    expect(machineVersionSkew(machine({ versionState: 'current' }))).toEqual({ label: 'Current' })
  })

  it('treats a pending offer as expected, because nothing applies itself', () => {
    const verdict = machineVersionSkew(machine())
    expect(verdict.mark).toBe('expected')
    expect(verdict.label).toBe('Update available')
    expect(verdict.badge).toBe('update available')
  })
  it('labels a source checkout without offering a packaged update', () => {
    const verdict = machineVersionSkew(machine({ installKind: 'source' }))
    expect(verdict.label).toBe('Source checkout')
    expect(verdict.badge).toBeUndefined()
    expect(verdict.note).toMatch(/restart Podium from the terminal/i)
  })

  it('separates a machine that never arrived from one that was never asked', () => {
    expect(machineVersionSkew(machine(), null, 'stuck').mark).toBe('unexpected')
    expect(machineVersionSkew(machine(), null, 'stuck').label).toBe('Stuck behind target')
    expect(machineVersionSkew(machine(), null, 'rejected').mark).toBe('unexpected')
  })

  it('marks nothing while the update is actually running', () => {
    for (const state of ['granted', 'downloading', 'restarting'] as const) {
      const verdict = machineVersionSkew(machine(), null, state)
      expect(verdict.mark).toBeUndefined()
      expect(verdict.label).toBe('Updating…')
    }
  })

  it('reads a Podium Desktop machine like every other fleet machine', () => {
    const verdict = machineVersionSkew(machine({ supervised: true }))
    expect(verdict.mark).toBe('expected')
    expect(verdict.label).toBe('Update available')
  })

  it('reads a stuck supervised machine as stuck all the same', () => {
    expect(machineVersionSkew(machine({ supervised: true }), null, 'stuck').mark).toBe('unexpected')
  })

  it('calls a machine ahead of its target unexpected', () => {
    const verdict = machineVersionSkew(machine({ versionState: 'ahead' }))
    expect(verdict.mark).toBe('unexpected')
    expect(verdict.badge).toBe('ahead of target')
  })

  it('never claims a silent machine is current', () => {
    const silent = machine({ versionState: undefined, inventory: undefined })
    expect(machineVersionSkew(silent, '0.1.1').label).toBe('Not reported')
    expect(machineVersionSkew(machine({ versionState: 'unreported' })).label).toBe('Not reported')
  })

  it('falls back to the legacy comparison for a server that projects no state', () => {
    const legacy = machine({ versionState: undefined, targetVersion: undefined })
    expect(machineVersionSkew(legacy, '0.1.1').label).toBe('Update available')
    expect(machineVersionSkew(legacy, '0.1.0').label).toBe('Current')
  })
})

describe('machineNeedsUpdate', () => {
  it('prefers the server verdict over any local comparison', () => {
    expect(machineNeedsUpdate(machine({ versionState: 'behind' }), '0.1.0')).toBe(true)
    expect(machineNeedsUpdate(machine({ versionState: 'current' }), '9.9.9')).toBe(false)
  })
  it('never treats an explicit source checkout as a packaged update target', () => {
    expect(
      machineNeedsUpdate(machine({ installKind: 'source', versionState: 'behind' }), '9.9.9'),
    ).toBe(false)
    expect(
      machineNeedsUpdate(machine({ installKind: undefined, versionState: 'behind' }), '9.9.9'),
    ).toBe(true)
  })
})

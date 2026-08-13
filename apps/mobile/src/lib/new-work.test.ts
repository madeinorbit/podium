import { describe, expect, it } from 'vitest'
import { reposOnMachine } from './new-work'

describe('reposOnMachine', () => {
  const podium = { name: 'podium', machines: [{ machineId: 'local' }] }
  const shared = {
    name: 'shared',
    machines: [{ machineId: 'local' }, { machineId: 'studio' }],
  }
  const localOnly = { name: 'notes', machines: undefined }

  it('returns every repo when there is only one machine', () => {
    expect(reposOnMachine([podium, shared, localOnly], 'local', 1)).toEqual([
      podium,
      shared,
      localOnly,
    ])
  })

  it('keeps unscoped repos and those that list the selected host', () => {
    expect(reposOnMachine([podium, shared, localOnly], 'studio', 2)).toEqual([shared, localOnly])
  })

  it('does not filter when no machine is selected', () => {
    expect(reposOnMachine([podium, shared], null, 2)).toEqual([podium, shared])
  })
})

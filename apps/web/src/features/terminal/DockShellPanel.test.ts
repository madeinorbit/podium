import { describe, expect, it } from 'vitest'
import { resolveShellMachineLabel } from './DockShellPanel'

const machines = [
  { id: 'machine-local', name: 'podium-host' },
  { id: 'machine-remote', name: 'build-box' },
]

describe('resolveShellMachineLabel', () => {
  it('prefers the running session machine name over the requested target', () => {
    expect(
      resolveShellMachineLabel(
        { machineId: 'machine-remote', machineName: 'remote.example' },
        machines,
        'machine-local',
      ),
    ).toBe('remote.example')
  })

  it('shows the requested machine name while session metadata is arriving', () => {
    expect(resolveShellMachineLabel(undefined, machines, 'machine-local')).toBe('podium-host')
  })

  it('falls back to the stable machine id when no display name is known', () => {
    expect(resolveShellMachineLabel({ machineId: 'unlisted' }, machines)).toBe('unlisted')
  })
})

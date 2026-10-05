import type { GitRepositoryWire, MachineWire } from '@podium/model'
import { asMachineId } from '@podium/model'
import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { renderWithMobileStore } from '../client/test-support'
import { AUTO } from '../lib/agent-models'
import type { LaunchConfiguration } from '../lib/launch-configuration'
import * as sheets from './ActionSheet'
import { LaunchConfigurationFields } from './LaunchConfigurationFields'

const state = vi.hoisted(() => ({ repos: [] as GitRepositoryWire[], machines: [] as MachineWire[] }))
vi.mock('../client/use-launch-inputs', () => ({ useLaunchInputs: () => state }))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
  useSafeAreaFrame: () => ({ x: 0, y: 0, width: 430, height: 900 }),
}))
afterEach(() => { cleanup(); vi.restoreAllMocks(); state.repos = []; state.machines = [] })

it('requests no fallback menu while closed at 1x/4x and builds only the opened picker', async () => {
  for (const scale of [1, 4] as const) {
    state.repos = [{ kind: 'repository', path: '/synthetic', branch: 'main', originUrl: 'https://example.test/project', worktrees: [] }]
    state.machines = Array.from({ length: 128 * scale }, (_, n) => ({
      id: asMachineId(`machine-${n}`), name: `Machine ${n}`, online: true,
      serviceAssignment: { server: false, agentExecution: true }, availability: { daemon: true },
      inventory: { agents: [{ kind: 'claude-code', installed: true }, { kind: 'codex', installed: true }] },
    } as MachineWire))
    const sheet = vi.spyOn(sheets, 'ActionSheet').mockImplementation(() => null)
    const onChange = vi.fn()
    const value: LaunchConfiguration = { agentKind: 'claude-code', modelPick: AUTO, effort: AUTO, machineId: '' }
    let changeAgent = () => {}
    function Harness() {
      const [current, setCurrent] = useState(value)
      changeAgent = () => setCurrent((previous) => ({ ...previous, agentKind: 'codex' }))
      return <LaunchConfigurationFields repoPath="/synthetic" value={current} onChange={(next) => { onChange(next); setCurrent(next) }} />
    }
    const view = await renderWithMobileStore(<Harness />)
    try {
      expect(sheet).not.toHaveBeenCalled()
      fireEvent.click(screen.getByRole('button', { name: 'Machine, Auto' }))
      expect(sheet).toHaveBeenCalled()
      expect(sheet.mock.calls.every(([props]) => props.title === 'Machine')).toBe(true)
      const opened = sheet.mock.lastCall?.[0]
      expect(opened?.visible).toBe(true)
      expect(opened?.actions).toHaveLength(128 * scale + 1)
      expect(opened?.actions[1]?.label).toBe('Machine 0')
      expect(opened?.actions[1]?.disabled).toBe(false)
      act(() => opened?.actions[1]?.onPress())
      expect(onChange).toHaveBeenCalledWith({ ...value, machineId: 'machine-0' })
      // The sheet calls its host only after dismissal completes. Releasing
      // demand here preserves that existing deferred-action contract.
      act(() => opened?.onClose())
      sheet.mockClear()
      act(changeAgent)
      expect(sheet).not.toHaveBeenCalled()
      fireEvent.click(screen.getByRole('button', { name: /^Agent, / }))
      expect(sheet.mock.calls.every(([props]) => props.title === 'Agent')).toBe(true)
      expect(sheet.mock.lastCall?.[0].actions.length).toBeLessThan(10)
    } finally { view.unmount(); sheet.mockRestore() }
  }
})

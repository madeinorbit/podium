import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { setupFixture } from '../../harness/agent-setup-fixture'
import { AgentSetupPickerEntry, installingAgentsHint } from './AgentSetupPickerEntry'

vi.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: { Light: 'light' },
  impactAsync: async () => {},
}))
afterEach(cleanup)
it('keeps setup distinct from agent choices and shows the live installing hint', () => {
  const open = vi.fn()
  const fixture = setupFixture()
  fixture.machine.patch('grok', { install: { managed: { paused: false, installing: {} } } })
  const hint = installingAgentsHint([fixture.view])
  render(<AgentSetupPickerEntry hint={hint} onPress={open} />)
  expect(screen.getByText('2 installing')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Set up agents…' }))
  expect(open).toHaveBeenCalledOnce()
  expect(installingAgentsHint([])).toBeUndefined()
})

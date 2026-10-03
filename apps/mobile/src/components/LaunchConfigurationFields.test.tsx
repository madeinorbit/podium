import { cleanup, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { renderWithMobileStore } from '../client/test-support'
import { AUTO } from '../lib/agent-models'
import type { LaunchPlan } from '../lib/launch-configuration'
import { LaunchConfigurationFields } from './LaunchConfigurationFields'

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
  useSafeAreaFrame: () => ({ x: 0, y: 0, width: 430, height: 900 }),
}))
afterEach(cleanup)

it('renders new-task launch controls before any machine is available', async () => {
  let plan: LaunchPlan | undefined
  await renderWithMobileStore(
    <LaunchConfigurationFields
      repoPath="/synthetic"
      value={{ agentKind: 'claude-code', modelPick: AUTO, effort: AUTO, machineId: '' }}
      onChange={() => {}}
      onPlan={(next) => {
        plan = next
      }}
    />,
  )
  expect(screen.getByText('Agent', { exact: true })).toBeTruthy()
  expect(screen.getByText('Model', { exact: true })).toBeTruthy()
  expect(screen.getByText('Machine', { exact: true })).toBeTruthy()
  expect(plan?.configuration.agentKind).toBe('claude-code')
})

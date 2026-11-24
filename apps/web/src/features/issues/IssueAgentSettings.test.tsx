import '@/test-support/mock-store-action-ports'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { observable, runInAction } from 'mobx'
import { afterEach, expect, it, vi } from 'vitest'
import { closeSetupAgents, setupAgentsRequest } from '@/features/setup-agents/open-setup-agents'
import { makeIssue } from '@/lib/test-issue'
import { modelCatalogFixture } from '@/test-support/model-catalog-mock'
import { IssueAgentSettings } from './IssueAgentSettings'

const state = vi.hoisted(() => ({
  updateIssue: vi.fn(async () => {}),
  settings: undefined as { codingHarness: string } | undefined,
}))
vi.mock('@/lib/my-preferences', () => ({
  useMyCodingHarness: () => state.settings?.codingHarness,
}))
vi.mock('@/app/store', () => ({
  readFixture: (select: (store: unknown) => unknown) =>
    select({ updateIssue: state.updateIssue, trpc: {} }),
}))
vi.mock('./use-agent-fleet-options', () => ({
  useAgentFleet: () => ({
    options: [],
    machines: [{ id: 'machine-a', name: 'Workstation' }],
    setupMachines: [{ id: 'machine-a', name: 'Workstation' }],
  }),
}))
afterEach(() => {
  cleanup()
  closeSetupAgents()
  modelCatalogFixture.current = {}
  state.settings = undefined
  vi.clearAllMocks()
})

it('follows my coding harness for auto and pins it with a chosen model', async () => {
  state.settings = observable({ codingHarness: 'claude-code' })
  modelCatalogFixture.current = {
    codex: [{ value: 'reported-codex', label: 'Reported Codex', efforts: ['high'] }],
  }
  const issue = makeIssue({ defaultAgent: 'auto', defaultModel: 'auto' })
  render(<IssueAgentSettings issue={issue} machines={[]} />)
  expect(screen.getByRole('button', { name: 'Agent' }).textContent).toContain('Claude Code')
  act(() =>
    runInAction(() => {
      state.settings!.codingHarness = 'codex'
    }),
  )
  expect(screen.getByRole('button', { name: 'Agent' }).textContent).toContain('Codex')
  fireEvent.click(screen.getByRole('button', { name: 'Model' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Reported Codex' }))
  await waitFor(() =>
    expect(state.updateIssue).toHaveBeenCalledWith(issue.id, {
      defaultAgent: 'codex',
      defaultModel: 'reported-codex',
    }),
  )
})

it('keeps an explicit issue harness authoritative over my coding harness', () => {
  state.settings = { codingHarness: 'codex' }
  render(<IssueAgentSettings issue={makeIssue({ defaultAgent: 'claude-code' })} machines={[]} />)
  expect(screen.getByRole('button', { name: 'Agent' }).textContent).toContain('Claude Code')
})

it('offers no Use option in the planned-agent menu', async () => {
  render(<IssueAgentSettings issue={makeIssue({ defaultAgent: 'claude-code' })} machines={[]} />)
  fireEvent.click(screen.getByRole('button', { name: 'Model' }))
  fireEvent.change(await screen.findByPlaceholderText('Filter…'), {
    target: { value: 'my-custom-model' },
  })
  expect(screen.queryByRole('menuitem', { name: /Use / })).toBeNull()
})

it('shows the stored effort inert until the machine lists levels for this model', () => {
  render(
    <IssueAgentSettings
      issue={makeIssue({
        defaultAgent: 'claude-code',
        defaultModel: 'stored',
        defaultEffort: 'high',
      })}
      machines={[]}
    />,
  )
  const pill = screen.getByRole('button', { name: 'Effort' }) as HTMLButtonElement
  expect(pill.disabled).toBe(true)
  expect(pill.textContent).toContain('High')
})

it('selects the setup result as the planned agent without starting a session', async () => {
  const issue = makeIssue({ defaultAgent: 'claude-code' })
  render(<IssueAgentSettings issue={issue} machines={[]} />)
  fireEvent.click(screen.getByRole('button', { name: 'Agent' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Set up agents…' }))
  expect(state.updateIssue).not.toHaveBeenCalled()
  expect(setupAgentsRequest()?.machineId).toBe('machine-a')
  act(() => setupAgentsRequest()?.onStart?.('codex'))
  await waitFor(() =>
    expect(state.updateIssue).toHaveBeenCalledWith(issue.id, {
      defaultAgent: 'codex',
    }),
  )
})

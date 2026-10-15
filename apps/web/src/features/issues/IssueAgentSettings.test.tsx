import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { observable, runInAction } from 'mobx'
import { afterEach, expect, it, vi } from 'vitest'
import { makeIssue } from '@/lib/test-issue'
import { modelCatalogFixture } from '@/test-support/model-catalog-mock'
import { IssueAgentSettings } from './IssueAgentSettings'

const state = vi.hoisted(() => ({ updateIssue: vi.fn(async () => {}), settings: undefined as { codingHarness: string } | undefined }))
vi.mock('@/features/settings/record-readers', () => ({ useSettingsRecord: () => ({ model: state.settings }) }))
vi.mock('@/app/store', () => ({
  useRuntimeSelector: (select: (store: unknown) => unknown) => select({ updateIssue: state.updateIssue, trpc: {} }),
}))
vi.mock('./use-agent-fleet-options', () => ({ useAgentFleetOptions: () => [] }))
afterEach(() => { cleanup(); modelCatalogFixture.current = {}; state.settings = undefined; vi.clearAllMocks() })

it('follows the Settings harness for auto and pins it with a chosen model', async () => {
  state.settings = observable({ codingHarness: 'claude-code' })
  modelCatalogFixture.current = { codex: [{ value: 'reported-codex', label: 'Reported Codex', efforts: ['high'] }] }
  const issue = makeIssue({ defaultAgent: 'auto', defaultModel: 'auto' })
  render(<IssueAgentSettings issue={issue} machines={[]} />)
  expect(screen.getByRole('button', { name: 'Agent' }).textContent).toContain('Claude Code')
  act(() => runInAction(() => { state.settings!.codingHarness = 'codex' }))
  expect(screen.getByRole('button', { name: 'Agent' }).textContent).toContain('Codex')
  fireEvent.click(screen.getByRole('button', { name: 'Model' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Reported Codex' }))
  await waitFor(() => expect(state.updateIssue).toHaveBeenCalledWith(issue.id, {
    defaultAgent: 'codex', defaultModel: 'reported-codex',
  }))
})

it('keeps an explicit issue harness authoritative over Settings', () => {
  state.settings = { codingHarness: 'codex' }
  render(<IssueAgentSettings issue={makeIssue({ defaultAgent: 'claude-code' })} machines={[]} />)
  expect(screen.getByRole('button', { name: 'Agent' }).textContent).toContain('Claude Code')
})

it('offers no Use option in the planned-agent menu', async () => {
  render(<IssueAgentSettings issue={makeIssue({ defaultAgent: 'claude-code' })} machines={[]} />)
  fireEvent.click(screen.getByRole('button', { name: 'Model' }))
  fireEvent.change(await screen.findByPlaceholderText('Filter…'), { target: { value: 'my-custom-model' } })
  expect(screen.queryByRole('menuitem', { name: /Use / })).toBeNull()
})

it('shows the stored effort inert until the machine lists levels for this model', () => {
  render(<IssueAgentSettings issue={makeIssue({ defaultAgent: 'claude-code', defaultModel: 'stored', defaultEffort: 'high' })} machines={[]} />)
  const pill = screen.getByRole('button', { name: 'Effort' }) as HTMLButtonElement
  expect(pill.disabled).toBe(true)
  expect(pill.textContent).toContain('High')
})

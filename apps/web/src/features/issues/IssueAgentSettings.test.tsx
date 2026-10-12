import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeIssue } from '@/lib/test-issue'
import { modelCatalogFixture } from '@/test-support/model-catalog-mock'
import { IssueAgentSettings } from './IssueAgentSettings'

vi.mock('@/app/store', () => ({
  useRuntimeSelector: (select: (store: unknown) => unknown) => select({ updateIssue: vi.fn(async () => {}) }),
}))
vi.mock('./use-agent-fleet-options', () => ({ useAgentFleetOptions: () => [] }))
afterEach(() => { cleanup(); modelCatalogFixture.current = {} })

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

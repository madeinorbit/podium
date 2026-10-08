import type { WorkflowDetailWire } from '@podium/protocol'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkflowLibrary } from './WorkflowLibrary'
import type { WorkflowsSource } from './use-workflows'
import { OPERATOR_WORKFLOW_RIGHTS, workflowCommands } from './workflow-commands'

afterEach(cleanup)

function step(title: string) {
  return { id: title, title, instructions: '', completionGuidance: '' }
}

function detail(
  version: number,
  instructions = `Instructions ${version}`,
  steps: WorkflowDetailWire['revisions'][number]['steps'] = [step(`Step ${version}`)],
  id = 'workflow',
): WorkflowDetailWire {
  return {
    workflow: {
      id,
      name: 'Workflow',
      description: '',
      scope: 'global',
      scopeRef: null,
      latestRevisionId: `${id}-rev-${version}`,
      latestVersion: version,
      archivedAt: null,
      createdAt: '2026-10-09T00:00:00.000Z',
      updatedAt: '2026-10-09T00:00:00.000Z',
    },
    revisions: [
      {
        id: `${id}-rev-${version}`,
        workflowId: id,
        version,
        instructions,
        steps,
        createdAt: '2026-10-09T00:00:00.000Z',
        publishedAt: null,
      },
    ],
  }
}

function source(
  detail: WorkflowDetailWire,
  dispatch = vi.fn<WorkflowsSource['dispatch']>().mockResolvedValue(true),
): WorkflowsSource {
  return {
    workflows: [detail.workflow],
    detail,
    selectedId: detail.workflow.id,
    bindings: [],
    profiles: [],
    runs: [],
    loading: false,
    refreshing: false,
    error: null,
    notice: null,
    showHistory: false,
    select: vi.fn(),
    setShowHistory: vi.fn(),
    refresh: vi.fn(),
    dispatch,
  }
}

function editor(
  initial = detail(1),
  dispatch = vi.fn<WorkflowsSource['dispatch']>().mockResolvedValue(true),
) {
  const view = render(
    <WorkflowLibrary source={source(initial, dispatch)} rights={OPERATOR_WORKFLOW_RIGHTS} />,
  )
  return {
    dispatch,
    update(next: WorkflowDetailWire) {
      view.rerender(
        <WorkflowLibrary source={source(next, dispatch)} rights={OPERATOR_WORKFLOW_RIGHTS} />,
      )
    },
    get instructions() {
      return screen.getByRole('textbox', { name: 'Instructions (Markdown)' }) as HTMLTextAreaElement
    },
    get steps() {
      return screen.getByRole('textbox', { name: 'Ordered steps (JSON)' }) as HTMLTextAreaElement
    },
  }
}

describe('workflow editor version conflicts', () => {
  it('keeps both unsaved texts and offers saving them as the next version', async () => {
    const view = editor()
    fireEvent.change(view.instructions, { target: { value: 'My instructions' } })
    const mine = JSON.stringify([step('My step')])
    fireEvent.change(view.steps, { target: { value: mine } })
    view.update(detail(2))

    expect(view.instructions.value).toBe('My instructions')
    expect(view.steps.value).toBe(mine)
    expect(screen.getByRole('status').textContent).toContain('Version 2 was saved meanwhile')
    expect(screen.queryByRole('button', { name: 'Create revision' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Save mine as the next version' }))

    await waitFor(() =>
      expect(view.dispatch).toHaveBeenCalledWith(workflowCommands.revise, {
        workflowId: 'workflow',
        instructions: 'My instructions',
        steps: [step('My step')],
      }),
    )
    view.update(detail(3, 'My instructions', [step('My step')]))
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
    expect(view.instructions.value).toBe('My instructions')
    view.update(detail(4))
    expect(view.instructions.value).toBe('Instructions 4')
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('discards both texts and loads the latest new version without a write', () => {
    const view = editor()
    fireEvent.change(view.instructions, { target: { value: 'Mine' } })
    fireEvent.change(view.steps, { target: { value: 'unfinished JSON' } })
    view.update(detail(2))
    view.update(detail(3))

    expect(screen.getByRole('status').textContent).toContain('Version 3 was saved meanwhile')
    fireEvent.click(screen.getByRole('button', { name: 'Discard mine and load version 3' }))
    expect(view.instructions.value).toBe('Instructions 3')
    expect(view.steps.value).toBe(JSON.stringify([step('Step 3')], null, 2))
    expect(view.dispatch).not.toHaveBeenCalled()
    expect(screen.queryByRole('status')).toBeNull()
    view.update(detail(4))
    expect(view.instructions.value).toBe('Instructions 4')
    expect(view.steps.value).toBe(JSON.stringify([step('Step 4')], null, 2))
  })

  it('silently follows a new version when neither field has been edited', () => {
    const view = editor()
    view.update(detail(2))
    expect(view.instructions.value).toBe('Instructions 2')
    expect(view.steps.value).toBe(JSON.stringify([step('Step 2')], null, 2))
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Save mine as the next version' })).toBeNull()
  })

  it('keeps both buffers when only steps are dirty', () => {
    const view = editor()
    fireEvent.change(view.steps, { target: { value: '["my step"]' } })
    view.update(detail(2))
    expect(view.instructions.value).toBe('Instructions 1')
    expect(view.steps.value).toBe('["my step"]')
    expect(screen.getByRole('status')).toBeTruthy()
  })

  it('keeps the draft and conflict choices after a refused save', async () => {
    const dispatch = vi.fn<WorkflowsSource['dispatch']>().mockResolvedValue(false)
    const view = editor(detail(1), dispatch)
    fireEvent.change(view.instructions, { target: { value: 'Mine' } })
    view.update(detail(2))
    fireEvent.click(screen.getByRole('button', { name: 'Save mine as the next version' }))
    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(
        screen
          .getByRole('button', { name: 'Save mine as the next version' })
          .hasAttribute('disabled'),
      ).toBe(false),
    )
    expect(view.instructions.value).toBe('Mine')
    expect(screen.getByRole('button', { name: 'Discard mine and load version 2' })).toBeTruthy()
  })

  it('does not replace typing on a same-head refresh or publish', () => {
    const view = editor()
    fireEvent.change(view.instructions, { target: { value: 'Mine' } })
    const published = detail(1)
    published.revisions[0]!.publishedAt = '2026-10-09T01:00:00.000Z'
    view.update(published)
    expect(view.instructions.value).toBe('Mine')
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('opens a fresh draft when switching workflows', () => {
    const view = editor()
    fireEvent.change(view.instructions, { target: { value: 'Mine' } })
    view.update(detail(2))
    view.update(detail(1, 'Another workflow', [], 'other-workflow'))
    expect(view.instructions.value).toBe('Another workflow')
    expect(view.steps.value).toBe('[]')
    expect(screen.queryByRole('status')).toBeNull()
  })
})

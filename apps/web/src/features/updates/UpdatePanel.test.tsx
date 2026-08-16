import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UpdatePanelView } from './operation-view'
import { UpdatePanel } from './UpdatePanel'

afterEach(cleanup)

const RUNNING: UpdatePanelView = {
  state: 'running',
  title: 'Podium 0.4.3 is being applied',
  subtitle: 'Updating your machines',
  operationId: 'op_1',
  version: '0.4.3',
  steps: [
    { id: 'prepare', title: 'Preparing the update', state: 'done' },
    {
      id: 'machines',
      title: 'Updating your machines',
      state: 'current',
      substatus: '1 of 3 · vmi3407763 downloading 62%',
    },
    { id: 'server', title: 'Updating your server', state: 'pending' },
  ],
  stepPosition: { current: 2, total: 3 },
  liveness: 'Running for 30 s',
  cancel: { label: 'Cancel', operationId: 'op_1' },
  awaitingElsewhere: [],
  indicator: 'animating',
  indicatorLabel: 'Update running: step 2 of 3',
}

describe('UpdatePanel', () => {
  it('renders the checklist, the step counter and the liveness line', () => {
    render(<UpdatePanel view={RUNNING} pending={null} onAction={vi.fn()} onHide={vi.fn()} />)

    expect(screen.getByText('Podium 0.4.3 is being applied')).toBeTruthy()
    expect(screen.getByText('Preparing the update')).toBeTruthy()
    expect(screen.getByText('1 of 3 · vmi3407763 downloading 62%')).toBeTruthy()
    expect(screen.getByTestId('update-liveness').textContent).toBe('Step 2 of 3 · Running for 30 s')
  })

  /** One dismiss verb, in every state (§6.1) — the old dialog had four labels. */
  it('says Hide and only Hide, whatever the state', () => {
    for (const state of ['offer', 'running', 'waiting-you', 'done', 'failed'] as const) {
      cleanup()
      render(
        <UpdatePanel
          view={{ ...RUNNING, state, title: state }}
          pending={null}
          onAction={vi.fn()}
          onHide={vi.fn()}
        />,
      )
      expect(screen.getByRole('button', { name: 'Hide' })).toBeTruthy()
      expect(screen.queryByRole('button', { name: /later|dismiss|^ok$/i })).toBeNull()
    }
  })

  it('renders exactly one primary action', () => {
    render(
      <UpdatePanel
        view={{
          ...RUNNING,
          state: 'waiting-you',
          cancel: undefined,
          primary: {
            kind: 'reload',
            label: 'Reload',
            pendingLabel: 'Reloading…',
            consequence: 'Reloads this page, about 2 seconds; your sessions keep running.',
          },
        }}
        pending={null}
        onAction={vi.fn()}
        onHide={vi.fn()}
      />,
    )
    expect(screen.getByTestId('update-primary').textContent).toContain('Reload')
    expect(screen.getByText(/about 2 seconds/)).toBeTruthy()
  })

  it('dispatches the primary action’s kind, not a button identity', () => {
    const onAction = vi.fn()
    render(
      <UpdatePanel
        view={{
          ...RUNNING,
          state: 'failed',
          primary: { kind: 'retry', label: 'Try again', pendingLabel: 'Trying again…' },
          error: {
            message: 'vmi has local edits that prevent a safe update.',
            nextAction: 'Commit or stash them there, then try again.',
            detail: 'code: machine-dirty-checkout\noperation: op_1',
          },
        }}
        pending={null}
        onAction={onAction}
        onHide={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByTestId('update-primary'))
    expect(onAction).toHaveBeenCalledWith('retry')
  })

  /** P7: what happened, the one next action, and detail folded away. */
  it('renders a failure in three layers with the technical detail collapsed', () => {
    render(
      <UpdatePanel
        view={{
          ...RUNNING,
          state: 'failed',
          title: 'Podium update failed',
          error: {
            message: 'The update could not be downloaded.',
            nextAction: "Check the server's connection, then try again.",
            detail: 'code: download-failed\noperation: op_1',
          },
        }}
        pending={null}
        onAction={vi.fn()}
        onHide={vi.fn()}
      />,
    )

    expect(screen.getByText('The update could not be downloaded.')).toBeTruthy()
    expect(screen.getByText("Check the server's connection, then try again.")).toBeTruthy()
    const details = screen.getByText('Technical details').closest('details')
    expect(details?.hasAttribute('open')).toBe(false)
    expect(details?.textContent).toContain('operation: op_1')
  })

  it('renders another surface’s ask as a sentence, never as a button', () => {
    render(
      <UpdatePanel
        view={{
          ...RUNNING,
          state: 'waiting-elsewhere',
          cancel: undefined,
          primary: undefined,
          awaitingElsewhere: ['Waiting for Podium Desktop on macbook'],
        }}
        pending={null}
        onAction={vi.fn()}
        onHide={vi.fn()}
      />,
    )
    expect(screen.getByText('Waiting for Podium Desktop on macbook')).toBeTruthy()
    expect(screen.queryByTestId('update-primary')).toBeNull()
  })

  it('renders nothing at all in the none state', () => {
    const { container } = render(
      <UpdatePanel
        view={{
          state: 'none',
          title: '',
          steps: [],
          awaitingElsewhere: [],
          indicator: 'none',
          indicatorLabel: '',
        }}
        pending={null}
        onAction={vi.fn()}
        onHide={vi.fn()}
      />,
    )
    expect(container.firstChild).toBeNull()
  })
})

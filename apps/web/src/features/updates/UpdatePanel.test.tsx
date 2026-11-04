import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UpdatePanelView } from './operation-view'
import { UpdateIndicator } from './UpdateIndicator'
import { UpdatePanel, versionLine } from './UpdatePanel'

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

  /** One dismiss button in every state (§6.1): Later while there is more to come, Close once it is over. */
  it('says Later, or Close once the update is over, and nothing else', () => {
    for (const state of ['offer', 'running', 'waiting-you', 'done', 'failed'] as const) {
      cleanup()
      const onHide = vi.fn()
      render(
        <UpdatePanel
          view={{ ...RUNNING, state, title: state }}
          pending={null}
          onAction={vi.fn()}
          onHide={onHide}
        />,
      )
      const label = state === 'done' || state === 'failed' ? 'Close' : 'Later'
      fireEvent.click(screen.getByRole('button', { name: label }))
      expect(onHide).toHaveBeenCalledTimes(1)
      expect(screen.queryByRole('button', { name: /^hide$|dismiss|^ok$/i })).toBeNull()
    }
  })

  it('shows a dev build version as version and commit on its own line', () => {
    render(
      <UpdatePanel
        view={{ ...RUNNING, version: '0.2.1-dev.76+bcca0ff' }}
        pending={null}
        onAction={vi.fn()}
        onHide={vi.fn()}
      />,
    )
    expect(screen.getByTestId('update-version').textContent).toBe('0.2.1-dev.76 · bcca0ff')
    expect(versionLine('0.4.3')).toBe('0.4.3')
  })

  it('lists places with their host and an impact a screen reader can hear', () => {
    render(
      <UpdatePanel
        view={{
          ...RUNNING,
          state: 'offer',
          steps: [],
          places: [
            { kind: 'this-app', label: 'This tab', effect: 'Reloads', impact: 'interrupts' },
            {
              kind: 'server',
              label: 'Server',
              detail: 'ludovico',
              effect: 'Restarts',
              impact: 'interrupts',
            },
            { kind: 'machines', label: 'vmi3431366', effect: 'Updates in the background' },
          ],
        }}
        pending={null}
        onAction={vi.fn()}
        onHide={vi.fn()}
      />,
    )
    const rows = screen.getAllByRole('listitem')
    expect(rows.map((row) => row.getAttribute('data-impact'))).toEqual([
      'interrupts',
      'interrupts',
      'background',
    ])
    expect(rows[1]?.textContent).toBe('ServerludovicoInterrupts briefly: Restarts')
    expect(rows[2]?.textContent).toBe('vmi3431366Background only: Updates in the background')
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

  it('says what to do in the strip once only this surface is behind', () => {
    render(
      <UpdateIndicator state="ready" label="Reload to update" open={false} onToggle={vi.fn()} />,
    )
    expect(screen.getByTestId('update-indicator').textContent).toBe('Reload to update')
  })

  describe('ready card', () => {
    const READY: UpdatePanelView = {
      ...RUNNING,
      state: 'waiting-you',
      title: 'Podium 0.3.0 is ready',
      version: '0.3.0',
      steps: [],
      cancel: undefined,
      primary: { kind: 'reload', label: 'Reload', pendingLabel: 'Reloading…' },
    }

    function renderReady(notes?: { summary?: string; url?: string }) {
      const onHide = vi.fn()
      render(
        <UpdatePanel
          view={{ ...READY, ...(notes ? { notes } : {}) }}
          pending={null}
          onAction={vi.fn()}
          onHide={onHide}
        />,
      )
      return onHide
    }

    it('keeps the notes folded behind What’s new until asked', () => {
      renderReady({ summary: '**Calmer chat.**' })
      const toggle = screen.getByTestId('update-whats-new')
      expect(toggle.getAttribute('aria-expanded')).toBe('false')
      expect(screen.queryByTestId('update-notes')).toBeNull()

      fireEvent.click(toggle)
      expect(toggle.getAttribute('aria-expanded')).toBe('true')
      expect(screen.getByTestId('update-notes').textContent).toContain('Calmer chat.')
    })

    it('links out when a release has only a page', () => {
      renderReady({ url: 'https://example.test/v0.3.0' })
      expect(screen.getByTestId('update-whats-new').getAttribute('href')).toBe(
        'https://example.test/v0.3.0',
      )
    })

    it('still offers Later with no notes, and does not repeat the version', () => {
      const onHide = renderReady()
      expect(screen.queryByTestId('update-whats-new')).toBeNull()
      expect(screen.queryByTestId('update-version')).toBeNull()
      fireEvent.click(screen.getByText('Later'))
      expect(onHide).toHaveBeenCalledOnce()
    })
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

  it('shows service-worker evidence and offers an explicit cache reset', () => {
    const reset = vi.fn()
    render(
      <UpdatePanel
        view={{ ...RUNNING, state: 'waiting-you', cancel: undefined }}
        pending={null}
        onAction={vi.fn()}
        onHide={vi.fn()}
        reloadStatus={{
          phase: 'no-replacement',
          message: 'No replacement interface was found.',
          detail: 'The registration update check found no replacement.',
          canReset: true,
          snapshot: { available: true, controlled: true, active: 'activated' },
        }}
        onResetCachedInterface={reset}
      />,
    )
    expect(screen.getByTestId('service-worker-status')).toBeTruthy()
    fireEvent.click(screen.getByTestId('reset-cached-interface'))
    expect(reset).toHaveBeenCalledTimes(1)
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

const NOTES = `**One flight deck for the whole mission.**

### What's new

- **Flight deck.** The whole mission in one view.
- **Agent profiles.** Pick one for a task.`

describe('UpdatePanel release notes', () => {
  it('renders the changelog Markdown instead of printing its syntax', () => {
    render(
      <UpdatePanel
        view={{ ...RUNNING, notes: { summary: NOTES } }}
        pending={null}
        onAction={vi.fn()}
        onHide={vi.fn()}
      />,
    )
    const notes = screen.getByTestId('update-notes')
    expect(notes.textContent).not.toContain('**')
    expect(notes.textContent).not.toContain('###')
    expect(notes.querySelectorAll('li')).toHaveLength(2)
    expect(notes.querySelector('h3')?.textContent).toBe("What's new")
    expect(notes.querySelector('strong')?.textContent).toBe(
      'One flight deck for the whole mission.',
    )
  })

  it('links a stable release to its page, and offers no toggle while everything fits', () => {
    render(
      <UpdatePanel
        view={{
          ...RUNNING,
          notes: {
            summary: NOTES,
            url: 'https://github.com/madeinorbit/podium/releases/tag/v0.3.0',
          },
        }}
        pending={null}
        onAction={vi.fn()}
        onHide={vi.fn()}
      />,
    )
    const link = screen.getByTestId('update-notes-link') as HTMLAnchorElement
    expect(link.href).toBe('https://github.com/madeinorbit/podium/releases/tag/v0.3.0')
    expect(link.target).toBe('_blank')
    expect(screen.queryByTestId('update-notes-toggle')).toBeNull()
  })

  it('offers Show all when the notes are cut, and Show less once they are open', () => {
    const scrollHeight = vi
      .spyOn(HTMLElement.prototype, 'scrollHeight', 'get')
      .mockImplementation(function (this: HTMLElement) {
        return this.classList.contains('update-notes') ? 900 : 0
      })
    const clientHeight = vi
      .spyOn(HTMLElement.prototype, 'clientHeight', 'get')
      .mockImplementation(function (this: HTMLElement) {
        return this.classList.contains('update-notes') ? 120 : 0
      })
    try {
      render(
        <UpdatePanel
          view={{ ...RUNNING, notes: { summary: NOTES } }}
          pending={null}
          onAction={vi.fn()}
          onHide={vi.fn()}
        />,
      )
      const body = screen.getByTestId('update-notes').querySelector('.update-notes')
      expect(body?.getAttribute('data-cut')).toBe('true')
      const toggle = screen.getByTestId('update-notes-toggle')
      expect(toggle.textContent).toBe('Show all')
      fireEvent.click(toggle)
      expect(toggle.textContent).toBe('Show less')
      expect(toggle.getAttribute('aria-expanded')).toBe('true')
      expect(body?.getAttribute('data-open')).toBe('true')
      expect(screen.queryByTestId('update-notes-link')).toBeNull()
    } finally {
      scrollHeight.mockRestore()
      clientHeight.mockRestore()
    }
  })
})

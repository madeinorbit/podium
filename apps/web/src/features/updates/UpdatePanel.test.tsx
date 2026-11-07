// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdatePanelView } from './operation-view'
import { UpdatePanel, versionLine } from './UpdatePanel'

beforeEach(() => {
  window.matchMedia = vi
    .fn()
    .mockReturnValue({ matches: false, addEventListener() {}, removeEventListener() {} })
})
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
  freshness: 'Live · updated 2 s ago',
  dismiss: { label: 'Hide' },
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
    expect(screen.getByTestId('update-liveness').textContent).toBe('Live · updated 2 s ago')
    expect(screen.getByText('Step 2 of 3')).toBeTruthy()
  })

  /** One dismiss button in every state (§6.1): Later while there is more to come, Close once it is over. */
  it('renders the view model’s dismiss label and emphasis', () => {
    for (const state of ['offer', 'running', 'waiting-you', 'done', 'failed'] as const) {
      cleanup()
      const onHide = vi.fn()
      render(
        <UpdatePanel
          view={{
            ...RUNNING,
            state,
            title: state,
            dismiss: {
              label:
                state === 'done'
                  ? 'Got it'
                  : state === 'offer'
                    ? 'Later'
                    : state === 'failed'
                      ? 'Close'
                      : 'Hide',
              primary: state === 'done',
            },
          }}
          pending={null}
          onAction={vi.fn()}
          onHide={onHide}
        />,
      )
      const label =
        state === 'done'
          ? 'Got it'
          : state === 'offer'
            ? 'Later'
            : state === 'failed'
              ? 'Close'
              : 'Hide'
      fireEvent.click(screen.getByRole('button', { name: label }))
      expect(onHide).toHaveBeenCalledTimes(1)
    }
  })

  it('shows a dev build hash in the channel pill', () => {
    render(
      <UpdatePanel
        view={{
          ...RUNNING,
          state: 'offer',
          steps: [],
          channel: 'dev',
          title: 'Podium 0.2.1-dev.76',
          version: '0.2.1-dev.76+bcca0ff',
        }}
        pending={null}
        onAction={vi.fn()}
        onHide={vi.fn()}
      />,
    )
    expect(screen.getByText('bcca0ff').closest('.update-card-channel')?.textContent).toBe(
      'devbcca0ff',
    )
    expect(versionLine('0.2.1-dev.76+bcca0ff')).toBe('0.2.1-dev.76 · bcca0ff')
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
    const details = screen.getByRole('button', { name: 'Details' })
    expect(details.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('list', { name: 'Places affected by this update' })).toBeNull()
    fireEvent.click(details)
    const rows = screen.getAllByRole('listitem')
    expect(rows.map((row) => row.getAttribute('data-impact'))).toEqual([
      'interrupts',
      'interrupts',
      'background',
    ])
    expect(rows[1]?.textContent).toBe('ServerludovicoInterrupts briefly:  Restarts')
    expect(rows[2]?.textContent).toBe('vmi3431366Background only:  Updates in the background')
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
  const offer = {
    ...RUNNING,
    state: 'offer' as const,
    steps: [],
    cancel: undefined,
    notes: { summary: NOTES },
  }
  const props = { pending: null, onAction: vi.fn(), onHide: vi.fn() }

  it('leads with the bold paragraph, absorbs What’s new and preserves later plain sections', () => {
    render(
      <UpdatePanel
        {...props}
        view={{
          ...offer,
          notes: {
            summary: `${NOTES}\n\n### Upgrading from 0.2.0\n\n- Back up first.\n- [Read this](https://example.com).`,
          },
        }}
      />,
    )
    const notes = screen.getByTestId('update-notes')
    expect(
      screen.getByText('One flight deck for the whole mission.').closest('header'),
    ).toBeTruthy()
    expect(notes.textContent).not.toMatch(/\*\*|###/)
    expect([...notes.querySelectorAll('dt')].map((el) => el.textContent)).toEqual([
      'Flight deck',
      'Agent profiles',
    ])
    expect(notes.querySelector('dd')?.textContent).toBe('The whole mission in one view.')
    expect(notes.querySelectorAll('h3')).toHaveLength(1)
    expect(notes.querySelector('h3')?.textContent).toBe('Upgrading from 0.2.0')
    expect(notes.querySelectorAll('ul > li')).toHaveLength(2)
    expect(notes.querySelector('a')).toBeNull()
  })

  it('keeps mixed unlabelled bullets in order and sanitizes the lede and descriptions', () => {
    render(
      <UpdatePanel
        {...props}
        view={{
          ...offer,
          notes: {
            summary:
              '**A [calmer](https://example.com) update.**\n\n### What’s new\n\n- **First.** Safe <script>alert(1)</script> text.\n- Plain bullet.\n- **Last.** More `code`.',
          },
        }}
      />,
    )
    const notes = screen.getByTestId('update-notes')
    expect(notes.querySelector('script, a')).toBeNull()
    expect(screen.getByTestId('update-panel').querySelector('header a')).toBeNull()
    expect(
      [...(notes.querySelector('.update-notes')?.children ?? [])].map((el) => el.tagName),
    ).toEqual(['DL', 'UL', 'DL'])
    expect(notes.querySelector('code')?.textContent).toBe('code')
  })

  it('shows a release-page link only when the notes have a URL', () => {
    const { rerender } = render(<UpdatePanel {...props} view={offer} />)
    expect(screen.queryByTestId('update-notes-link')).toBeNull()
    rerender(
      <UpdatePanel
        {...props}
        view={{ ...offer, notes: { summary: NOTES, url: 'https://example.com/release' } }}
      />,
    )
    expect((screen.getByTestId('update-notes-link') as HTMLAnchorElement).href).toBe(
      'https://example.com/release',
    )
    expect(screen.queryByText('Show all')).toBeNull()
  })

  it('keeps running notes behind one disclosure', () => {
    render(<UpdatePanel {...props} view={{ ...RUNNING, notes: { summary: NOTES } }} />)
    expect(screen.queryByTestId('update-notes')).toBeNull()
    const peek = screen.getByRole('button', { name: "What's new in 0.4.3" })
    fireEvent.click(peek)
    expect(peek.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByTestId('update-notes').textContent).toContain('Flight deck')
    fireEvent.click(peek)
    expect(screen.queryByTestId('update-notes')).toBeNull()
  })

  it('updates fades at both scroll edges and reports reading once notes scroll', () => {
    const scrollHeight = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(900)
    const clientHeight = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(120)
    try {
      const reading = vi.fn()
      render(
        <UpdatePanel {...props} view={{ ...offer, state: 'done' }} onReadingChange={reading} />,
      )
      const box = screen
        .getByTestId('update-notes')
        .querySelector('.update-card-scroll') as HTMLElement
      expect(box.dataset.atTop).toBe('true')
      expect(box.dataset.atEnd).toBe('false')
      fireEvent.scroll(box, { target: { scrollTop: 450 } })
      expect(box.dataset.atTop).toBe('false')
      expect(box.dataset.atEnd).toBe('false')
      expect(reading).toHaveBeenLastCalledWith(true)
      fireEvent.scroll(box, { target: { scrollTop: 780 } })
      expect(box.dataset.atEnd).toBe('true')
      fireEvent.scroll(box, { target: { scrollTop: 0 } })
      expect(reading).toHaveBeenLastCalledWith(true)
    } finally {
      scrollHeight.mockRestore()
      clientHeight.mockRestore()
    }
  })

  it('defaults dev offers to newest-first commits, shows the remainder and supports keyboard tabs', () => {
    render(
      <UpdatePanel
        {...props}
        view={{
          ...offer,
          channel: 'dev',
          commits: [
            { sha: 'abcdef1234', summary: 'Newest full commit summary' },
            { sha: '1234567890', summary: 'Previous' },
          ],
          commitCount: 203,
        }}
      />,
    )
    expect(screen.getByRole('tab', { name: 'Commits (203)' }).getAttribute('aria-selected')).toBe(
      'true',
    )
    const rows = screen.getAllByRole('listitem')
    expect(rows[0]?.textContent).toBe('abcdef1Newest full commit summary')
    expect(rows[0]?.title).toContain('Newest full commit summary')
    expect(screen.getByText('and 201 more')).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Commits (203)' }), { key: 'ArrowRight' })
    expect(screen.getByRole('tab', { name: /Notes/ }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('update-notes')).toBeTruthy()
    expect(screen.getByText('One flight deck for the whole mission.')).toBeTruthy()
  })

  it('shows meters only for a reported percentage and all timeline states remain visible', () => {
    const { rerender } = render(<UpdatePanel {...props} view={RUNNING} />)
    expect(screen.queryByRole('progressbar')).toBeNull()
    rerender(
      <UpdatePanel
        {...props}
        view={{
          ...RUNNING,
          steps: [
            { id: 'done', title: 'Prepared', state: 'done' },
            { id: 'live', title: 'Downloading', state: 'current', percent: 62 },
            {
              id: 'stalled',
              title: 'Stopped',
              state: 'stalled',
              substatus: 'No progress for 2 min',
            },
            { id: 'failed', title: 'Failed', state: 'failed' },
            { id: 'pending', title: 'Next', state: 'pending' },
          ],
        }}
      />,
    )
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('62')
    expect(screen.getByText('No progress for 2 min')).toBeTruthy()
    expect(screen.getAllByRole('listitem')).toHaveLength(5)
  })
})

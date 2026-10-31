import '@/test-support/model-catalog-mock'
import '@/test-support/mock-core-store-handle'
// @vitest-environment happy-dom
/**
 * THE BOX'S TWO MODES (POD-1469).
 *
 * It used to open as a 132px well every time, which asserted that a mission
 * always starts with a paragraph. Half the time it does not — the operator wants
 * the harness in front of them and will type into the agent itself — so the well
 * starts closed as one clickable line, and Launch means two different things on
 * the two sides of that fold:
 *
 *   CLOSED  — always available; starts the chosen agent on the chosen machine
 *             with NO prompt, in a new tab. This is the action the sidebar's
 *             deleted `New <Agent> in <Repo>` chip used to be.
 *   OPEN    — never refused either. With nothing written it takes the same
 *             promptless path as CLOSED; with text it starts the chosen agent
 *             on that prompt in a draft issue the agent will name.
 *
 * The fold is DERIVED, which is the part worth guarding: a persisted draft with
 * words in it has to come back open, or the sentence the operator was halfway
 * through would sit invisible behind a placeholder claiming the box is empty.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { FIRST_TASK_ACTIVATION_DRAFT_KEY } from '@podium/client-core/ui-state'
import { asIssueId, asMachineId, asMutationId, asSessionId } from '@podium/model'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ColdStartComposer } from './ColdStartComposer'

const styles = readFileSync(resolve(import.meta.dirname, '../../styles.css'), 'utf8')

const machineId = asMachineId('machine-a')
const spawnDraftAgent = vi.fn(() => ({
  sessionId: asSessionId('session-new'),
  issueId: asIssueId('issue-new'),
  settled: Promise.resolve(true),
}))
const spawnIssueAgent = vi.fn(() => ({
  sessionId: asSessionId('session-task'),
  issueId: asIssueId('issue-task'),
  mutationId: asMutationId('mutation-task'),
  settled: Promise.resolve(true),
  outcome: Promise.resolve('started' as const),
}))
const setSelectedIssueId = vi.fn()
const setSelectedWorktree = vi.fn()
const setPane = vi.fn()
const setPanelMode = vi.fn()
const focusIssueSession = vi.fn(async (): Promise<string | null> => null)
const setView = vi.fn()
const create = vi.fn()
const start = vi.fn()
const uiValues = new Map<string, string>()
const uiListeners = new Set<(keys: ReadonlySet<string>) => void>()

const store = {
  repos: [
    { path: '/work/podium', kind: 'repository' as const, branch: 'main', worktrees: [], machineId },
  ],
  // No sessions, so `resolveDefaultAgent` falls through to the persisted
  // setting rather than to a most-recently-used harness.
  sessions: [],
  machines: [
    {
      id: machineId,
      name: 'Studio Mac',
      hostname: 'studio',
      online: true,
      serviceAssignment: { server: false, agentExecution: true },
      availability: { epoch: 'boot-1', server: false, daemon: true, supervisor: true },
      lastSeenAt: new Date(0).toISOString(),
      inventory: {
        os: 'darwin' as const,
        arch: 'arm64' as const,
        agents: [
          { kind: 'claude-code' as const, installed: true, login: { state: 'in' as const } },
        ],
        tools: [],
      },
    },
  ],
  // A REAL ui-state, subscription and all: the composer SUBSCRIBES to its draft
  // key rather than seeding it (POD-1469), so a mock that only stores would show
  // nothing the operator typed.
  uiState: {
    get: (key: string) => uiValues.get(key) ?? null,
    set: (key: string, value: string | null) => {
      if (value === null) uiValues.delete(key)
      else uiValues.set(key, value)
      for (const listener of uiListeners) listener(new Set([key]))
    },
    subscribe: (listener: (keys: ReadonlySet<string>) => void) => {
      uiListeners.add(listener)
      return () => uiListeners.delete(listener)
    },
  },
  focusIssueSession,
  spawnDraftAgent,
  spawnIssueAgent,
  setSelectedIssueId,
  setSelectedWorktree,
  setPane,
  setPanelMode,
  setView,
  trpc: {
    settings: {
      get: { query: vi.fn(async () => ({ sessionDefaults: { agent: 'claude-code' } })) },
    },
    issues: { create: { mutate: create }, start: { mutate: start } },
    sessions: { uploadImage: { mutate: vi.fn() } },
  },
}

vi.mock('@/app/store', () => ({
  useRuntimeSelector: (selector: (value: typeof store) => unknown) => selector(store),
}))

vi.mock('@/lib/ModelEffortPicker', () => ({
  ModelPicker: () => null,
  EffortPicker: () => null,
}))

afterEach(() => {
  cleanup()
  uiValues.clear()
  spawnDraftAgent.mockClear()
  spawnIssueAgent.mockClear()
  setSelectedIssueId.mockClear()
  setSelectedWorktree.mockClear()
  setPane.mockClear()
  setPanelMode.mockClear()
  focusIssueSession.mockReset()
  focusIssueSession.mockResolvedValue(null)
  setView.mockClear()
  create.mockReset()
  start.mockReset()
})

const field = (): HTMLTextAreaElement =>
  screen.getByLabelText('What do you want to work on?') as HTMLTextAreaElement
const launch = (): HTMLButtonElement => screen.getByTestId('cold-start-launch') as HTMLButtonElement

function seedDraft(over: Record<string, unknown>): void {
  uiValues.set(
    FIRST_TASK_ACTIVATION_DRAFT_KEY,
    JSON.stringify({ repoPath: '/work/podium', machineId, agent: 'claude-code', ...over }),
  )
}

/* ONE BOX, ALWAYS OPEN (POD-2079). The fold between a one-line CLI invitation
 * and a prompt well is gone: the box rests two lines tall with the question as
 * its placeholder. Start task with nothing written still opens the agent with
 * no prompt — the one default-on way to get a bare session. */
describe('the new task box', () => {
  it('asks the question and offers no way to fold it', () => {
    render(<ColdStartComposer first={false} />)
    expect(field().getAttribute('placeholder')).toBe('What should change, and why?')
    expect(field().getAttribute('rows')).toBe('2')
    expect(screen.queryByTestId('cold-start-collapse')).toBeNull()
  })

  it('starts the agent with no prompt, on the chosen machine, in a new tab', () => {
    render(<ColdStartComposer first={false} />)
    expect(launch().disabled).toBe(false)
    // Quiet secondary face while empty; the filled primary once there is text.
    expect(launch().dataset.quiet).toBe('true')
    expect(launch().title).toMatch(/with no prompt/)
    fireEvent.change(field(), { target: { value: 'Fix it' } })
    expect(launch().dataset.quiet).toBeUndefined()
    fireEvent.change(field(), { target: { value: '' } })
    fireEvent.click(launch())

    expect(spawnDraftAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentKind: 'claude-code',
        target: expect.objectContaining({ path: '/work/podium', machineId }),
      }),
    )
    // No mission is written for a bare CLI session: a vessel is what it is.
    expect(create).not.toHaveBeenCalled()
    expect(setPane).toHaveBeenCalledWith('A', 'session-new')
    expect(setSelectedIssueId).toHaveBeenCalledWith('issue-new')
  })

  it('starts a draft session with the written prompt', () => {
    render(<ColdStartComposer first={false} />)
    fireEvent.change(field(), { target: { value: 'Fix the flaky test' } })
    fireEvent.click(launch())

    expect(spawnDraftAgent).toHaveBeenCalledWith(
      expect.objectContaining({ firstPrompt: 'Fix the flaky test' }),
    )
    expect(spawnIssueAgent).not.toHaveBeenCalled()
  })

  it('tells the overlay a launch went out', () => {
    const onLaunched = vi.fn()
    render(<ColdStartComposer first={false} onLaunched={onLaunched} />)
    fireEvent.change(field(), { target: { value: 'Fix the flaky test' } })
    fireEvent.click(launch())
    expect(onLaunched).toHaveBeenCalledTimes(1)
  })

  it('comes back holding the persisted sentence', () => {
    seedDraft({ title: 'Half a thought' })
    render(<ColdStartComposer first={false} />)
    expect(field().value).toBe('Half a thought')
  })

  it('takes focus when the overlay opens it', () => {
    seedDraft({ title: 'Half a thought' })
    render(<ColdStartComposer first={false} autoFocus />)
    expect(document.activeElement).toBe(field())
    expect(field().selectionStart).toBe('Half a thought'.length)
  })

  // WHITESPACE IS NOT A PROMPT. It takes the same promptless path as an
  // untouched box.
  it('treats a box holding only spaces as promptless', () => {
    render(<ColdStartComposer first={false} />)
    fireEvent.change(field(), { target: { value: '   ' } })
    expect(launch().disabled).toBe(false)

    fireEvent.click(launch())
    expect(spawnDraftAgent).toHaveBeenCalled()
    expect(spawnIssueAgent).not.toHaveBeenCalled()
  })
})

/**
 * A FAILED LAUNCH OWNS THE BOX (POD-1469 review).
 *
 * `pendingIssueId` means the mission exists on the server and only its start
 * failed, so Launch is a RETRY. If the box could close over that, Launch would
 * become `startCli` and spawn an unrelated vessel while the created issue sat
 * there unstarted — and a prompt typed afterwards would be silently discarded,
 * because `start()` takes the pending branch and never reads it.
 */
/**
 * THE BOX READS ITS DRAFT, IT DOES NOT REMEMBER IT (POD-1469 review).
 *
 * `New task` and `Start first task` in the sidebar work by writing this key and
 * clearing the selection — and the composer is ALREADY MOUNTED in that state,
 * because nothing selected is what puts it on screen. A `useState` initializer
 * would have read the key once, at mount, and never again: pressing those
 * buttons would leave the old half-typed prompt on screen, silently discard the
 * project they named, and write the stale draft back on the next keystroke.
 */
describe('the seed a sidebar button writes', () => {
  it('reaches a composer that is already on screen', async () => {
    render(<ColdStartComposer first={false} />)
    fireEvent.focus(field())
    fireEvent.change(field(), { target: { value: 'Half a thought' } })
    expect(field().value).toBe('Half a thought')

    // Exactly what `startNewTask` does: rewrite the key from outside.
    seedDraft({ title: '' })
    for (const listener of uiListeners) listener(new Set([FIRST_TASK_ACTIVATION_DRAFT_KEY]))

    await waitFor(() => expect(field().value).toBe(''))
  })

  it('carries the project the button named', async () => {
    render(<ColdStartComposer first={false} />)
    seedDraft({ repoPath: '/work/podium', title: '' })
    for (const listener of uiListeners) listener(new Set([FIRST_TASK_ACTIVATION_DRAFT_KEY]))

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /^Project: / }).getAttribute('aria-label'),
      ).toContain('podium'),
    )
  })
})

describe('a retry in flight', () => {
  it('locks the prompt it is retrying', () => {
    seedDraft({ title: 'Fix the flaky test', pendingIssueId: 'issue-half-made' })
    render(<ColdStartComposer first={false} />)

    expect(field().disabled).toBe(true)
    expect(launch().getAttribute('aria-label')).toBe('Retry starting work')
  })

  it('retries the created mission rather than spawning a bare session', async () => {
    start.mockResolvedValue({ id: asIssueId('issue-half-made') })
    seedDraft({ title: 'Fix the flaky test', pendingIssueId: 'issue-half-made' })
    render(<ColdStartComposer first={false} />)
    fireEvent.click(launch())

    await waitFor(() => expect(start).toHaveBeenCalled())
    expect(spawnDraftAgent).not.toHaveBeenCalled()
    // The issue already exists; a retry must not make a second one.
    expect(create).not.toHaveBeenCalled()
  })
})

/* WHAT THE LAUNCH ASKS THE PANEL TO SHOW (POD-1669).
 *
 * The two modes already meant two different things by Launch; they now mean two
 * different SURFACES as well, because they are two different requests. An
 * operator who wrote nothing wants the harness in front of them — a chat view
 * over a CLI they asked to see raw is not what they clicked — and an operator
 * who wrote a paragraph wants the answer to it as a conversation, not a terminal
 * replaying their own words as keystrokes. Neither is what `effectivePanelMode`
 * would pick on its own: it reads the operator's `startScreen` and per-device
 * default, which know nothing about which half of this box was used.
 *
 * PER-SESSION ONLY. `pickMode` is what writes the per-device default; this is
 * one session's surface, not a standing preference for every session to come. */
describe('the launch chooses the panel surface', () => {
  it('opens the CLI when nothing was written, before the pane is pointed at it', () => {
    render(<ColdStartComposer first={false} />)
    fireEvent.click(launch())

    expect(setPanelMode).toHaveBeenCalledWith('session-new', 'native')
    // Order is the point: `usePanelSurface` materializes its derived fallback
    // only while the per-session mode is undefined, so the write has to be
    // sitting there before the panel mounts on the session.
    expect(setPanelMode.mock.invocationCallOrder[0]).toBeLessThan(
      setPane.mock.invocationCallOrder[0] as number,
    )
  })

  it('opens the chat on the optimistic session a written prompt started', () => {
    render(<ColdStartComposer first={false} />)
    fireEvent.change(field(), { target: { value: 'Fix the flaky test' } })
    fireEvent.click(launch())

    expect(setPanelMode).toHaveBeenCalledWith('session-new', 'chat')
    expect(setPanelMode.mock.invocationCallOrder[0]).toBeLessThan(
      setPane.mock.invocationCallOrder[0] as number,
    )
  })

  it('does not wait for a replicated session before choosing chat', () => {
    render(<ColdStartComposer first={false} />)
    fireEvent.change(field(), { target: { value: 'Fix the flaky test' } })
    fireEvent.click(launch())

    expect(focusIssueSession).not.toHaveBeenCalled()
    expect(setPanelMode).toHaveBeenCalledWith('session-new', 'chat')
  })
})

/* Happy DOM has no layout engine, so assert the rules that carry the resting
 * height and the overflow, and drive the sizing hook with stubbed metrics. */
describe('the prompt grows with the text', () => {
  it('rests two Geist 18/30 lines tall and scrolls only once capped', () => {
    expect(styles).toMatch(/\.cold-start-input\s*\{[^}]*min-height:\s*calc\(2 \* 30px/)
    expect(styles).toMatch(/\.cold-start-input\s*\{[^}]*line-height:\s*30px/)
    expect(styles).toMatch(/\.cold-start-input\[data-capped="true"\]\s*\{[^}]*overflow-y:\s*auto/)
  })

  it('grows with the draft, then caps at 60% of the window and scrolls', () => {
    render(<ColdStartComposer first />)
    const textarea = field()
    let contentHeight = 420
    Object.defineProperty(textarea, 'offsetHeight', { configurable: true, get: () => 104 })
    Object.defineProperty(textarea, 'scrollHeight', {
      configurable: true,
      get: () => contentHeight,
    })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 1000 })

    fireEvent.change(textarea, { target: { value: 'A prompt that fits' } })
    expect(textarea.style.height).toBe('420px')
    expect(textarea.dataset.capped).toBe('false')

    contentHeight = 900
    fireEvent.change(textarea, { target: { value: 'A much longer prompt that fills the window' } })
    expect(textarea.style.height).toBe('600px')
    expect(textarea.dataset.capped).toBe('true')
  })
})

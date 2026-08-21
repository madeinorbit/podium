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
 *   OPEN    — refused while the prompt is empty; creates the mission and starts
 *             it, exactly as it always has.
 *
 * The fold is DERIVED, which is the part worth guarding: a persisted draft with
 * words in it has to come back open, or the sentence the operator was halfway
 * through would sit invisible behind a placeholder claiming the box is empty.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { FIRST_TASK_ACTIVATION_DRAFT_KEY } from '@podium/client-core/ui-state'
import { asIssueId, asMachineId } from '@podium/model'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ColdStartComposer } from './ColdStartComposer'

const styles = readFileSync(resolve(import.meta.dirname, '../../styles.css'), 'utf8')

const machineId = asMachineId('machine-a')
const spawnDraftAgent = vi.fn(() => ({ sessionId: 'session-new', issueId: asIssueId('issue-new') }))
const setSelectedIssueId = vi.fn()
const setSelectedWorktree = vi.fn()
const setPane = vi.fn()
const setView = vi.fn()
const create = vi.fn()
const start = vi.fn()
const uiValues = new Map<string, string>()

const store = {
  repos: [
    { path: '/work/podium', kind: 'repository' as const, branch: 'main', worktrees: [], machineId },
  ],
  machines: [
    {
      id: machineId,
      name: 'Studio Mac',
      hostname: 'studio',
      online: true,
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
  uiState: {
    get: (key: string) => uiValues.get(key) ?? null,
    set: (key: string, value: string | null) => {
      if (value === null) uiValues.delete(key)
      else uiValues.set(key, value)
    },
  },
  focusIssueSession: vi.fn(async () => null),
  spawnDraftAgent,
  setSelectedIssueId,
  setSelectedWorktree,
  setPane,
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
  useStoreSelector: (selector: (value: typeof store) => unknown) => selector(store),
}))

vi.mock('@/lib/ModelEffortPicker', () => ({
  ModelPicker: () => null,
  EffortPicker: () => null,
}))

afterEach(() => {
  cleanup()
  uiValues.clear()
  spawnDraftAgent.mockClear()
  setSelectedIssueId.mockClear()
  setSelectedWorktree.mockClear()
  setPane.mockClear()
  setView.mockClear()
  create.mockReset()
  start.mockReset()
})

const field = (): HTMLTextAreaElement =>
  screen.getByLabelText('What do you want to work on?') as HTMLTextAreaElement
const box = (): HTMLElement => screen.getByTestId('cold-start-field')
const launch = (): HTMLButtonElement => screen.getByTestId('cold-start-launch') as HTMLButtonElement

function seedDraft(over: Record<string, unknown>): void {
  uiValues.set(
    FIRST_TASK_ACTIVATION_DRAFT_KEY,
    JSON.stringify({ repoPath: '/work/podium', machineId, agent: 'claude-code', ...over }),
  )
}

describe('the launch box opens closed', () => {
  it('shows the one-line invitation and no way to dismiss what is not open', () => {
    render(<ColdStartComposer first={false} />)
    expect(box().getAttribute('data-expanded')).toBe('false')
    expect(field().getAttribute('placeholder')).toBe('Click here to enter a prompt.')
    expect(screen.queryByTestId('cold-start-collapse')).toBeNull()
  })

  it('keeps Launch live with nothing written, because that IS the request', () => {
    render(<ColdStartComposer first={false} />)
    expect(launch().disabled).toBe(false)
  })

  it('starts the agent with no prompt, on the chosen machine, in a new tab', () => {
    render(<ColdStartComposer first={false} />)
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
})

describe('the launch box unfolds', () => {
  it('opens on focus, swaps the invitation for the brief, and offers the way back', () => {
    render(<ColdStartComposer first={false} />)
    fireEvent.focus(field())

    expect(box().getAttribute('data-expanded')).toBe('true')
    expect(field().getAttribute('placeholder')).toMatch(/Describe the mission/)
    expect(screen.getByTestId('cold-start-collapse')).toBeTruthy()
  })

  it('refuses Launch while the prompt is empty, and allows it once it is not', () => {
    render(<ColdStartComposer first={false} />)
    fireEvent.focus(field())
    expect(launch().disabled).toBe(true)

    fireEvent.change(field(), { target: { value: 'Fix the flaky test' } })
    expect(launch().disabled).toBe(false)
  })

  it('creates the mission rather than a bare session once there is a prompt', async () => {
    create.mockResolvedValue({ id: asIssueId('issue-first') })
    start.mockResolvedValue({ id: asIssueId('issue-first') })
    render(<ColdStartComposer first={false} />)
    fireEvent.change(field(), { target: { value: 'Fix the flaky test' } })
    fireEvent.click(launch())

    await waitFor(() => expect(create).toHaveBeenCalled())
    expect(spawnDraftAgent).not.toHaveBeenCalled()
  })

  it('closes by CLEARING, so a dismissed prompt cannot launch behind the placeholder', () => {
    render(<ColdStartComposer first={false} />)
    fireEvent.change(field(), { target: { value: 'Half a thought' } })
    fireEvent.click(screen.getByTestId('cold-start-collapse'))

    expect(box().getAttribute('data-expanded')).toBe('false')
    expect(field().value).toBe('')
    expect(field().getAttribute('placeholder')).toBe('Click here to enter a prompt.')
  })

  it('comes back open when the persisted draft still holds a sentence', () => {
    seedDraft({ title: 'Half a thought' })
    render(<ColdStartComposer first={false} />)
    expect(box().getAttribute('data-expanded')).toBe('true')
    expect(field().value).toBe('Half a thought')
  })
})

/* The fold is a HEIGHT animation on one element, not a swap between two — see
 * the note in styles.css for why `height` rather than `min-height`. Neither the
 * transition nor the two heights show up in a happy-dom render, so assert the
 * rules that carry them. */
describe('the fold is one element changing height', () => {
  it('animates height between a closed line and the prompt well', () => {
    expect(styles).toMatch(/\.cold-start-input\s*\{[^}]*height:\s*46px/)
    expect(styles).toMatch(/\.cold-start-input\s*\{[^}]*transition:[^}]*height 240ms/)
    expect(styles).toMatch(
      /\.cold-start-field\[data-expanded="true"\] \.cold-start-input\s*\{[^}]*height:\s*clamp\(72px/,
    )
  })

  it('honours prefers-reduced-motion', () => {
    expect(styles).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\.cold-start-input\s*\{\s*transition: none/,
    )
  })
})

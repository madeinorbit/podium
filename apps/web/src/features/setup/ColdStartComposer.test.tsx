// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { asIssueId, asMachineId } from '@podium/model'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ColdStartComposer } from './ColdStartComposer'

const styles = readFileSync(resolve(import.meta.dirname, '../../styles.css'), 'utf8')

const create = vi.fn()
const start = vi.fn()
const setSelectedIssueId = vi.fn()
const uiValues = new Map<string, string>()
const machineId = asMachineId('machine-a')

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
        agents: [{ kind: 'codex' as const, installed: true, login: { state: 'in' as const } }],
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
  setSelectedIssueId,
  trpc: {
    settings: {
      get: {
        query: vi.fn(async () => ({
          sessionDefaults: { agent: 'codex' },
          gitWorkflow: { defaultParentBranch: 'main' },
        })),
      },
    },
    issues: { create: { mutate: create }, start: { mutate: start } },
  },
}

vi.mock('@/app/store', () => ({
  useStoreSelector: (selector: (value: typeof store) => unknown) => selector(store),
}))

vi.mock('@/lib/ModelEffortPicker', () => ({
  ModelPicker: ({ onChange }: { onChange: (value: string) => void }) => (
    <button type="button" onClick={() => onChange('gpt-5.6-sol')}>
      Model
    </button>
  ),
  EffortPicker: ({ onChange }: { onChange: (value: string) => void }) => (
    <button type="button" onClick={() => onChange('high')}>
      Effort
    </button>
  ),
}))

afterEach(() => {
  cleanup()
  uiValues.clear()
  create.mockReset()
  start.mockReset()
  setSelectedIssueId.mockClear()
})

/* The headline's accessible name is the SENTENCE, not the sentence with the
 * project button's own label spliced into it. Both assertions below used to
 * read `Give Project: podium its first mission` — the trigger's
 * `aria-label="Project: podium"` leaking into the h2's computed name — and both
 * were already failing on main before this issue touched the file: the name
 * computation now takes the button's content, so the heading reads the way it
 * looks. The button keeps its own label when it is the focused thing, which is
 * where "Project:" is worth saying. */
describe('ColdStartComposer', () => {
  it('uses the reusable first-run wording and production task path', async () => {
    const issueId = asIssueId('issue-first')
    create.mockResolvedValue({ id: issueId })
    start.mockResolvedValue({ id: issueId })
    render(<ColdStartComposer first />)

    expect(screen.getByRole('heading', { name: /Give podium its first mission/ })).toBeTruthy()
    fireEvent.change(screen.getByLabelText('What do you want to work on?'), {
      target: { value: 'Ship the new onboarding\nKeep the empty state subtle.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Model' }))
    fireEvent.click(screen.getByRole('button', { name: 'Effort' }))
    fireEvent.click(screen.getByRole('button', { name: 'Start work' }))

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        repoPath: '/work/podium',
        machineId: 'machine-a',
        title: 'Ship the new onboarding',
        description: 'Ship the new onboarding\nKeep the empty state subtle.',
        parentBranch: 'main',
        defaultAgent: 'codex',
        defaultModel: 'gpt-5.6-sol',
        defaultEffort: 'high',
        startNow: false,
        mutationId: expect.any(String),
      }),
    )
    expect(start).toHaveBeenCalledWith({ id: issueId, mutationId: expect.any(String) })
    expect(setSelectedIssueId).toHaveBeenCalledWith(issueId)
  })

  it('switches to reusable workspace wording when tasks already exist', () => {
    render(<ColdStartComposer first={false} />)
    expect(
      screen.getByRole('heading', { name: /What do you want to work on in podium/ }),
    ).toBeTruthy()
  })

  /* POD-1169. The instrument strip clips its own contents (`overflow-hidden`)
   * to keep the three pickers in one groove, and that sets its automatic
   * minimum size to 0 — as a shrinkable flex item it SQUASHED instead of
   * wrapping, so a narrow pane lost the agent, model and effort controls
   * silently rather than moving them to a second line. `flex-none` is the fix
   * and it is invisible in a jsdom render, so assert it directly. */
  it('keeps the instrument strip unshrinkable, so a narrow pane wraps it whole', () => {
    render(<ColdStartComposer first={false} />)
    const strip = screen.getByRole('button', { name: 'Agent' }).parentElement
    expect(strip?.className).toContain('overflow-hidden')
    expect(strip?.className).toContain('flex-none')
  })

  /* POD-1184. The deck scrolls when a pane is too short for it, and a scroll
   * container that CENTERS its overflowing content pushes half the overrun out
   * of the start edge, where scrolling cannot reach it: at a 1200×260 window
   * the sentence sat 59px above the scroller's top, project picker and all.
   * `justify-center` is therefore forbidden here — the centring is the body's
   * own `margin-block: auto`, which resolves to zero the moment free space
   * runs out. Neither half shows up in a happy-dom render, so assert both. */
  it('centres the deck without putting its top out of scroll reach', () => {
    render(<ColdStartComposer first={false} />)
    const deck = screen.getByLabelText('What do you want to work on?').closest('.cold-start')
    expect(deck).toBeTruthy()
    expect(deck?.className).toContain('overflow-y-auto')
    expect(deck?.className).not.toContain('justify-center')
    expect(styles).toMatch(/\.cold-start-body\s*\{[^}]*margin-block:\s*auto/)
  })

  /* POD-1184. The headline is one SENTENCE with a control set into it, not a
   * flex row of three items: as a flex row the trailing mark was its own item
   * behind a 0.4em gap, and a narrow pane stranded it under the pill. Inline
   * flow puts it hard against the pill instead, joined by U+2060 so no line can
   * break between them. */
  it('keeps the sentence mark attached to the project pill', () => {
    render(<ColdStartComposer first={false} />)
    const heading = screen.getByRole('heading', { name: /What do you want to work on in podium/ })
    expect(heading.className).not.toContain('flex')
    expect(heading.textContent?.endsWith('⁠?')).toBe(true)
    expect(heading.lastElementChild?.className).toContain('cold-start-project')
  })
})

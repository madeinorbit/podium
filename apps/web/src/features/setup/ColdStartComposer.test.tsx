// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  asIssueId,
  asMachineId,
  asSessionId,
  type GitRepositoryWire,
  type SessionMeta,
} from '@podium/model'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ColdStartComposer } from './ColdStartComposer'

const styles = readFileSync(resolve(import.meta.dirname, '../../styles.css'), 'utf8')

const create = vi.fn()
const start = vi.fn()
const focusIssueSession = vi.fn(async () => null)
const uploadImage = vi.fn()
const uiValues = new Map<string, string>()
const uiListeners = new Set<() => void>()
const machineId = asMachineId('machine-a')
const initialRepo = {
  path: '/work/podium',
  name: 'podium',
  kind: 'repository' as const,
  branch: 'main',
  worktrees: [],
  machineId,
} as GitRepositoryWire

const store = {
  repos: [initialRepo],
  // No sessions, so `resolveDefaultAgent` falls through to the persisted
  // setting rather than to a most-recently-used harness.
  sessions: [] as SessionMeta[],
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
  // A REAL ui-state, subscription and all: the composer SUBSCRIBES to its draft
  // key rather than seeding it (POD-1469), so a mock that only stores would show
  // nothing the operator typed.
  uiState: {
    get: (key: string) => uiValues.get(key) ?? null,
    set: (key: string, value: string | null) => {
      if (value === null) uiValues.delete(key)
      else uiValues.set(key, value)
      for (const listener of uiListeners) listener()
    },
    subscribe: (listener: () => void) => {
      uiListeners.add(listener)
      return () => uiListeners.delete(listener)
    },
  },
  focusIssueSession,
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
    sessions: { uploadImage: { mutate: uploadImage } },
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
  store.repos.splice(0, store.repos.length, initialRepo)
  store.sessions.splice(0)
  store.machines.splice(1)
  create.mockReset()
  start.mockReset()
  focusIssueSession.mockReset()
  focusIssueSession.mockResolvedValue(null)
  uploadImage.mockReset()
})

/** The hidden `<input type=file>` the paperclip clicks — it has no accessible
 *  name by design, so it is reached the way the button reaches it. */
function fileInput(): HTMLInputElement {
  const input = document.querySelector('input[type=file]')
  if (!input) throw new Error('the composer has no file input')
  return input as HTMLInputElement
}

function attach(file: File): void {
  Object.defineProperty(fileInput(), 'files', { value: [file], configurable: true })
  fireEvent.change(fileInput())
}

function recentSession(cwd: string): SessionMeta {
  return {
    sessionId: asSessionId('recent-session'),
    agentKind: 'claude-code',
    title: 'Recent session',
    cwd,
    status: 'live',
    controllerId: null,
    geometry: { cols: 80, rows: 24 },
    epoch: 0,
    clientCount: 0,
    createdAt: '2026-08-20T00:00:00.000Z',
    lastActiveAt: '2026-08-21T00:00:00.000Z',
    origin: { kind: 'spawn' },
    archived: false,
    busy: false,
    readAt: null,
    unread: false,
  } as unknown as SessionMeta
}

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
  })

  /* POD-1202. A launch that only selected the issue left the operator on the
   * empty tab area — the mission was on screen with nothing open in it, so
   * sending the prompt looked like it had done nothing. The composer hands the
   * landing to `focusIssueSession`, which waits for the session row and opens
   * its tab; the start must have gone out FIRST, or there is no session to
   * wait for. */
  it('lands on the session the launch started, after the start goes out', async () => {
    const issueId = asIssueId('issue-first')
    const calls: string[] = []
    create.mockResolvedValue({ id: issueId })
    start.mockImplementation(async () => {
      calls.push('start')
      return { id: issueId }
    })
    focusIssueSession.mockImplementation(async () => {
      calls.push('focus')
      return null
    })
    render(<ColdStartComposer first={false} />)

    fireEvent.change(screen.getByLabelText('What do you want to work on?'), {
      target: { value: 'Ship the new onboarding' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Start work' }))

    await waitFor(() => expect(focusIssueSession).toHaveBeenCalledWith(issueId))
    expect(calls).toEqual(['start', 'focus'])
  })

  it('switches to reusable workspace wording when tasks already exist', () => {
    render(<ColdStartComposer first={false} />)
    expect(
      screen.getByRole('heading', { name: /What do you want to work on in podium/ }),
    ).toBeTruthy()
  })

  it('deduplicates multi-machine repos and selects and lists them by recent use', () => {
    const machineB = asMachineId('machine-b')
    store.repos.splice(
      0,
      store.repos.length,
      {
        path: '/work/alpha',
        name: 'alpha',
        kind: 'repository',
        branch: 'main',
        worktrees: [],
        machineId,
        originUrl: 'https://example.com/acme/alpha.git',
      } as GitRepositoryWire,
      {
        path: '/work/beta',
        name: 'beta',
        kind: 'repository',
        branch: 'main',
        worktrees: [],
        machineId,
        originUrl: 'https://example.com/acme/beta.git',
      } as GitRepositoryWire,
      {
        path: '/srv/beta',
        name: 'beta',
        kind: 'repository',
        branch: 'main',
        worktrees: [],
        machineId: machineB,
        originUrl: 'https://example.com/acme/beta.git',
      } as GitRepositoryWire,
    )
    store.machines.push({
      ...store.machines[0]!,
      id: machineB,
      name: 'Build host',
      hostname: 'builder',
    })
    store.sessions.push(recentSession('/srv/beta'))

    render(<ColdStartComposer first={false} />)

    const picker = screen.getByRole('button', { name: 'Project: beta' })
    fireEvent.click(picker)
    const repoItems = screen.getAllByRole('menuitem').map((item) => item.textContent?.trim())
    expect(repoItems).toEqual(['beta', 'alpha'])
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

  /* POD-1203. The home box can be given a screenshot or a document, and the
   * whole point is that the agent receives it — a chip that only ever decorated
   * this screen would be worse than no affordance at all. */
  describe('attachments', () => {
    it('uploads to the SELECTED machine, because a path is only valid on one disk', async () => {
      create.mockResolvedValue({ id: asIssueId('issue-att') })
      start.mockResolvedValue({ id: asIssueId('issue-att') })
      uploadImage.mockResolvedValue({ path: '/home/a/.podium/uploads/scope/1.png' })
      render(<ColdStartComposer first />)

      attach(new File(['bytes'], 'shot.png', { type: 'image/png' }))

      await waitFor(() =>
        expect(uploadImage).toHaveBeenCalledWith(
          expect.objectContaining({
            filename: 'shot.png',
            mimeType: 'image/png',
            machineId: 'machine-a',
          }),
        ),
      )
      // The scope is a stand-in for a session that does not exist yet — it must
      // be SOMETHING (the uploads dir is named by it) and must not be a real
      // session id, which is why nothing here asserts a lookup.
      expect(uploadImage.mock.calls[0]?.[0].sessionId).toMatch(/^coldstart-/)
    })

    it('carries the uploaded path into the started mission, in the brief', async () => {
      const issueId = asIssueId('issue-att')
      create.mockResolvedValue({ id: issueId })
      start.mockResolvedValue({ id: issueId })
      uploadImage.mockResolvedValue({ path: '/home/a/.podium/uploads/scope/1.png' })
      render(<ColdStartComposer first />)

      fireEvent.change(screen.getByLabelText('What do you want to work on?'), {
        target: { value: 'Match this mock' },
      })
      attach(new File(['bytes'], 'mock.png', { type: 'image/png' }))
      await waitFor(() => expect(uploadImage).toHaveBeenCalled())
      fireEvent.click(screen.getByRole('button', { name: 'Start work' }))

      await waitFor(() => expect(create).toHaveBeenCalled())
      const input = create.mock.calls[0]?.[0]
      // The description stays the prose a human reads on the issue card…
      expect(input.description).toBe('Match this mock')
      expect(input.title).toBe('Match this mock')
      // …and the path rides in the brief, which the started session's first
      // prompt joins onto it ([spec:SP-6144]).
      expect(input.brief).toContain('/home/a/.podium/uploads/scope/1.png')
    })

    it('refuses to launch until the bytes have landed, so the brief cannot name a file in flight', async () => {
      create.mockResolvedValue({ id: asIssueId('issue-att') })
      let land: (result: { path: string }) => void = () => {}
      uploadImage.mockReturnValue(
        new Promise<{ path: string }>((resolve) => {
          land = resolve
        }),
      )
      render(<ColdStartComposer first />)

      fireEvent.change(screen.getByLabelText('What do you want to work on?'), {
        target: { value: 'Read this spec' },
      })
      attach(new File(['bytes'], 'spec.pdf', { type: 'application/pdf' }))

      const launch = () => screen.getByRole('button', { name: 'Start work' }) as HTMLButtonElement
      await waitFor(() => expect(launch().disabled).toBe(true))
      fireEvent.click(launch())
      expect(create).not.toHaveBeenCalled()

      land({ path: '/home/a/.podium/uploads/scope/1.pdf' })
      await waitFor(() => expect(launch().disabled).toBe(false))
    })

    it('takes a document, not only a screenshot', async () => {
      uploadImage.mockResolvedValue({ path: '/home/a/.podium/uploads/scope/1.pdf' })
      render(<ColdStartComposer first />)

      attach(new File(['%PDF'], 'brief.pdf', { type: 'application/pdf' }))

      await waitFor(() =>
        expect(uploadImage).toHaveBeenCalledWith(
          expect.objectContaining({ filename: 'brief.pdf', mimeType: 'application/pdf' }),
        ),
      )
      expect(screen.getByText('brief.pdf')).toBeTruthy()
    })
  })
})

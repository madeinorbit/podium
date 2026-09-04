// @vitest-environment happy-dom
/**
 * THE EMPTY-STATE AGENT MENU WEARS THE SHARED REFUSAL VOCABULARY (POD-1201).
 *
 * The issue page, the new-issue dialog and the tab strip already grey a harness
 * the selected host cannot run, and print `not installed` / `signed out` beside
 * the name. This box still used PropertyMenu, so Cursor on a machine without
 * Cursor looked exactly as startable as Grok. The assertions below are the
 * same pair every other spawn menu holds: a refused row is greyed AND named,
 * a signed-out row stays live with the condition in the hint column.
 *
 * THE FOCUS CHORD (POD-993) is the other half. The session prompt answers ⌘/
 * (and ⌘L from the macOS View menu); with nothing open this box is the prompt,
 * so both the shared slash listener and the native menu hook have to land here.
 */
import { asMachineId } from '@podium/model'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ColdStartComposer } from './ColdStartComposer'

const machineId = asMachineId('machine-a')

function inventory() {
  return {
    os: 'darwin' as const,
    arch: 'arm64' as const,
    agents: [
      { kind: 'claude-code' as const, installed: true, login: { state: 'in' as const } },
      { kind: 'codex' as const, installed: true, login: { state: 'in' as const } },
      { kind: 'grok' as const, installed: true, login: { state: 'out' as const } },
      { kind: 'opencode' as const, installed: false, login: { state: 'unknown' as const } },
      { kind: 'cursor' as const, installed: false, login: { state: 'unknown' as const } },
    ],
    tools: [],
  }
}

const uiValues = new Map<string, string>()
const uiListeners = new Set<() => void>()

const store = {
  repos: [
    {
      path: '/work/podium',
      kind: 'repository' as const,
      branch: 'main',
      worktrees: [],
      machineId,
    },
  ],
  sessions: [],
  machines: [
    {
      id: machineId,
      name: 'Studio Mac',
      hostname: 'studio',
      online: true,
      lastSeenAt: new Date(0).toISOString(),
      inventory: inventory(),
    },
  ],
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
  focusIssueSession: vi.fn(async () => null),
  spawnDraftAgent: vi.fn(),
  setSelectedIssueId: vi.fn(),
  setSelectedWorktree: vi.fn(),
  setPane: vi.fn(),
  setPanelMode: vi.fn(),
  setView: vi.fn(),
  trpc: {
    settings: {
      get: {
        query: vi.fn(async () => ({ roles: { coding: { accountId: 'native:claude-code' } } })),
      },
      updatePersonal: { mutate: vi.fn() },
    },
    issues: { create: { mutate: vi.fn() }, start: { mutate: vi.fn() } },
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
  uiListeners.clear()
  delete (globalThis as { __PODIUM_FOCUS_SESSION_PROMPT__?: () => void })
    .__PODIUM_FOCUS_SESSION_PROMPT__
})

const chip = (): HTMLElement => screen.getByRole('button', { name: 'Agent' })

async function openMenu(): Promise<void> {
  fireEvent.click(chip())
  await screen.findAllByTestId('capability-agent-item')
}

function row(label: string): HTMLElement {
  const match = screen
    .getAllByTestId('capability-agent-item')
    .find((item) => item.getAttribute('data-agent-label') === label)
  if (!match) throw new Error(`no agent row named ${label}`)
  return match
}

describe('the empty-state agent menu greys what it cannot start', () => {
  it('refuses a missing harness with the same words as every other spawn menu', async () => {
    render(<ColdStartComposer first={false} />)
    await openMenu()

    const cursor = row('Cursor')
    expect(cursor.textContent).toContain('not installed')
    expect(cursor.getAttribute('data-refused')).toBe('true')
    fireEvent.click(cursor)
    expect(chip().textContent).toContain('Claude Code')

    const claude = row('Claude Code')
    expect(claude.getAttribute('data-refused')).toBeNull()
    expect(claude.textContent).not.toContain('not installed')
  })

  it('keeps a signed-out harness live and names the condition', async () => {
    render(<ColdStartComposer first={false} />)
    await openMenu()

    const grok = row('Grok')
    expect(grok.textContent).toContain('signed out')
    expect(grok.getAttribute('data-refused')).toBeNull()
    fireEvent.click(grok)
    expect(chip().textContent).toContain('Grok')
  })
})

describe('the empty-state prompt answers the session focus chord', () => {
  function textarea(): HTMLTextAreaElement {
    return screen.getByLabelText('What do you want to work on?') as HTMLTextAreaElement
  }

  it('advertises the chord on the closed box', () => {
    render(<ColdStartComposer first={false} />)
    const hint = screen.getByTestId('composer-chord')
    expect(hint.getAttribute('data-show')).toBe('true')
    expect(hint.textContent).toMatch(/to focus/)
  })

  it('puts the caret in the box from the shared slash chord', () => {
    render(<ColdStartComposer first={false} />)
    expect(document.activeElement).not.toBe(textarea())

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '/', ctrlKey: true, bubbles: true }))
    })

    expect(document.activeElement).toBe(textarea())
    expect(screen.getByTestId('cold-start-field').getAttribute('data-expanded')).toBe('true')
  })

  it('puts the caret in the box from the native Focus Session Prompt hook', () => {
    render(<ColdStartComposer first={false} />)
    const hook = (globalThis as { __PODIUM_FOCUS_SESSION_PROMPT__?: () => void })
      .__PODIUM_FOCUS_SESSION_PROMPT__
    expect(hook).toEqual(expect.any(Function))

    act(() => {
      hook?.()
    })

    expect(document.activeElement).toBe(textarea())
  })
})

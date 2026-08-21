// @vitest-environment happy-dom
/**
 * MACHINE `use` IN THE SPAWN SURFACE (POD-407, readiness §3.1.4 M5), moved here
 * by POD-1469.
 *
 * These assertions used to live in `SidebarUnified.machine-use.test.tsx`,
 * against the agent → repo → machine submenu of the sidebar's `New <Agent> in
 * <Repo>` chip. That chip and its menu are gone: the sidebar's button opens a
 * blank mission and THIS box is where a harness, a model, an effort and a host
 * are chosen and spent. The boundary did not move with it by accident — it moved
 * because this is now the only surface in the shell that can start work on a
 * named machine, and M5 is a rule about surfaces that can.
 *
 * What must hold, unchanged in substance:
 *   1. a machine the principal may not `use` is never the SILENT default — the
 *      "silently retargeted spawn" M5 forbids;
 *   2. UNAUTHORIZED and UNREACHABLE render as visibly different things, because
 *      they need opposite responses (ask the owner vs wake the host);
 *   3. every launch is refused while an unauthorized machine is selected —
 *      including the promptless CLI launch, which is the one POD-1469 added.
 *
 * The parity half is `ColdStartComposer.test.tsx`, whose machine carries no
 * `use` field at all: an unscoped list stays fully offerable, which is the
 * single-user regression guard for the whole multi-user programme.
 */
import { asMachineId } from '@podium/model'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ColdStartComposer } from './ColdStartComposer'

const spawnDraftAgent = vi.fn(() => ({ sessionId: 'session-new', issueId: 'issue-new' }))
const create = vi.fn()
const start = vi.fn()
const uiValues = new Map<string, string>()

function machine(id: string, over: Record<string, unknown>) {
  return {
    id: asMachineId(id),
    name: id,
    hostname: id,
    online: true,
    lastSeenAt: new Date(0).toISOString(),
    ...over,
  }
}

const store = {
  // No `machineId` on the repo: every visible host is a candidate, which is the
  // shape that lets this file assert what the picker does with the three of them.
  repos: [{ path: '/work/podium', kind: 'repository' as const, branch: 'main', worktrees: [] }],
  // No sessions, so `resolveDefaultAgent` falls through to the persisted
  // setting rather than to a most-recently-used harness.
  sessions: [],
  machines: [
    machine('mine', { use: 'granted' }),
    machine('theirs', { use: 'denied' }),
    machine('asleep', { use: 'granted', online: false }),
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
  setSelectedIssueId: vi.fn(),
  setSelectedWorktree: vi.fn(),
  setPane: vi.fn(),
  setView: vi.fn(),
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
  create.mockReset()
  start.mockReset()
})

/** Open the machine picker and hand back its rows. */
async function machineRows(): Promise<HTMLElement[]> {
  fireEvent.click(screen.getByRole('button', { name: /^Choose machine$|mine|theirs|asleep/ }))
  return await screen.findAllByRole('menuitem')
}

function launchButton(): HTMLButtonElement {
  return screen.getByTestId('cold-start-launch') as HTMLButtonElement
}

describe('the launch box — use is a code-execution boundary', () => {
  it('never lands the default on a machine the principal cannot use', () => {
    render(<ColdStartComposer first={false} />)
    // The chip names the host the box would spend, and it must not be `theirs`
    // however the list happens to be ordered.
    expect(
      screen.getByRole('button', { name: /Choose machine|mine|theirs|asleep/ }).textContent,
    ).toContain('mine')
  })

  it('distinguishes unauthorized from unreachable rather than collapsing both', async () => {
    render(<ColdStartComposer first={false} />)
    const rows = await machineRows()
    const text = rows.map((row) => row.textContent ?? '')
    expect(text.find((label) => label.startsWith('theirs'))).toContain('no access')
    expect(text.find((label) => label.startsWith('asleep'))).toContain('offline')
    expect(text.find((label) => label.startsWith('mine'))).toBe('mine')
  })

  it('refuses every launch while an unauthorized machine is selected', async () => {
    render(<ColdStartComposer first={false} />)
    const rows = await machineRows()
    const denied = rows.find((row) => row.textContent?.includes('no access'))
    expect(denied).toBeDefined()
    fireEvent.click(denied as HTMLElement)

    // Closed, Launch would start a CLI session; open, it would create a mission.
    // Neither may go out, and the box says why rather than going quiet.
    await waitFor(() => expect(launchButton().disabled).toBe(true))
    expect(screen.getByText(/do not have access to run work on this machine/)).toBeTruthy()

    fireEvent.change(screen.getByLabelText('What do you want to work on?'), {
      target: { value: 'Ship it' },
    })
    expect(launchButton().disabled).toBe(true)
    fireEvent.click(launchButton())
    expect(spawnDraftAgent).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })
})

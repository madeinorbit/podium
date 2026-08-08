// @vitest-environment happy-dom
/**
 * POD-563 — the Reclaim tab is a PROPOSAL, not a queue.
 *
 * The invariants under test are the ones that make a janitor list safe to show
 * an operator: nothing is ticked for them, nothing is stopped without a confirm
 * that names the consequences, the confirm acts on the ticked rows ONLY, and a
 * server refusal is reported as held rather than mistaken for a success.
 *
 * That last one is not hypothetical: `issues.stop` answers a dirty-tree refusal
 * with `ok: true` and `worktreeFreed: false` — it really did stop the sessions,
 * it just did not take the disk. A panel that reads "the call did not throw" as
 * "freed" tells the operator their uncommitted work is gone when it is not.
 */
import { asMachineId } from '@podium/model'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HostInfoView } from './HostMemoryView'

const stop = vi.fn()
const memoryBreakdown = vi.fn()
const settingsGet = vi.fn(async () => ({
  hibernation: {
    enabled: true,
    memoryPct: 80,
    idleMinutes: 30,
    loadPerCore: 1.5,
    maxIdleSessions: 8,
  },
  worktreeGc: { mode: 'propose' as const, afterDays: 14 },
}))

const day = 24 * 60 * 60 * 1000
const closedDaysAgo = (n: number) => new Date(Date.now() - n * day).toISOString()

const issues = [
  {
    id: 'i-old',
    title: 'Old shipped thing',
    stage: 'done',
    closedAt: closedDaysAgo(40),
    worktreePath: '/r/.worktrees/old',
    machineId: 'm1',
  },
  {
    id: 'i-mid',
    title: 'Also shipped',
    stage: 'done',
    closedAt: closedDaysAgo(20),
    worktreePath: '/r/.worktrees/mid',
    machineId: 'm1',
  },
  {
    id: 'i-fresh',
    title: 'Closed yesterday',
    stage: 'done',
    closedAt: closedDaysAgo(1),
    worktreePath: '/r/.worktrees/fresh',
    machineId: 'm1',
  },
]

vi.mock('@/app/store', () => {
  const useStore = () => ({
    hostMetrics: [
      {
        hostname: 'podium-host',
        machineId: asMachineId('m1'),
        name: 'podium-host',
        sampledAt: '2026-08-08T00:00:00.000Z',
        memory: { totalBytes: 32e9, availableBytes: 20e9, swapTotalBytes: 0, swapFreeBytes: 0 },
        load: { one: 2, five: 1.5, fifteen: 1, cpuCount: 8 },
      },
    ],
    sessions: [],
    machines: [],
    outboxSize: 0,
    outboxDeadLetters: [],
    setView: vi.fn(),
    setSettingsTab: vi.fn(),
    trpc: {
      issues: { stop: { mutate: stop } },
      hosts: { memoryBreakdown: { mutate: memoryBreakdown } },
      settings: { get: { query: settingsGet } },
    },
  })
  return {
    useStore,
    useReplicaIssues: () => issues,
    useStoreSelector: (sel: (s: unknown) => unknown) => sel(useStore() as never),
  }
})

// Same substitution NewIssueDialog.agent-start.test.tsx makes: the base-ui
// checkbox does not answer a synthetic click under happy-dom, and what is under
// test here is the panel's selection logic, not that component.
vi.mock('@/components/ui/checkbox', () => ({
  Checkbox: ({
    checked,
    onCheckedChange,
    ...props
  }: {
    checked?: boolean
    onCheckedChange?: (checked: boolean) => void
  } & Record<string, unknown>) => (
    <input
      type="checkbox"
      checked={checked}
      onChange={(e) => onCheckedChange?.(e.currentTarget.checked)}
      {...props}
    />
  ),
}))

vi.mock('./ConnectionIndicator', () => ({
  useStableConnection: () => ({ health: { status: 'ok', rttMs: 10 }, visible: false }),
  useConnectionHealth: () => ({ status: 'ok', rttMs: 10 }),
  describeHealth: () => ({ headline: 'Connected', detail: '' }),
  ConnectionIndicator: () => null,
}))

const freed = { ok: true, stopped: ['s1'], worktreeFreed: true }
const refused = {
  ok: true,
  stopped: ['s1'],
  worktreeFreed: false,
  reason: 'sessions stopped but worktree not freed: refusing free: worktree has unsaved changes',
}

/** Open the Reclaim tab and wait for the settings-driven candidate list. */
const openReclaim = async (): Promise<void> => {
  render(<HostInfoView initialTab="reclaim" machineId="m1" onClose={vi.fn()} />)
  await screen.findByText(/2 candidates/)
}

const tick = (title: string): void => {
  fireEvent.click(screen.getByRole('checkbox', { name: title }))
}

/** The confirm dialog, once it is up. Scoped because its action button carries
 *  the same "Free N checkouts" label as the trigger that opened it. */
const confirmDialog = async (): Promise<HTMLElement> => await screen.findByRole('alertdialog')

beforeEach(() => {
  vi.clearAllMocks()
  stop.mockResolvedValue(freed)
  memoryBreakdown.mockResolvedValue({
    hostname: 'podium-host',
    sampledAt: '2026-08-08T00:00:00.000Z',
    supported: true,
    memory: { totalBytes: 32e9, availableBytes: 20e9, swapTotalBytes: 0, swapFreeBytes: 0 },
    agents: [],
    projects: [],
    otherBytes: 12e9,
  })
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }) as unknown as typeof window.matchMedia
})

afterEach(cleanup)

describe('Reclaim tab proposes rather than applies (POD-563)', () => {
  it('lists aged candidates only, with nothing ticked and no action armed', async () => {
    await openReclaim()
    // 20d and 40d are past the 14-day policy; yesterday's close is not a candidate.
    expect(screen.getByText('Old shipped thing')).toBeTruthy()
    expect(screen.getByText('Also shipped')).toBeTruthy()
    expect(screen.queryByText('Closed yesterday')).toBeNull()

    for (const box of screen.getAllByRole('checkbox')) {
      expect((box as HTMLInputElement).checked).toBe(false)
    }
    expect(screen.getByRole('button', { name: 'Free selected' }).hasAttribute('disabled')).toBe(
      true,
    )
    expect(stop).not.toHaveBeenCalled()
  })

  it('labels the action with the selection count and still stops nothing before the confirm', async () => {
    await openReclaim()
    tick('Old shipped thing')
    const action = await screen.findByRole('button', { name: 'Free 1 checkout' })
    expect(action.hasAttribute('disabled')).toBe(false)

    tick('Also shipped')
    fireEvent.click(await screen.findByRole('button', { name: 'Free 2 checkouts' }))

    // The confirm names each consequence — not just a second "are you sure".
    const dialog = within(await confirmDialog())
    expect(dialog.getByText(/2 checkouts removed from disk/)).toBeTruthy()
    expect(dialog.getByText(/Sessions on those issues are stopped/)).toBeTruthy()
    expect(dialog.getByText(/no code is lost/)).toBeTruthy()
    expect(dialog.getByText(/Uncommitted changes refuse/)).toBeTruthy()
    expect(dialog.getByText(/next agent there rebuilds the checkout/)).toBeTruthy()
    // Both ticked checkouts are named, so the count can be checked against them.
    expect(dialog.getByText('Old shipped thing')).toBeTruthy()
    expect(dialog.getByText('Also shipped')).toBeTruthy()
    expect(stop).not.toHaveBeenCalled()
  })

  it('frees exactly the ticked rows once confirmed', async () => {
    await openReclaim()
    tick('Also shipped')
    fireEvent.click(await screen.findByRole('button', { name: 'Free 1 checkout' }))
    fireEvent.click(within(await confirmDialog()).getByRole('button', { name: 'Free 1 checkout' }))

    await waitFor(() => expect(stop).toHaveBeenCalledTimes(1))
    expect(stop).toHaveBeenCalledWith({ id: 'i-mid' })
    // The untouched candidate is still on the list.
    await waitFor(() => expect(screen.queryByText('Also shipped')).toBeNull())
    expect(screen.getByText('Old shipped thing')).toBeTruthy()
  })

  it('reports a refusal as held instead of treating a non-throwing call as freed', async () => {
    stop.mockResolvedValue(refused)
    await openReclaim()
    tick('Old shipped thing')
    fireEvent.click(await screen.findByRole('button', { name: 'Free 1 checkout' }))
    fireEvent.click(within(await confirmDialog()).getByRole('button', { name: 'Free 1 checkout' }))

    await screen.findByText(/Held · 1/)
    expect(screen.getByText(/worktree has unsaved changes/)).toBeTruthy()
    // Held is not freed: it is named under Held AND still on the candidate list,
    // because the checkout is still on disk.
    expect(screen.getAllByText('Old shipped thing')).toHaveLength(2)
    expect(screen.getByText(/2 candidates/)).toBeTruthy()
  })

  it('sends the per-row Free through the same confirm', async () => {
    await openReclaim()
    fireEvent.click(screen.getByRole('button', { name: 'Free Old shipped thing' }))

    const dialog = within(await confirmDialog())
    expect(dialog.getByText(/1 checkout removed from disk/)).toBeTruthy()
    expect(stop).not.toHaveBeenCalled()

    fireEvent.click(dialog.getByRole('button', { name: 'Keep it' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    // Clicking the row's Free must not also tick its checkbox.
    expect(
      (screen.getByRole('checkbox', { name: 'Old shipped thing' }) as HTMLInputElement).checked,
    ).toBe(false)
    expect(screen.getByRole('button', { name: 'Free selected' }).hasAttribute('disabled')).toBe(
      true,
    )
  })
})

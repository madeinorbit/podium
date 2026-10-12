import '@/test-support/model-catalog-mock'
import '@/test-support/mock-core-store-handle'
// @vitest-environment happy-dom
import { FIRST_TASK_ACTIVATION_DRAFT_KEY, LAST_LAUNCH_PICK_KEY } from '@podium/client-core/ui-state'
import { asIssueId, asMachineId, asSessionId } from '@podium/model'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { modelCatalogFixture } from '@/test-support/model-catalog-mock'
import { ColdStartComposer } from './ColdStartComposer'

const a = asMachineId('machine-a')
const b = asMachineId('machine-b')
const pairs = {
  [a]: { 'claude-code': { model: 'opus', effort: 'high' }, codex: { model: 'gpt', effort: 'low' } },
  [b]: { 'claude-code': { model: 'sonnet', effort: 'low' }, codex: { model: 'gpt', effort: 'high' } },
}
const uiValues = new Map<string, string>()
const listeners = new Set<(keys: ReadonlySet<string>) => void>()
const uiSet = vi.fn((key: string, value: string | null) => {
  if (value === null) uiValues.delete(key)
  else uiValues.set(key, value)
  for (const listener of listeners) listener(new Set([key]))
})
const store = {
  repos: [
    { path: '/a/project', name: 'Project A', repoId: 'shared', kind: 'repository' as const, worktrees: [], machineId: a },
    { path: '/b/project', name: 'Project B', repoId: 'shared', kind: 'repository' as const, worktrees: [], machineId: b },
    { path: '/b/other', name: 'Other', repoId: 'other', kind: 'repository' as const, worktrees: [], machineId: b },
  ],
  sessions: [],
  machines: [a, b].map((id) => ({
    id, name: id === a ? 'Studio' : 'Remote', hostname: id, online: true,
    serviceAssignment: { server: false, agentExecution: true },
    availability: { epoch: 'boot', server: false, daemon: true, supervisor: true },
    lastSeenAt: new Date(0).toISOString(),
    inventory: { os: 'linux' as const, arch: 'x64' as const, tools: [],
      agents: ['claude-code', 'codex'].map((kind) => ({ kind, installed: true, login: { state: 'in' as const } })) },
  })),
  uiState: { get: (key: string) => uiValues.get(key) ?? null, set: uiSet,
    subscribe: (listener: (keys: ReadonlySet<string>) => void) => { listeners.add(listener); return () => listeners.delete(listener) } },
  spawnDraftAgent: vi.fn((_input: unknown) => ({ sessionId: asSessionId('new'), issueId: asIssueId('new'), settled: Promise.resolve(true) })),
  spawnIssueAgent: vi.fn(), focusIssueSession: vi.fn(async () => null),
  setSelectedIssueId: vi.fn(), setSelectedWorktree: vi.fn(), setPane: vi.fn(),
  setPanelMode: vi.fn(), setView: vi.fn(),
  trpc: { settings: { get: { query: vi.fn(async () => ({ roles: { coding: { accountId: 'native:claude-code' } } })) },
    updatePersonal: { mutate: vi.fn(async () => ({})) } },
    issues: { create: { mutate: vi.fn() }, start: { mutate: vi.fn() } },
    sessions: { uploadImage: { mutate: vi.fn() } } },
}
vi.mock('@/app/store', () => ({ useRuntimeSelector: (select: (state: typeof store) => unknown) => select(store) }))

beforeEach(() => {
  modelCatalogFixture.current = {
    'claude-code': [{ value: 'opus', label: 'Opus', efforts: ['low', 'high'] }, { value: 'sonnet', label: 'Sonnet', efforts: ['low', 'high'] }],
    codex: [{ value: 'gpt', label: 'GPT', efforts: ['low', 'high'] }],
  }
})
afterEach(() => { cleanup(); uiValues.clear(); listeners.clear(); vi.clearAllMocks(); modelCatalogFixture.current = {} })
const draft = () => JSON.parse(uiValues.get(FIRST_TASK_ACTIVATION_DRAFT_KEY) ?? '{}')
const pairWrites = () => uiSet.mock.calls.filter(([key]) => key === LAST_LAUNCH_PICK_KEY)
function seedDraft(pick: object = {}) {
  uiValues.set(FIRST_TASK_ACTIVATION_DRAFT_KEY, JSON.stringify({ repoPath: '/a/project', machineId: a, agent: 'claude-code', ...pick }))
}
async function chooseHarness(label: string) {
  fireEvent.click(screen.getByRole('button', { name: 'Agent' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: label }))
}
async function chooseMachine(from: string, to: string) {
  fireEvent.click(screen.getByRole('button', { name: from }))
  fireEvent.click(await screen.findByRole('menuitem', { name: to }))
}
async function choosePill(pill: string, choice: string) {
  fireEvent.click(screen.getByRole('button', { name: pill }))
  fireEvent.click(await screen.findByRole('menuitem', { name: choice }))
}
async function expectPair(model: string, effort: string) {
  await waitFor(() => expect(draft()).toMatchObject({ model, effort }))
  expect(screen.getByRole('button', { name: 'Model' }).textContent?.toLowerCase()).toContain(model)
}

describe('desktop last launched pair', () => {
  it('restores independent pairs for two machines and two harnesses, and Auto for an absent combination', async () => {
    seedDraft()
    uiValues.set(LAST_LAUNCH_PICK_KEY, JSON.stringify(pairs))
    render(<ColdStartComposer first={false} />)
    await expectPair('opus', 'high')
    await chooseHarness('Codex')
    await expectPair('gpt', 'low')
    await chooseMachine('Studio', 'Remote')
    await expectPair('gpt', 'high')
    await chooseHarness('Claude Code')
    await expectPair('sonnet', 'low')
    await chooseMachine('Remote', 'Studio')
    await expectPair('opus', 'high')
    // Missing combination: a harness choice replaces BOTH values with Auto.
    act(() => store.uiState.set(LAST_LAUNCH_PICK_KEY, JSON.stringify({ [a]: pairs[a] })))
    await chooseMachine('Studio', 'Remote')
    await expectPair('auto', 'auto')
  })

  it('restores the pair when switching repository moves the target machine', async () => {
    seedDraft()
    uiValues.set(LAST_LAUNCH_PICK_KEY, JSON.stringify(pairs))
    render(<ColdStartComposer first={false} />)
    await expectPair('opus', 'high')
    fireEvent.click(screen.getByRole('button', { name: /^Project:/ }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /other/ }))
    await expectPair('sonnet', 'low')
    expect(draft().machineId).toBe(b)
  })

  it.each([{ model: 'sonnet', effort: 'low' }, { model: 'opus', effort: 'low' },
    { model: 'auto', effort: 'auto', launchPickTouched: true }])('keeps a saved draft on reload: %j', async (pick) => {
    seedDraft(pick)
    uiValues.set(LAST_LAUNCH_PICK_KEY, JSON.stringify(pairs))
    const view = render(<ColdStartComposer first={false} />)
    await expectPair(pick.model, pick.effort)
    view.unmount()
    render(<ColdStartComposer first={false} />)
    await expectPair(pick.model, pick.effort)
  })

  it('choosing in menus writes no preference; launch writes the actual pair and later Auto', async () => {
    seedDraft()
    render(<ColdStartComposer first={false} />)
    await choosePill('Model', 'Opus')
    await choosePill('Effort', 'High')
    await expectPair('opus', 'high')
    expect(pairWrites()).toHaveLength(0)
    fireEvent.click(screen.getByTestId('cold-start-launch'))
    expect(JSON.parse(uiValues.get(LAST_LAUNCH_PICK_KEY)!)).toEqual({ [a]: { 'claude-code': pairs[a]['claude-code'] } })
    expect(store.spawnDraftAgent).toHaveBeenLastCalledWith(expect.objectContaining({ model: 'opus', effort: 'high' }))
    await choosePill('Model', 'Auto')
    await expectPair('auto', 'auto')
    expect(pairWrites()).toHaveLength(1)
    fireEvent.change(screen.getByLabelText('What do you want to work on?'), { target: { value: 'Start with Auto' } })
    fireEvent.click(screen.getByTestId('cold-start-launch'))
    expect(JSON.parse(uiValues.get(LAST_LAUNCH_PICK_KEY)!)).toEqual({ [a]: { 'claude-code': { model: 'auto', effort: 'auto' } } })
    expect(pairWrites()).toHaveLength(2)
    expect(store.spawnDraftAgent.mock.calls.at(-1)?.[0]).not.toHaveProperty('model')
  })

  it('restores before validating a remembered model when the machine list arrives', async () => {
    seedDraft()
    modelCatalogFixture.current = {}
    uiValues.set(LAST_LAUNCH_PICK_KEY, JSON.stringify(pairs))
    const view = render(<ColdStartComposer first={false} />)
    await expectPair('opus', 'high')
    modelCatalogFixture.current = { 'claude-code': [{ value: 'sonnet', label: 'Sonnet', efforts: ['low'] }] }
    view.rerender(<ColdStartComposer first={false} />)
    await expectPair('auto', 'auto')
    expect(pairWrites()).toHaveLength(0)
  })

  it('changing model resets effort to Auto without updating the remembered pair', async () => {
    seedDraft()
    uiValues.set(LAST_LAUNCH_PICK_KEY, JSON.stringify(pairs))
    render(<ColdStartComposer first={false} />)
    await expectPair('opus', 'high')
    await choosePill('Model', 'Sonnet')
    await expectPair('sonnet', 'auto')
    expect(pairWrites()).toHaveLength(0)
  })
})

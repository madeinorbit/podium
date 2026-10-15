import { asSessionId, type IssueDeckNode, type IssueId, type SessionMeta } from '@podium/model'
import { normalizeSettings } from '@podium/runtime'
import { afterEach, expect, it } from 'vitest'
import { openTestStore } from '../../../test-support/open-test-store'
import { sessionReadPorts } from '../../../test-support/session-facts'
import { IssueService } from '.'
import { issueTestPlumbing } from './test-plumbing'

const stores: Awaited<ReturnType<typeof openTestStore>>[] = []
afterEach(async () => { for (const store of stores.splice(0)) await store.close() })

async function fixture() {
  const store = await openTestStore(':memory:')
  stores.push(store)
  await store.repos.addRepo('/repo', store.hostMachineId)
  const sessions: SessionMeta[] = []
  const svc = await IssueService.create({
    store,
    ...sessionReadPorts(() => sessions),
    getSettings: async () => normalizeSettings({ sessionDefaults: { agent: 'codex' } }),
    spawnSession: async () => ({ sessionId: asSessionId('unused'), machine: 'fixture' }),
    repoOp: async () => ({ ok: true, output: '' }),
    ...issueTestPlumbing(),
  })
  const create = async (title: string, parentId?: IssueId, type: 'task' | 'phase' | 'decision' = 'task') =>
    await svc.crud.create({ repoPath: '/repo', title, type, ...(parentId ? { parentId } : {}), startNow: false })
  const seat = (id: string, issueId: IssueId, patch: Partial<SessionMeta> = {}) => {
    const s: SessionMeta = {
      sessionId: asSessionId(id), issueId, agentKind: 'codex', title: id, cwd: '/repo',
      status: 'live', controllerId: null, geometry: { cols: 80, rows: 24 }, epoch: 0,
      clientCount: 0, createdAt: '2026-10-15T00:00:00Z', lastActiveAt: '2026-10-15T00:00:00Z',
      ...patch,
    }
    sessions.push(s)
    return s
  }
  return { store, svc, create, seat, sessions }
}

const flatten = (root: IssueDeckNode): IssueDeckNode[] => [root, ...root.children.flatMap(flatten)]

it('orders nested phases, rolls up shared words and counts leaves without phase units', async () => {
  const { svc, create, seat } = await fixture()
  const root = await create('Mission')
  const later = await create('Later', root.id, 'phase')
  const first = await create('Build', root.id, 'phase')
  await svc.crud.update(first.id, { sortKey: 'a0' })
  await svc.crud.update(later.id, { sortKey: 'a1' })
  const parent = await create('Parent task', first.id)
  const nested = await create('Nested phase', parent.id, 'phase')
  const crashed = await create('Crashed task', nested.id)
  const decision = await create('Choose approach', nested.id, 'decision')
  const closed = await create('Cancelled task', later.id)
  await svc.crud.close(closed.id, 'cancelled')
  const blocked = await create('External wait', root.id)
  const external = await create('External task')
  await svc.hierarchy.addDep(blocked.id, external.id)
  await svc.hierarchy.addDep(decision.id, closed.id)
  seat('working', crashed.id, { agentState: { phase: 'working' } })
  seat('crash', crashed.id, { status: 'exited', stopReason: 'oom', exitCode: 137 })
  const deck = await svc.reports.deck(root.id)
  expect(deck.root.children.map((row) => row.title)).toEqual(['Build', 'Later', 'External wait'])
  expect(deck.root.word).toBe('error')
  expect(deck.counts).toMatchObject({ total: 4, done: 1, error: 1, 'needs-you': 1, blocked: 1 })
  const nodes = new Map(flatten(deck.root).map((row) => [row.id, row]))
  expect(nodes.get(parent.id)?.counter).toEqual({ done: 0, total: 2 })
  expect(nodes.get(closed.id)?.hidden).toBe(true)
  expect(nodes.get(decision.id)?.blockers).toEqual([])
  expect(nodes.get(blocked.id)?.blockers).toEqual([
    expect.objectContaining({ id: external.id, external: true, title: 'External task' }),
  ])
})

it('shows marker-derived seats and shared session words, excluding non-roster sessions', async () => {
  const { svc, create, seat } = await fixture()
  const root = await create('Mission')
  const phase = await create('Build', root.id, 'phase')
  const task = await create('Task', phase.id)
  const coordinator = seat('coordinator', root.id)
  const lead = seat('lead', phase.id, { status: 'hibernated' })
  const worker = seat('worker', task.id, { agentState: { phase: 'compacting' }, model: 'configured', observedModel: 'actual' })
  seat('helper', task.id, { offer: { message: 'Review ready', actions: [], createdAt: '2026-10-15T00:00:00Z' } })
  seat('archived', task.id, { archived: true, agentState: { phase: 'errored' } })
  seat('headless', task.id, { headless: true })
  seat('shell', task.id, { agentKind: 'shell' })
  const parked = { status: 'hibernated' as const, resume: { kind: 'codex' as const, value: 'same' } }
  seat('old', task.id, { ...parked, lastActiveAt: '2026-10-14T00:00:00Z' })
  seat('new', task.id, parked)
  await svc.crud.setCoordinator(root.id, coordinator.sessionId)
  await svc.crud.setCoordinator(phase.id, lead.sessionId)
  await svc.crud.setCoordinator(task.id, worker.sessionId)
  const deck = await svc.reports.deck(root.id)
  expect(deck.root.sessions[0]).toMatchObject({ seat: 'coordinator', word: 'idle' })
  expect(deck.root.children[0]?.sessions[0]).toMatchObject({ seat: 'phase-lead', word: 'idle' })
  const row = deck.root.children[0]!.children[0]!
  expect(row.sessions).toEqual([
    expect.objectContaining({ seat: 'worker', word: 'working', model: 'actual' }),
    expect.objectContaining({ sessionId: asSessionId('helper'), seat: 'helper', word: 'needs-you' }),
    expect.objectContaining({ sessionId: asSessionId('new'), seat: 'helper', word: 'idle' }),
  ])
  expect(row.word).toBe('needs-you')
})

it('lists formal and provenance proposals with author and placement, excluding departed discoveries', async () => {
  const { svc, create, seat } = await fixture()
  const root = await create('Mission')
  const author = seat('author', root.id, { displayRef: 'POD-1-A' })
  const proposal = await svc.crud.create({ repoPath: '/repo', title: 'Own proposal', stage: 'proposed', startedBySession: author.sessionId, startNow: false })
  await svc.hierarchy.addDep(proposal.id, root.id, 'discovered-from')
  const formal = await svc.crud.create({ repoPath: '/repo', title: 'Here proposal', parentId: root.id, stage: 'proposed', startedBySession: author.sessionId, startNow: false })
  const active = await svc.crud.create({ repoPath: '/repo', title: 'Started discovery', startedBySession: author.sessionId, startNow: false })
  await svc.hierarchy.addDep(active.id, root.id, 'discovered-from')
  await svc.crud.update(active.id, { stage: 'in_progress' })
  const deck = await svc.reports.deck(root.id)
  expect(deck.root.children).toEqual([])
  expect(deck.proposals).toEqual([
    expect.objectContaining({ id: formal.id, placement: 'here', proposedBy: { sessionId: author.sessionId, displayRef: 'POD-1-A' } }),
    expect.objectContaining({ id: proposal.id, placement: 'own-issue' }),
  ])
  expect(JSON.stringify(deck)).not.toContain(active.id)
})

it('filters hidden issues, dependency targets and sessions before deriving state or counts', async () => {
  const { svc, create, seat } = await fixture()
  const root = await create('Visible mission')
  const hidden = await create('Private child', root.id, 'decision')
  const visible = await create('Visible task', root.id)
  await svc.hierarchy.addDep(visible.id, hidden.id)
  seat('private-session', hidden.id, { agentState: { phase: 'errored' } })
  const deck = await svc.reports.deck(root.id, (id) => id !== hidden.id)
  expect(deck.counts).toMatchObject({ total: 1, 'not-started': 1, error: 0, blocked: 0 })
  expect(JSON.stringify(deck)).not.toContain('Private')
  expect(JSON.stringify(deck)).not.toContain('private-session')
  await expect(svc.reports.deck(root.id, () => false)).rejects.toThrow()
})

it('includes pending permission asks in session and task words', async () => {
  const { store, svc, create, seat } = await fixture()
  const root = await create('Mission')
  const session = seat('asking', root.id)
  await store.interactions.insert({
    id: 'ask', sessionId: session.sessionId, kind: 'permission', payload: {},
    source: 'protocol', answerable: 'structured', fingerprint: 'ask', askedAt: '2026-10-15T00:00:00Z',
  })
  const deck = await svc.reports.deck(root.id)
  expect(deck.root.word).toBe('needs-you')
  expect(deck.root.sessions[0]?.word).toBe('needs-you')
})

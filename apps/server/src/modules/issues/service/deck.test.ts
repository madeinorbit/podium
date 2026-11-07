import {
  asSessionId,
  type IssueDeckNode,
  type IssueId,
  type SessionId,
  type SessionMeta,
} from '@podium/model'
import { normalizeSettings } from '@podium/runtime'
import { afterEach, expect, it } from 'vitest'
import { openTestStore } from '../../../test-support/open-test-store'
import { sessionReadPorts } from '../../../test-support/session-facts'
import { IssueService } from '.'
import { issueTestPlumbing } from './test-plumbing'

const stores: Awaited<ReturnType<typeof openTestStore>>[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
})

async function fixture() {
  const store = await openTestStore(':memory:')
  stores.push(store)
  await store.repos.addRepo('/repo', store.hostMachineId)
  await store.repos.setRepoPrefix(store.hostMachineId, '/repo', 'POD')
  const sessions: SessionMeta[] = []
  const hiddenSessions = new Set<SessionId>()
  const ports = sessionReadPorts(() => sessions)
  const svc = await IssueService.create({
    store,
    ...ports,
    sessionsById: async (ids) =>
      (await ports.sessionsById(ids)).filter((s) => !hiddenSessions.has(s.sessionId)),
    getSettings: async () => normalizeSettings({ sessionDefaults: { agent: 'codex' } }),
    spawnSession: async () => ({ sessionId: asSessionId('unused'), machine: 'fixture' }),
    repoOp: async () => ({ ok: true, output: '' }),
    ...issueTestPlumbing(),
  })
  const create = async (
    title: string,
    parentId?: IssueId,
    type: 'task' | 'phase' | 'decision' = 'task',
  ) =>
    await svc.crud.create(svc.reports.store.serverWriter, {
      repoPath: '/repo',
      title,
      type,
      ...(parentId ? { parentId } : {}),
      startNow: false,
    })
  const seat = (id: string, issueId: IssueId, patch: Partial<SessionMeta> = {}) => {
    const s: SessionMeta = {
      sessionId: asSessionId(id),
      issueId,
      agentKind: 'codex',
      title: id,
      cwd: '/repo',
      machineId: store.hostMachineId,
      status: 'live',
      controllerId: null,
      geometry: { cols: 80, rows: 24 },
      epoch: 0,
      clientCount: 0,
      createdAt: '2026-10-15T00:00:00Z',
      lastActiveAt: '2026-10-15T00:00:00Z',
      origin: { kind: 'spawn' },
      archived: false,
      ...patch,
    }
    sessions.push(s)
    return s
  }
  return { store, svc, create, seat, sessions, hiddenSessions }
}

const flatten = (root: IssueDeckNode): IssueDeckNode[] => [root, ...root.children.flatMap(flatten)]
const agentState = (
  phase: NonNullable<SessionMeta['agentState']>['phase'],
): NonNullable<SessionMeta['agentState']> => ({
  phase,
  since: '2026-10-15T00:00:00Z',
  nativeSubagentCount: 0,
})

it('orders nested phases, rolls up shared words and counts leaves without phase units', async () => {
  const { svc, create, seat } = await fixture()
  const root = await create('Mission')
  const later = await create('Later', root.id, 'phase')
  const first = await create('Build', root.id, 'phase')
  await svc.crud.move(svc.reports.store.serverWriter, first.id, { before: later.id })
  const parent = await create('Parent task', first.id)
  const nested = await create('Nested phase', parent.id, 'phase')
  const crashed = await create('Crashed task', nested.id)
  const decision = await create('Choose approach', nested.id, 'decision')
  const closed = await create('Cancelled task', later.id)
  await svc.crud.close(svc.reports.store.serverWriter, closed.id, 'cancelled')
  const blocked = await create('External wait', root.id)
  const external = await create('External task')
  await svc.crud.move(svc.reports.store.serverWriter, blocked.id, { after: later.id })
  await svc.hierarchy.addDep(svc.reports.store.serverWriter, blocked.id, external.id)
  await svc.hierarchy.addDep(svc.reports.store.serverWriter, decision.id, closed.id)
  seat('working', crashed.id, { agentState: agentState('working') })
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

it('reads a phase Done once its tasks are closed, though nobody closed the phase (POD-2178)', async () => {
  const { svc, create } = await fixture()
  const root = await create('Mission')
  const build = await create('Build', root.id, 'phase')
  const empty = await create('Release', root.id, 'phase')
  const a = await create('Server part', build.id)
  const b = await create('Web part', build.id)
  await svc.crud.close(svc.reports.store.serverWriter, a.id, 'completed')
  const word = async (id: IssueId) =>
    flatten((await svc.reports.deck(root.id)).root).find((row) => row.id === id)?.word
  expect(await word(build.id)).toBe('idle')
  await svc.crud.close(svc.reports.store.serverWriter, b.id, 'completed')
  expect(await word(build.id)).toBe('done')
  expect(await word(empty.id)).toBe('not-started')
  expect((await svc.crud.store.rowOrThrow(build.id)).stage).not.toBe('done')
})

it('shows marker-derived seats and shared session words, excluding non-roster sessions', async () => {
  const { svc, create, seat } = await fixture()
  const root = await create('Mission')
  const phase = await create('Build', root.id, 'phase')
  const task = await create('Task', phase.id)
  const coordinator = seat('coordinator', root.id)
  const lead = seat('lead', phase.id, { status: 'hibernated' })
  const worker = seat('worker', task.id, {
    agentState: agentState('compacting'),
    model: 'configured',
    observedModel: 'actual',
  })
  seat('helper', task.id, {
    offer: { message: 'Review ready', actions: [], createdAt: '2026-10-15T00:00:00Z' },
  })
  seat('archived', task.id, { archived: true, agentState: agentState('errored') })
  seat('headless', task.id, { headless: true })
  seat('shell', task.id, { agentKind: 'shell' })
  const parked = {
    status: 'hibernated' as const,
    resume: { kind: 'codex' as const, value: 'same' },
  }
  seat('old', task.id, { ...parked, lastActiveAt: '2026-10-14T00:00:00Z' })
  seat('new', task.id, parked)
  await svc.crud.setCoordinator(svc.reports.store.serverWriter, root.id, coordinator.sessionId)
  await svc.crud.setCoordinator(svc.reports.store.serverWriter, phase.id, lead.sessionId)
  await svc.crud.setCoordinator(svc.reports.store.serverWriter, task.id, worker.sessionId)
  const deck = await svc.reports.deck(root.id)
  expect(deck.root.sessions[0]).toMatchObject({ seat: 'coordinator', word: 'idle' })
  expect(deck.root.children[0]?.sessions[0]).toMatchObject({ seat: 'phase-lead', word: 'idle' })
  const row = deck.root.children[0]!.children[0]!
  expect(row.sessions).toEqual([
    expect.objectContaining({ seat: 'worker', word: 'working', model: 'actual' }),
    expect.objectContaining({
      sessionId: asSessionId('helper'),
      seat: 'helper',
      word: 'needs-you',
    }),
    expect.objectContaining({ sessionId: asSessionId('new'), seat: 'helper', word: 'idle' }),
  ])
  // POD-2171: the helper's offer is for the live worker that coordinates the
  // task, so the task reads Working. The helper's own line still asks.
  expect(row.word).toBe('working')
})

it('asks only through a live coordinator, and escalates delegate exceptions (POD-2171)', async () => {
  const { svc, create, seat, sessions } = await fixture()
  const root = await create('Mission')
  const task = await create('Task', root.id)
  const reviewed = await create('Reviewed', root.id)
  const coordinator = seat('coordinator', root.id, {
    agentState: { ...agentState('idle'), idle: { kind: 'done' } },
  })
  seat('worker', task.id, { agentState: agentState('working') })
  const asking = seat('asking', reviewed.id, {
    agentState: { ...agentState('idle'), idle: { kind: 'question' } },
  })
  await svc.crud.setCoordinator(svc.reports.store.serverWriter, root.id, coordinator.sessionId)
  const words = async () => {
    const deck = await svc.reports.deck(root.id)
    const nodes = new Map(flatten(deck.root).map((row) => [row.id, row.word]))
    return { root: deck.root.word, reviewed: nodes.get(reviewed.id) }
  }
  expect(await words()).toEqual({ root: 'working', reviewed: 'needs-you' })
  asking.agentState = agentState('needs_user')
  expect(await words()).toEqual({ root: 'needs-you', reviewed: 'needs-you' })
  asking.agentState = agentState('errored')
  expect(await words()).toEqual({ root: 'error', reviewed: 'error' })
  asking.agentState = { ...agentState('idle'), idle: { kind: 'question' } }
  coordinator.offer = { message: 'Ready', actions: [], createdAt: '2026-10-15T00:00:00Z' }
  expect((await words()).root).toBe('needs-you')
  coordinator.offer = undefined
  coordinator.status = 'exited'
  expect(sessions.length).toBe(3)
  expect(await words()).toEqual({ root: 'needs-you', reviewed: 'needs-you' })
})

it('lists formal and provenance proposals with author and placement, excluding departed discoveries', async () => {
  const { svc, create, seat } = await fixture()
  const root = await create('Mission')
  const author = seat('author', root.id, { refIssueId: root.id, refLetter: 'A' })
  const proposal = await svc.crud.create(svc.reports.store.serverWriter, {
    repoPath: '/repo',
    title: 'Own proposal',
    stage: 'proposed',
    startedBySession: author.sessionId,
    startNow: false,
  })
  await svc.hierarchy.addDep(svc.reports.store.serverWriter, proposal.id, root.id, 'discovered-from')
  const formal = await svc.crud.create(svc.reports.store.serverWriter, {
    repoPath: '/repo',
    title: 'Here proposal',
    parentId: root.id,
    stage: 'proposed',
    startedBySession: author.sessionId,
    startNow: false,
  })
  const proposedChild = await create('Proposed subtree', formal.id, 'decision')
  const accepted = await create('Accepted task', root.id)
  const active = await svc.crud.create(svc.reports.store.serverWriter, {
    repoPath: '/repo',
    title: 'Started discovery',
    startedBySession: author.sessionId,
    startNow: false,
  })
  await svc.hierarchy.addDep(svc.reports.store.serverWriter, active.id, root.id, 'discovered-from')
  await svc.crud.update(svc.reports.store.serverWriter, active.id, { stage: 'in_progress' })
  const deck = await svc.reports.deck(root.id)
  expect(deck.root.children.map((row) => row.id)).toEqual([accepted.id])
  expect(deck.counts).toMatchObject({ total: 1, 'not-started': 1, 'needs-you': 0 })
  expect(deck.root.word).toBe('idle')
  expect(deck.proposals).toEqual([
    expect.objectContaining({ id: proposal.id, placement: 'own-issue' }),
    expect.objectContaining({
      id: formal.id,
      placement: 'here',
      word: 'needs-you',
      proposedBy: { sessionId: author.sessionId, displayRef: 'POD-1-A' },
      children: [expect.objectContaining({ id: proposedChild.id })],
    }),
  ])
  expect(JSON.stringify(deck)).not.toContain(active.id)
})

it('filters hidden issues, dependency targets and sessions before deriving state or counts', async () => {
  const { svc, create, seat } = await fixture()
  const root = await create('Visible mission')
  const hidden = await create('Private child', root.id, 'decision')
  const visible = await create('Visible task', root.id)
  await svc.hierarchy.addDep(svc.reports.store.serverWriter, visible.id, hidden.id)
  seat('private-session', hidden.id, { agentState: agentState('errored') })
  const deck = await svc.reports.deck(root.id, { readableBy: () => null, mayRead: (id) => id !== hidden.id })
  expect(deck.counts).toMatchObject({ total: 1, 'not-started': 1, error: 0, blocked: 0 })
  expect(JSON.stringify(deck)).not.toContain('Private')
  expect(JSON.stringify(deck)).not.toContain('private-session')
  await expect(svc.reports.deck(root.id, { readableBy: () => null, mayRead: () => false })).rejects.toThrow()
})

it('includes pending permission asks in session and task words', async () => {
  const { store, svc, create, seat } = await fixture()
  const root = await create('Mission')
  const session = seat('asking', root.id)
  await store.interactions.insert({
    id: 'ask',
    sessionId: session.sessionId,
    kind: 'permission',
    payload: {},
    source: 'protocol',
    answerable: 'structured',
    fingerprint: 'ask',
    askedAt: '2026-10-15T00:00:00Z',
  })
  const deck = await svc.reports.deck(root.id)
  expect(deck.root.word).toBe('needs-you')
  expect(deck.root.sessions[0]?.word).toBe('needs-you')
})

it('cannot expose a private session through a seat, word, or provenance proposal', async () => {
  const { svc, create, seat, hiddenSessions } = await fixture()
  const root = await create('Mission')
  const privateSession = seat('private', root.id, { agentState: agentState('errored') })
  hiddenSessions.add(privateSession.sessionId)
  await svc.crud.create(svc.reports.store.serverWriter, {
    repoPath: '/repo',
    title: 'Private discovery',
    stage: 'proposed',
    startedBySession: privateSession.sessionId,
    startNow: false,
  })
  const deck = await svc.reports.deck(root.id)
  expect(deck.root.word).toBe('not-started')
  expect(deck.root.sessions).toEqual([])
  expect(deck.proposals).toEqual([])
})

it('collapses parked twins across deck boundaries without letting a private twin hide a seat', async () => {
  const { svc, create, seat, hiddenSessions } = await fixture()
  const root = await create('Mission')
  const elsewhere = await create('Other mission')
  const resume = { kind: 'codex', value: 'one-conversation' }
  const old = seat('old', root.id, {
    status: 'hibernated',
    resume,
    refIssueId: root.id,
    refLetter: 'A',
    lastActiveAt: '2026-10-14T00:00:00Z',
  })
  const current = seat('current', elsewhere.id, { status: 'hibernated', resume })
  await svc.crud.create(svc.reports.store.serverWriter, {
    repoPath: '/repo',
    title: 'Formal proposal',
    stage: 'proposed',
    parentId: root.id,
    startedBySession: old.sessionId,
    startNow: false,
  })
  const deck = await svc.reports.deck(root.id)
  expect(deck.root.sessions).toEqual([])
  expect(deck.proposals[0]?.proposedBy).toBeNull()
  hiddenSessions.add(current.sessionId)
  const privateTwin = await svc.reports.deck(root.id)
  expect(privateTwin.root.sessions).toEqual([
    expect.objectContaining({ sessionId: old.sessionId, displayRef: 'POD-1-A' }),
  ])
  expect(privateTwin.proposals[0]?.proposedBy).toEqual({
    sessionId: old.sessionId,
    displayRef: 'POD-1-A',
  })
})

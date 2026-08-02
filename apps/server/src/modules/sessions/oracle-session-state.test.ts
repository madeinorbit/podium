import { attachTestClient } from '../../test-support/client-transport'
/**
 * ORACLE — session-state session writes (POD-379 for POD-312 / POD-380).
 *
 * rename · setArchived · markRead / markUnread · setWorkState · setIssueId ·
 * snoozes · pins · tab order · composer drafts.
 *
 * Each one pins: what is PERSISTED, what is VOLATILE, what is FANNED OUT to
 * other clients, and the precedence rule the write obeys. See oracle-support.ts
 * for the must-not-change / will-change contract.
 */

import { SOLE_USER_ID } from '@podium/model'
import { type ServerMessage, WIRE_VERSION } from '@podium/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { disposeOracles, MUST_NOT_CHANGE, makeOracle, provisional, waitFor } from './oracle-support'

afterEach(() => disposeOracles())

const sessionChanges = (client: ServerMessage[], sessionId: string) =>
  client.flatMap((message) =>
    message.type === 'feedDelta' || message.type === 'feedBootstrap'
      ? message.changes.filter(
          (change) => change.entity === 'session' && change.entityId === sessionId,
        )
      : [],
  )

const lastSession = (client: ServerMessage[], sessionId: string) =>
  sessionChanges(client, sessionId)
    .filter((change) => change.op === 'upsert')
    .at(-1)?.value as { name?: string; readAt?: string; draftUpdatedAt?: string } | undefined

describe('oracle: rename (the curated name slot)', () => {
  it(`${MUST_NOT_CHANGE}: rename trims, persists the name, and stamps nameSource 'user'`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'shell', cwd: '/p' })

    await o.call.sessions.rename({ sessionId, name: '  Deploy pipeline  ' })

    expect(o.meta(sessionId)).toMatchObject({ name: 'Deploy pipeline', nameSource: 'user' })
    const row = o.store.sessions.loadSessions().find((r) => r.id === sessionId)
    expect(row).toMatchObject({ name: 'Deploy pipeline', nameSource: 'user' })
    await waitFor(
      () => lastSession(o.client, sessionId)?.name === 'Deploy pipeline',
      'the rename to reach the attached client',
    )
  })

  it(`${MUST_NOT_CHANGE}: clearing the name (empty string) also clears nameSource, so an agent may name it again`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'shell', cwd: '/p' })
    await o.call.sessions.rename({ sessionId, name: 'Human pick' })

    await o.call.sessions.rename({ sessionId, name: '' })

    // An empty curated name is OMITTED from the wire, not sent as ''.
    expect(o.meta(sessionId).name).toBeUndefined()
    expect(o.meta(sessionId).nameSource).toBeUndefined()
    // The precedence rule that depends on it: with the stamp gone, the agent wins.
    expect(o.reg.modules.sessions.setAgentName({ sessionId, name: 'agent pick' })).toEqual({
      ok: true,
      name: 'agent pick',
    })
    expect(o.meta(sessionId)).toMatchObject({ name: 'agent pick', nameSource: 'agent' })
  })

  it(`${MUST_NOT_CHANGE}: a user-set name is sovereign — setAgentName refuses it and returns a reason instead of throwing [spec:SP-eb60]`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'shell', cwd: '/p' })
    await o.call.sessions.rename({ sessionId, name: 'Human pick' })

    const refused = o.reg.modules.sessions.setAgentName({ sessionId, name: 'agent pick' })

    expect(refused.ok).toBe(false)
    expect(refused.name).toBe('Human pick')
    expect(typeof refused.reason).toBe('string')
    expect(o.meta(sessionId)).toMatchObject({ name: 'Human pick', nameSource: 'user' })
  })

  it(`${MUST_NOT_CHANGE}: an agent may overwrite its OWN earlier agent-set name`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'shell', cwd: '/p' })
    o.reg.modules.sessions.setAgentName({ sessionId, name: 'first guess' })

    expect(o.reg.modules.sessions.setAgentName({ sessionId, name: 'second guess' }).ok).toBe(true)
    expect(o.meta(sessionId)).toMatchObject({ name: 'second guess', nameSource: 'agent' })
  })
})

describe('oracle: setArchived', () => {
  it(`${MUST_NOT_CHANGE}: archiving persists the flag AND parks a running session, keeping readAt untouched`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'shell', cwd: '/p' })
    o.reg.gateway.routeDaemonFrame(o.reg.sessionStore.hostMachineId, {
      type: 'bind',
      sessionId,
      cmd: 'bash',
      cwd: '/p',
      agentKind: 'shell',
      geometry: { cols: 80, rows: 24 },
    })
    await o.call.sessions.markRead({ sessionId })
    const readAtBefore = o.meta(sessionId).readAt
    expect(readAtBefore).not.toBeNull()

    await o.call.sessions.setArchived({ sessionId, archived: true })

    const meta = o.meta(sessionId)
    // Archive stops the process (POD-108): a shell keeps its resume-free park.
    expect(meta.archived).toBe(true)
    expect(meta.status).toBe('hibernated')
    expect(meta.stopReason).toBe('parent')
    expect(typeof meta.stoppedAt).toBe('string')
    // Archiving IS the acknowledgment — it must not resurface as unread.
    expect(meta.readAt).toBe(readAtBefore)
    expect(o.daemon).toContainEqual(expect.objectContaining({ type: 'kill', sessionId }))
  })

  it(`${MUST_NOT_CHANGE}: unarchiving does NOT resurrect the process — that stays an explicit resume`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'shell', cwd: '/p' })
    o.reg.gateway.routeDaemonFrame(o.reg.sessionStore.hostMachineId, {
      type: 'bind',
      sessionId,
      cmd: 'bash',
      cwd: '/p',
      agentKind: 'shell',
      geometry: { cols: 80, rows: 24 },
    })
    await o.call.sessions.setArchived({ sessionId, archived: true })
    const spawnsAfterArchive = o.daemon.filter((m) => m.type === 'spawn').length

    await o.call.sessions.setArchived({ sessionId, archived: false })

    expect(o.meta(sessionId)).toMatchObject({ archived: false, status: 'hibernated' })
    expect(o.daemon.filter((m) => m.type === 'spawn')).toHaveLength(spawnsAfterArchive)
  })

  it(`${MUST_NOT_CHANGE}: archiving an already-parked session does not re-kill it`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'shell', cwd: '/p' })
    o.reg.gateway.routeDaemonFrame(o.reg.sessionStore.hostMachineId, {
      type: 'agentExit',
      sessionId,
      code: 0,
    })
    expect(o.meta(sessionId).status).toBe('exited')
    const killsBefore = o.daemon.filter((m) => m.type === 'kill').length

    await o.call.sessions.setArchived({ sessionId, archived: true })

    expect(o.meta(sessionId)).toMatchObject({ archived: true, status: 'exited' })
    expect(o.daemon.filter((m) => m.type === 'kill')).toHaveLength(killsBefore)
  })
})

describe('oracle: read state', () => {
  // RESOLVED by POD-1076 (was: will-change "readAt becomes per-user once POD-1077
  // makes fan-out per-principal; POD-380 left the row in place"). The storage half
  // is done: `sessions.read_at` is gone and the marker lives in
  // `session_user_state` keyed (user_id, session_id).
  //
  // What is asserted here is now the RESIDUAL, and it is a property of the FEED,
  // not of the storage: the broadcast is still unscoped (ADR 2 D2), so both
  // clients — which are two DEVICES of the same person, not two people — see the
  // same value. POD-1077 makes fan-out per-principal; nothing about this row
  // changes when it does, because the row already has an owner.
  it(`${MUST_NOT_CHANGE}: readAt is stored PER USER, and the unscoped feed serves one viewer to every device`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'shell', cwd: '/p' })
    const second: ServerMessage[] = []
    const secondId = attachTestClient(o.reg.clientGateway, (m) => second.push(m))
    o.reg.clientGateway.routeClientFrame(secondId, {
      type: 'hello',
      wireVersion: WIRE_VERSION,
      clientId: '',
      viewport: { cols: 80, rows: 24, dpr: 1 },
    })

    await o.call.sessions.markRead({ sessionId })

    const readAt = o.meta(sessionId).readAt
    expect(typeof readAt).toBe('string')
    // Both DEVICES of the one principal see the same readAt — the feed is unscoped.
    await waitFor(
      () => lastSession(second, sessionId)?.readAt === readAt,
      "the other client to observe this operator's readAt",
    )

    // THE FLIPPED ASSERTION. It used to read the marker off the SESSION ROW
    // (`loadSessions().find(...).readAt`); that column no longer exists and the
    // value is one user's row. Reading the STORAGE, not merely the wire, is what
    // makes this a measurement of the re-key rather than of the projection that
    // happens to sit on top of it.
    expect(o.store.sessions.getReadAt(SOLE_USER_ID, sessionId)).toBe(readAt)
    // A DIFFERENT user has no marker for the same session — the property the
    // re-key exists for, and one an instance-wide column could not express.
    expect(o.store.sessions.getReadAt('user:somebody-else', sessionId)).toBeNull()
  })

  it(`${MUST_NOT_CHANGE}: markRead flips derived unread to false; markUnread clears readAt and flips it back`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'shell', cwd: '/p' })
    expect(o.meta(sessionId)).toMatchObject({ readAt: null, unread: true })

    await o.call.sessions.markRead({ sessionId })
    expect(o.meta(sessionId).unread).toBe(false)

    await o.call.sessions.markUnread({ sessionId })
    expect(o.meta(sessionId)).toMatchObject({ readAt: null, unread: true })
  })

  it(`${MUST_NOT_CHANGE}: readAt is an ISO-8601 string, not epoch ms (the unread compare is lexical)`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'shell', cwd: '/p' })

    await o.call.sessions.markRead({ sessionId })

    const readAt = o.meta(sessionId).readAt as string
    expect(readAt).toBe(new Date(readAt).toISOString())
  })
})

describe('oracle: setWorkState', () => {
  it(`${MUST_NOT_CHANGE}: setWorkState persists the value and clearing it with null removes the field from the wire`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'shell', cwd: '/p' })

    await o.call.sessions.setWorkState({ sessionId, workState: 'testing' })
    expect(o.meta(sessionId).workState).toBe('testing')
    expect(o.store.sessions.loadSessions().find((r) => r.id === sessionId)?.workState).toBe(
      'testing',
    )

    await o.call.sessions.setWorkState({ sessionId, workState: null })
    expect(o.meta(sessionId).workState).toBeUndefined()
    expect(o.store.sessions.loadSessions().find((r) => r.id === sessionId)?.workState).toBeNull()
  })
})

describe('oracle: setIssueId', () => {
  it(`${MUST_NOT_CHANGE}: attaching an issue is a NAMING POINT (it allocates a ref letter); detaching is not`, async () => {
    const o = makeOracle()
    const issue = o.reg.issues.create({ repoPath: '/p', title: 'target', startNow: false })
    const { sessionId } = await o.call.sessions.create({ agentKind: 'shell', cwd: '/p' })

    await o.call.sessions.setIssueId({ sessionId, issueId: issue.id })
    expect(o.meta(sessionId).issueId).toBe(issue.id)
    const attached = o.store.sessions.loadSessions().find((r) => r.id === sessionId)
    expect(attached?.refIssueId).toBe(issue.id)
    expect(typeof attached?.refLetter).toBe('string')

    await o.call.sessions.setIssueId({ sessionId, issueId: null })
    expect(o.meta(sessionId).issueId).toBeUndefined()
    // The ref allocation is NOT rewound — a detach must not mint a DRAFT ordinal.
    const detached = o.store.sessions.loadSessions().find((r) => r.id === sessionId)
    expect(detached?.refIssueId).toBe(issue.id)
    expect(detached?.refLetter).toBe(attached?.refLetter)
  })
})

describe('oracle: snoozes', () => {
  // RESOLVED by POD-380 (was: will-change POD-1076 "snooze becomes per-user
  // state"). The characterization is REWRITTEN rather than duplicated: adding a
  // per-user test beside the old one would leave the old one still asserting, and
  // still NAMED for, instance-wide snooze.
  it(`${MUST_NOT_CHANGE}: a snooze is stored against the WRITER's user id, and another user's slice does not contain it`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'shell', cwd: '/p' })
    const until = new Date(Date.now() + 60_000).toISOString()

    const returned = await o.call.snoozes.set({ sessionId, until })

    // The caller's own view is unchanged from before the re-key — the wire shape
    // and the returned map are byte-identical for the single-user case.
    expect(returned).toEqual({ [sessionId]: until })
    expect(await o.call.snoozes.list()).toEqual({ [sessionId]: until })
    expect(o.meta(sessionId).snoozedUntil).toBe(until)
    // And the row is KEYED by user: a different principal's slice is empty. This
    // is the assertion the old instance-wide characterization could not make.
    expect(o.store.sessions.listSnoozes(SOLE_USER_ID)).toEqual({ [sessionId]: until })
    expect(o.store.sessions.listSnoozes('user:somebody-else')).toEqual({})
  })

  it(`${MUST_NOT_CHANGE}: until=null means "until next message" and never lapses by time`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'shell', cwd: '/p' })

    await o.call.snoozes.set({ sessionId, until: null })

    expect(await o.call.snoozes.list()).toEqual({ [sessionId]: null })
    // Housekeeping only drops TIMED snoozes whose deadline passed.
    expect(
      o.store.sessions.listSnoozes(SOLE_USER_ID, Date.now() + 10 * 365 * 24 * 3_600_000),
    ).toEqual({
      [sessionId]: null,
    })
  })

  it(`${MUST_NOT_CHANGE}: a lapsed timed snooze is lazily deleted on read`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'shell', cwd: '/p' })
    const until = new Date(Date.now() + 1_000).toISOString()
    await o.call.snoozes.set({ sessionId, until })

    expect(o.store.sessions.listSnoozes(SOLE_USER_ID, Date.parse(until) + 1)).toEqual({})
    // The lazy delete is a real write: the row is gone on the next read too.
    expect(o.store.sessions.listSnoozes(SOLE_USER_ID, Date.parse(until) - 500)).toEqual({})
  })

  it(`${MUST_NOT_CHANGE}: clear removes the row and the wire field`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'shell', cwd: '/p' })
    await o.call.snoozes.set({ sessionId, until: null })

    expect(await o.call.snoozes.clear({ sessionId })).toEqual({})
    expect(o.meta(sessionId).snoozedUntil).toBeUndefined()
  })
})

describe('oracle: pins', () => {
  // RESOLVED by POD-380 (was: will-change POD-1076 "pins become per-user state").
  it(`${MUST_NOT_CHANGE}: a pin is keyed (userId, kind, id) — the writer sees it and another user's slice does not`, async () => {
    const o = makeOracle()

    const after = await o.call.pins.set({ kind: 'panel', id: 'sess-1', pinned: true })

    expect(after).toEqual({ panels: ['sess-1'], worktrees: [], repos: [] })
    expect(await o.call.pins.list()).toEqual({ panels: ['sess-1'], worktrees: [], repos: [] })
    expect(o.store.sessions.listPins('user:somebody-else')).toEqual({
      panels: [],
      worktrees: [],
      repos: [],
    })
  })

  it(`${MUST_NOT_CHANGE}: pinning is insertion-ordered and idempotent; unpinning removes`, async () => {
    const o = makeOracle()
    await o.call.pins.set({ kind: 'worktree', id: '/a', pinned: true })
    await o.call.pins.set({ kind: 'worktree', id: '/b', pinned: true })
    await o.call.pins.set({ kind: 'worktree', id: '/a', pinned: true })

    expect((await o.call.pins.list()).worktrees).toEqual(['/a', '/b'])

    expect(
      (await o.call.pins.set({ kind: 'worktree', id: '/a', pinned: false })).worktrees,
    ).toEqual(['/b'])
  })
})

describe('oracle: tab order', () => {
  // RESOLVED by POD-380 (was: will-change POD-1076 "tab order becomes per-user").
  it(`${MUST_NOT_CHANGE}: tab order is keyed (userId, worktree) — the writer sees it and another user's slice does not`, async () => {
    const o = makeOracle()
    const a = (await o.call.sessions.create({ agentKind: 'shell', cwd: '/a' })).sessionId
    const b = (await o.call.sessions.create({ agentKind: 'shell', cwd: '/b' })).sessionId

    const after = await o.call.tabs.setOrder({ worktree: '/w', sessionIds: [b, a] })

    expect(after).toEqual({ '/w': [b, a] })
    expect(await o.call.tabs.listOrders()).toEqual({ '/w': [b, a] })
    expect(o.store.sessions.listTabOrders('user:somebody-else')).toEqual({})
  })

  it(`${MUST_NOT_CHANGE}: an empty sessionIds array DELETES the saved order rather than storing an empty one`, async () => {
    const o = makeOracle()
    const a = (await o.call.sessions.create({ agentKind: 'shell', cwd: '/a' })).sessionId
    await o.call.tabs.setOrder({ worktree: '/w', sessionIds: [a] })

    expect(await o.call.tabs.setOrder({ worktree: '/w', sessionIds: [] })).toEqual({})
  })
})

describe('oracle: composer drafts', () => {
  it(`${provisional('readiness-4', 'composer text is shared-surface state on the reserved, unbuilt op-stream path')}: a draft edit fans out to every OTHER client and never echoes to its author`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'shell', cwd: '/p' })
    const author: ServerMessage[] = []
    const authorId = attachTestClient(o.reg.clientGateway, (m) => author.push(m))
    const watcher: ServerMessage[] = []
    o.reg.clientGateway.routeClientFrame(authorId, {
      type: 'hello',
      wireVersion: WIRE_VERSION,
      clientId: '',
      viewport: { cols: 80, rows: 24, dpr: 1 },
    })
    const watcherId = attachTestClient(o.reg.clientGateway, (m) => watcher.push(m))
    o.reg.clientGateway.routeClientFrame(watcherId, {
      type: 'hello',
      wireVersion: WIRE_VERSION,
      clientId: '',
      viewport: { cols: 80, rows: 24, dpr: 1 },
    })

    o.reg.modules.sessions.setSessionDraft({ sessionId, text: 'half typed' }, authorId)

    expect(watcher).toContainEqual({ type: 'sessionDraftChanged', sessionId, text: 'half typed' })
    expect(author).not.toContainEqual(
      expect.objectContaining({ type: 'sessionDraftChanged', sessionId }),
    )
  })

  it(`${provisional('readiness-4', 'whole-body draft persistence is current behavior, not the collaborative-text contract')}: persistence is DEBOUNCED for text but immediate for a cleared draft`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'shell', cwd: '/p' })

    o.reg.modules.sessions.setSessionDraft({ sessionId, text: 'still typing' })
    // Nothing hit SQLite yet — the write is coalesced behind the debounce.
    expect(o.store.sessions.loadDrafts()[sessionId]).toBeUndefined()
    await waitFor(
      () => o.store.sessions.loadDrafts()[sessionId] === 'still typing',
      'the debounced draft write to land',
    )

    o.reg.modules.sessions.setSessionDraft({ sessionId, text: '' })
    // A cleared composer flushes synchronously: a stale draft must never outlive
    // the message that was sent, even across an immediate restart.
    expect(o.store.sessions.loadDrafts()[sessionId]).toBeUndefined()
  })

  it(`${provisional('readiness-4', 'draft nonempty state is retained while the document conflict class remains reserved')}: the DRAFT marker flip is broadcast once per start/clear, never per keystroke`, async () => {
    const o = makeOracle()
    const { sessionId } = await o.call.sessions.create({ agentKind: 'shell', cwd: '/p' })
    const svc = o.reg.modules.sessions

    svc.setSessionDraft({ sessionId, text: 'a' })
    await waitFor(
      () => lastSession(o.client, sessionId)?.draftUpdatedAt !== undefined,
      'the DRAFT session-state marker to reach the client',
    )
    const broadcastsAfterFirstKeystroke = sessionChanges(o.client, sessionId).length

    svc.setSessionDraft({ sessionId, text: 'ab' })
    svc.setSessionDraft({ sessionId, text: 'abc' })
    await waitFor(() => true, 'the microtask queue to drain')

    expect(sessionChanges(o.client, sessionId)).toHaveLength(broadcastsAfterFirstKeystroke)
  })
})

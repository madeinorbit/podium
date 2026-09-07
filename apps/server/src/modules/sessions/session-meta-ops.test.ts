import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asIssueId, asSessionId, FIRST_ADMIN_USER_ID } from '@podium/model'
import { openDatabase } from '@podium/runtime/sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openTestStore } from '../../test-support/open-test-store'
import { Session } from './session'
import { SessionMetaOps, type SessionMetaOpsPorts } from './session-meta-ops'

const stamp = '2026-09-01T12:00:00.000Z'
const offer = { message: 'Ready to review', actions: [], createdAt: stamp }
const sessionId = asSessionId('offer-session')
const issueId = asIssueId('offer-issue')
const cleanups: (() => void)[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

async function fixture(file = ':memory:') {
  const store = await openTestStore(file)
  cleanups.push(() => store.close())
  const sessions = new Map<typeof sessionId, Session>()
  const session = new Session({
    sessionId,
    ownerUserId: FIRST_ADMIN_USER_ID,
    agentKind: 'claude-code',
    cwd: '/offer-test',
    title: 'Offer test',
    origin: { kind: 'spawn' },
    createdAt: stamp,
    geometry: { cols: 80, rows: 24 },
    machineId: store.hostMachineId,
    durableLabel: 'offer-test',
    toDaemon: () => {},
  })
  const repository = {
    write: vi.fn<SessionMetaOpsPorts['repository']['write']>(async (live, mutate, write) => {
      const draft = live.captureDurableState()
      const extra = mutate(draft)
      await (extra ?? write)?.()
      live.installDurableState(draft)
    }),
    sessionFromStoredRow: vi.fn<SessionMetaOpsPorts['repository']['sessionFromStoredRow']>(
      async () => session,
    ),
    prepareStoredSessionInstall: vi.fn<SessionMetaOpsPorts['repository']['prepareStoredSessionInstall']>(
      async (restored, offers) => {
        restored.offer = offers[restored.sessionId]
        return { write: async () => {}, apply: () => { sessions.set(restored.sessionId, restored) } }
      },
    ),
    draft: vi.fn(live => live.captureDurableState()),
    persistDraft: vi.fn(async (live, draft, write) => { await write?.(); live.installDurableState(draft) }),
    publishSessionProjection: vi.fn(),
  } satisfies SessionMetaOpsPorts['repository']
  const ports: SessionMetaOpsPorts = {
    store,
    repository,
    sessions,
    broadcastSessions: vi.fn(),
    funnel: { run: async op => op.write() },
    now: () => Date.parse(stamp),
    removeSessionRuntime: vi.fn(),
    sessionRemovalSpecs: vi.fn(),
    sessionTeardown: { tryAutoArchiveStoppedObserved: vi.fn() },
    state: {
      prepareStoredDrafts: vi.fn(async () => vi.fn()), invalidateAllOverlays: vi.fn(),
      setSnooze: vi.fn(), clearSnooze: vi.fn(), markRead: vi.fn(), markUnread: vi.fn(),
      setWorkState: vi.fn(), setArchived: vi.fn(), clearAllSnoozes: vi.fn(), suppressNativeDraft: vi.fn(),
    },
    toPtyInput: vi.fn(),
    view: { principalForTrustedUser: vi.fn(), prepareRefAllocation: vi.fn(), overlay: vi.fn(), wire: vi.fn(async (s: Session) => s.toMeta({ readAt: null, snoozedUntil: null })) },
  }
  return { store, session, sessions, repository, ports, ops: new SessionMetaOps(ports) }
}

describe('async offer persistence', () => {
  it('dismisses the named offer when the session has left memory, returning true', async () => {
    const { store, ops } = await fixture()
    await store.sessions.setOffer(sessionId, offer)
    expect(await ops.dismissOffer(sessionId, stamp)).toBe(true)
    expect(await store.sessions.offerCreatedAt(sessionId)).toBeUndefined()
    expect(await ops.dismissOffer(sessionId, stamp)).toBe(false)
  })

  it('leaves a replacement offer intact when an old stamp is dismissed', async () => {
    const { store, ops } = await fixture()
    await store.sessions.setOffer(sessionId, offer)
    expect(await ops.dismissOffer(sessionId, 'old-stamp')).toBe(false)
    expect(await store.sessions.offerCreatedAt(sessionId)).toBe(stamp)
  })

  it('does not write or broadcast when neither memory nor storage has an offer', async () => {
    const { store, ops, ports } = await fixture()
    const clear = vi.spyOn(store.sessions, 'clearOffer')
    await ops.clearOffer(sessionId)
    expect(clear).not.toHaveBeenCalled()
    expect(ports.broadcastSessions).not.toHaveBeenCalled()
  })

  it('clears a corrupt durable offer that boot omitted from memory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'offer-corrupt-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const file = join(dir, 'store.db')
    const { store, ops, sessions, session, repository } = await fixture(file)
    await store.sessions.setOffer(sessionId, offer)
    const db = openDatabase(file)
    try {
      db.prepare('UPDATE offers SET actions = ? WHERE session_id = ?').run('{broken', sessionId)
    } finally {
      db.close()
    }
    expect(await store.sessions.listOffers()).toEqual({})
    sessions.set(sessionId, session)
    await ops.clearOffer(sessionId)
    expect(await store.sessions.offerCreatedAt(sessionId)).toBeUndefined()
    expect(repository.write).toHaveBeenCalledOnce()
  })

  it('waits for a durable clear and propagates its failure instead of reporting dismissal', async () => {
    const { store, ops } = await fixture()
    await store.sessions.setOffer(sessionId, offer)
    let fail!: (error: Error) => void
    const pending = new Promise<void>((_resolve, reject) => {
      fail = reject
    })
    vi.spyOn(store.sessions, 'clearOffer').mockReturnValue(pending)
    const dismissal = ops.dismissOffer(sessionId, stamp)
    const assertion = expect(dismissal).rejects.toThrow('offer deletion refused')
    fail(new Error('offer deletion refused'))
    await assertion
    expect(await store.sessions.offerCreatedAt(sessionId)).toBe(stamp)
  })

  it('publishes a resident offer only after the repository write has settled', async () => {
    const { ops, repository, ports, sessions, session } = await fixture()
    sessions.set(sessionId, session)
    let finish!: () => void
    repository.write.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    const setting = ops.setOffer({ sessionId, message: offer.message, actions: [] })
    expect(ports.broadcastSessions).not.toHaveBeenCalled()
    finish()
    await setting
    expect(ports.broadcastSessions).toHaveBeenCalledOnce()
  })

  it('restores materialized sessions and their settled offer map with a synchronous apply', async () => {
    const { store, ops, session, sessions, repository } = await fixture()
    await store.sessions.upsertSession(session.toRow())
    await store.sessions.setOffer(sessionId, offer)
    await store.sessions.softDeleteForIssue([sessionId], issueId, stamp)
    const listOffers = vi.spyOn(store.sessions, 'listOffers')
    const plan = await ops.prepareIssueSessionRestore(issueId)
    expect(plan.sessionIds).toEqual([sessionId])
    expect(plan.restoredSessions[0]?.sessionId).toBe(sessionId)
    expect(listOffers).toHaveBeenCalledOnce()
    expect(sessions.size).toBe(0)
    await plan.write()
    const changes = await plan.changes()
    expect(changes[0]?.value).toEqual(plan.restoredSessions[0])
    expect(plan.apply([], 0)).toBeUndefined()
    expect(listOffers).toHaveBeenCalledOnce()
    expect(repository.prepareStoredSessionInstall).toHaveBeenCalledWith(session, { [sessionId]: offer })
    expect(sessions.get(sessionId)?.offer).toEqual(offer)
    expect(await store.sessions.loadDeletedSessionsForIssue(issueId)).toEqual([])
  })

  it('waits for row materialization and excludes an invalid restored session', async () => {
    const { store, ops, session, repository } = await fixture()
    await store.sessions.upsertSession(session.toRow())
    await store.sessions.softDeleteForIssue([sessionId], issueId, stamp)
    repository.sessionFromStoredRow.mockResolvedValueOnce(null)
    const plan = await ops.prepareIssueSessionRestore(issueId)
    expect(plan.sessionIds).toEqual([])
    expect(plan.restoredSessions).toEqual([])
  })
})

import type {
  IssueBriefWire,
  IssueProjection,
  IssueUserStateWire,
  SessionMeta,
} from '@podium/model'
import { firstAdminMemberId } from '@podium/model'
import { CLIENT_WIRE_VERSION, type MetadataChange, type ServerMessage } from '@podium/protocol'
import { CHANGE_LOG_OBSERVER } from '@podium/sync'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { userClientPrincipal } from './gateway/client-principal'
import { SessionRegistry } from './relay'
import { authoritySnapshot } from './test-support/authority-snapshot'
import { workerSnapshot } from './test-support/bootstrap-snapshot'
import { attachTestClient } from './test-support/client-transport'
import { feedDelta } from './test-support/feed-delta'
import { attachHostDaemon } from './test-support/host-daemon'
import { openTestStore } from './test-support/open-test-store'

// The split fan-out + catch-up seam (docs/spec/oplog-read-path.md §2.3-2.5):
// current clients receive scoped feed deltas; direct Authority reads converge a
// stale cursor onto the state a worker-backed bootstrap would give.
describe('SessionRegistry metadata deltas', () => {
  const registries: SessionRegistry[] = []
  afterEach(async () => {
    for (const r of registries.splice(0)) await r.dispose()
  })

  it('O1 boot reconciliation does not scan shipping attempts', async () => {
    const store = await openTestStore(':memory:')
    const attempts = vi.spyOn(store.shipping, 'attemptsForOrder')
    try {
      const registry = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
      registries.push(registry)
      await authoritySnapshot(registry)
      expect(attempts).not.toHaveBeenCalled()
    } finally {
      attempts.mockRestore()
    }
  })

  async function makeRegistry(): Promise<SessionRegistry> {
    const registry = await SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
    registries.push(registry)
    // The host runs the sessions and reports `/r`, before any client connects (2b803efb5).
    await attachHostDaemon(registry, () => {}, { repos: ['/r'] })
    return registry
  }

  async function client(registry: SessionRegistry): Promise<{ inbox: ServerMessage[] }> {
    const inbox: ServerMessage[] = []
    const id = attachTestClient(registry.clientGateway, (msg) => inbox.push(msg))
    await registry.clientGateway.routeClientFrame(id, {
      type: 'hello',
      wireVersion: CLIENT_WIRE_VERSION,
      clientId: '',
      viewport: { cols: 80, rows: 24, dpr: 1 },
      caps: ['sync.http.v1'],
    })
    await expect.poll(() => inbox.some((m) => m.type === 'feedResume')).toBe(true)
    return { inbox }
  }

  const deltas = (inbox: ServerMessage[]): MetadataChange[] =>
    inbox.flatMap((message) => {
      if (message.type === 'metadataDelta') return message.changes
      if (message.type !== 'feedDelta') return []
      return message.changes
        .filter((change) => change.op !== 'evict')
        .map((change) => ({ ...change, id: change.entityId }) as MetadataChange)
    })

  /** Emission is coalesced at microtask level since #256 (one ordered pipe);
   *  flush deterministically before reading a delta client's inbox. */
  const flush = (registry: SessionRegistry): void => registry.modules.funnel.flushDeltas()

  it('sends canonical per-entity deltas', async () => {
    const registry = await makeRegistry()
    const subscriber = await client(registry)
    const before = subscriber.inbox.length

    await registry.issues.crud.create(registry.issues.reports.store.serverWriter, {
      repoPath: '/r',
      title: 'first',
      startNow: false,
    })
    flush(registry)

    await expect.poll(() => deltas(subscriber.inbox.slice(before)).length).toBe(3)
    const published = subscriber.inbox.slice(before)
    expect(published.some((m) => m.type === 'feedDelta')).toBe(true)
    expect(published.some((m) => m.type === 'metadataDelta')).toBe(false)
    expect(published.some((m) => String(m.type) === 'issuesChanged')).toBe(false)
    const changes = deltas(published)
    // Creating an issue also appends its event and user state.
    expect(changes.map((change) => change.entity).sort()).toEqual([
      'issueEvent',
      'issueProjection',
      'issueUserState',
    ])
    const residue = changes.find((change) => change.entity === 'issueProjection')
    expect(residue).toMatchObject({ entity: 'issueProjection', op: 'upsert' })
    expect((residue?.value as IssueProjection).title).toBe('first')
  })

  it('a single-issue update touches one canonical row and never rebuilds the bystander (#22)', async () => {
    const registry = await makeRegistry()
    const w = await registry.issues.crud.create(registry.issues.reports.store.serverWriter, {
      repoPath: '/r',
      title: 'solo',
      startNow: false,
    })
    await registry.issues.crud.create(registry.issues.reports.store.serverWriter, {
      repoPath: '/r',
      title: 'bystander',
      startNow: false,
    })
    flush(registry)
    const subscriber = await client(registry)
    const before = subscriber.inbox.length

    await registry.issues.crud.update(registry.issues.reports.store.serverWriter, w.id, {
      brief: 'self-contained edit',
    })
    flush(registry)

    // The record and its brief, a record of its own (POD-6921).
    await expect.poll(() => deltas(subscriber.inbox.slice(before)).length).toBe(2)
    const published = subscriber.inbox.slice(before)
    expect(published.map((m) => m.type)).toEqual(['feedDelta'])
    const changes = deltas(published)
    expect(changes.map((change) => change.entity).sort()).toEqual(['issueBrief', 'issueProjection'])
    expect(changes.every((change) => change.id === w.id && change.op === 'upsert')).toBe(true)
    const residue = changes.find((change) => change.entity === 'issueProjection')
    expect(residue?.value).not.toHaveProperty('brief')
    const brief = changes.find((change) => change.entity === 'issueBrief')
    expect((brief as { value: IssueBriefWire }).value).toEqual({
      id: w.id,
      text: 'self-contained edit',
    })
  })

  it('streams session upserts through the same seam', async () => {
    const registry = await makeRegistry()
    const delta = await client(registry)
    const before = delta.inbox.length
    const { sessionId } = await registry.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/w',
    })
    flush(registry)
    await vi.waitFor(() => {
      expect(
        deltas(delta.inbox.slice(before)).some((c) => c.entity === 'session' && c.id === sessionId),
      ).toBe(true)
    })
    const changes = deltas(delta.inbox.slice(before)).filter((c) => c.entity === 'session')
    expect(changes.length).toBeGreaterThanOrEqual(1)
    expect(changes[0]).toMatchObject({ entity: 'session', id: sessionId, op: 'upsert' })
    expect((changes[0]?.value as SessionMeta).cwd).toBe('/w')
  })

  it('batches carry seq of the last change and stay in order', async () => {
    const registry = await makeRegistry()
    const delta = await client(registry)
    await registry.issues.crud.create(registry.issues.reports.store.serverWriter, {
      repoPath: '/r',
      title: 'a',
      startNow: false,
    })
    await registry.issues.crud.create(registry.issues.reports.store.serverWriter, {
      repoPath: '/r',
      title: 'b',
      startNow: false,
    })
    flush(registry)
    await expect
      .poll(() => deltas(delta.inbox).filter((c) => c.entity === 'issueEvent').length)
      .toBe(2)
    const batches = delta.inbox.filter((m) => m.type === 'feedDelta')
    expect(batches.length).toBeGreaterThan(0)
    let prev = 0
    for (const b of batches) {
      expect(b.changes.at(-1)?.seq).toBe(b.seq)
      for (const c of b.changes) {
        expect(c.seq).toBeGreaterThan(prev)
        prev = c.seq
      }
    }
  })

  it('direct Authority catch-up replay equals a fresh snapshot', async () => {
    const registry = await makeRegistry()
    await registry.issues.crud.create(registry.issues.reports.store.serverWriter, {
      repoPath: '/r',
      title: 'a',
      startNow: false,
    })

    const boot = await authoritySnapshot(registry)
    expect(boot.issueProjections?.map((i) => i.title)).toEqual(['a'])

    const created = await registry.issues.crud.create(registry.issues.reports.store.serverWriter, {
      repoPath: '/r',
      title: 'b',
      startNow: false,
    })
    await registry.issues.crud.close(
      registry.issues.reports.store.serverWriter,
      created.id,
      'wontfix',
    )
    await registry.modules.sessions.createSession({ agentKind: 'shell', cwd: '/w' })

    const catchUp = await feedDelta(registry, boot.cursor, CHANGE_LOG_OBSERVER)

    // Replay the delta over the boot snapshot -> must equal a fresh snapshot.
    const fold = <T>(list: T[], key: (t: T) => string, entity: MetadataChange['entity']): T[] => {
      const m = new Map(list.map((t) => [key(t), t]))
      for (const c of catchUp.changes) {
        if (c.entity !== entity) continue
        if (c.op === 'remove') m.delete(c.id)
        else m.set(c.id, c.value as T)
      }
      return [...m.values()]
    }
    const fresh = await authoritySnapshot(registry)
    const byId = <T>(l: T[], key: (t: T) => string) =>
      [...l].sort((x, y) => key(x).localeCompare(key(y)))
    expect(
      byId(
        fold(boot.issueProjections ?? [], (i) => i.id, 'issueProjection'),
        (i) => i.id,
      ),
    ).toEqual(byId(fresh.issueProjections ?? [], (i) => i.id))
    expect(
      byId(
        fold(boot.sessions, (s) => s.sessionId, 'session'),
        (s) => s.sessionId,
      ),
    ).toEqual(byId(fresh.sessions, (s) => s.sessionId))
    expect(catchUp.cursor).toBe(fresh.cursor)
  })

  // POD-333: tuck-away used to be a per-browser ui-state key, so a second open
  // client never learned about a dismissal and a reconnecting one came back
  // showing the row live again. Its personal marker now rides this seam.
  it('a tuck reaches other live clients and heals a reconnecting one', async () => {
    const registry = await makeRegistry()
    const w = await registry.issues.crud.create(registry.issues.reports.store.serverWriter, {
      repoPath: '/r',
      title: 'finished',
      startNow: false,
    })
    await registry.issues.crud.close(registry.issues.reports.store.serverWriter, w.id)
    flush(registry)

    // The cursor a client held while it was away — nothing tucked yet.
    const principal = userClientPrincipal('reconnecting', firstAdminMemberId(), 'admin')
    const away = await workerSnapshot(registry, principal)
    expect(away.issueUserStates?.find((i) => i.entityId === w.id)?.tuckedAt ?? null).toBeNull()

    // A SECOND client is watching while the first one tucks.
    const other = await client(registry)
    const before = other.inbox.length
    await registry.issues.crud.setIssueTucked(
      registry.issues.reports.store.serverWriter,
      w.id,
      true,
    )
    flush(registry)

    await expect
      .poll(
        () => deltas(other.inbox.slice(before)).filter((c) => c.entity === 'issueUserState').length,
      )
      .toBe(1)
    const seen = deltas(other.inbox.slice(before)).filter((c) => c.entity === 'issueUserState')
    expect(seen).toHaveLength(1)
    expect((seen[0] as { value: IssueUserStateWire }).value.tuckedAt).toBeTruthy()

    // And the client that was disconnected converges through catch-up rather
    // than painting the stale un-tucked row from its own storage.
    const healed = await feedDelta(registry, away.cursor, principal)
    const change = healed.changes.find((c) => c.entity === 'issueUserState')
    expect((change as { value: IssueUserStateWire } | undefined)?.value.tuckedAt).toBeTruthy()
  })

  it('withholds entity rows until the client announces an eviction-capable wire', async () => {
    const registry = await makeRegistry()
    const inbox: ServerMessage[] = []
    const id = attachTestClient(registry.clientGateway, (msg) => inbox.push(msg))
    await registry.issues.crud.create(registry.issues.reports.store.serverWriter, {
      repoPath: '/r',
      title: 'before hello',
      startNow: false,
    })
    flush(registry)
    expect(
      inbox.some((message) => message.type === 'feedResume' || message.type === 'feedDelta'),
    ).toBe(false)
    expect(inbox.some((m) => m.type === 'metadataDelta')).toBe(false)

    await registry.clientGateway.routeClientFrame(id, {
      type: 'hello',
      clientId: '',
      wireVersion: CLIENT_WIRE_VERSION,
      viewport: { cols: 80, rows: 24, dpr: 1 },
      caps: ['sync.http.v1'],
    })
    await expect.poll(() => inbox.some((m) => m.type === 'feedResume')).toBe(true)
    const created = await registry.issues.crud.create(registry.issues.reports.store.serverWriter, {
      repoPath: '/r',
      title: 'after hello',
      startNow: false,
    })
    flush(registry)
    await expect
      .poll(() =>
        deltas(inbox).some(
          (change) => change.entity === 'issueProjection' && change.id === created.id,
        ),
      )
      .toBe(true)
  })
})

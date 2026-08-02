import type { IssueWire, SessionMeta } from '@podium/model'
import type { MetadataChange, ServerMessage } from '@podium/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionRegistry } from './relay'
import { SessionStore } from './store'
import { attachTestClient } from './test-support/client-transport'

// The split fan-out + catch-up seam (docs/spec/oplog-read-path.md §2.3-2.5):
// delta-cap clients receive per-entity metadataDelta batches, legacy clients keep
// the full-list snapshots byte-for-byte, and sync.changesSince converges a stale
// cursor onto the same state a fresh snapshot would give.
describe('SessionRegistry metadata deltas', () => {
  const registries: SessionRegistry[] = []
  afterEach(() => {
    for (const r of registries.splice(0)) r.dispose()
  })

  function makeRegistry(): SessionRegistry {
    const registry = new SessionRegistry(undefined, undefined, { instanceId: 'default' })
    registries.push(registry)
    return registry
  }

  function makeLegacyRegistry(): SessionRegistry {
    const registry = new SessionRegistry(new SessionStore(':memory:'), undefined, { instanceId: 'default' })
    registries.push(registry)
    return registry
  }

  function client(registry: SessionRegistry, caps?: string[]): { inbox: ServerMessage[] } {
    const inbox: ServerMessage[] = []
    const id = attachTestClient(registry.clientGateway, (msg) => inbox.push(msg))
    registry.clientGateway.routeClientFrame(id, {
      type: 'hello',
      wireVersion: 2,
      clientId: '',
      viewport: { cols: 80, rows: 24, dpr: 1 },
      ...(caps ? { caps } : {}),
    })
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

  it('sends canonical per-entity deltas regardless of the retired metadataDelta cap', () => {
    const registry = makeLegacyRegistry()
    const legacy = client(registry)
    const delta = client(registry, ['metadataDelta'])
    const legacyBefore = legacy.inbox.length
    const deltaBefore = delta.inbox.length

    registry.issues.create({ repoPath: '/r', title: 'first', startNow: false })
    flush(registry)

    // Wire v2 is canonical; the retired cap no longer selects a second entity path.
    const legacyNew = legacy.inbox.slice(legacyBefore)
    expect(legacyNew.some((m) => m.type === 'feedDelta')).toBe(true)
    expect(legacyNew.some((m) => m.type === 'metadataDelta')).toBe(false)

    // Both clients receive the same scoped feed; capabilities do not widen it.
    const deltaNew = delta.inbox.slice(deltaBefore)
    expect(deltaNew.some((m) => m.type === 'issuesChanged')).toBe(false)
    const changes = deltas(deltaNew)
    expect(changes.map((change) => change.entity).sort()).toEqual(['issue', 'issueProjection'])
    const residue = changes.find((change) => change.entity === 'issue')
    expect(residue).toMatchObject({ entity: 'issue', op: 'upsert' })
    expect((residue?.value as IssueWire).title).toBe('first')
  })

  it('a single-issue update touches one canonical row and never rebuilds the bystander (#22)', () => {
    const registry = makeRegistry()
    const w = registry.issues.create({ repoPath: '/r', title: 'solo', startNow: false })
    registry.issues.create({ repoPath: '/r', title: 'bystander', startNow: false })
    flush(registry) // drain the setup writes' pending batch before the clients attach
    const legacy = client(registry)
    const delta = client(registry, ['metadataDelta'])
    const legacyBefore = legacy.inbox.length
    const deltaBefore = delta.inbox.length

    registry.issues.update(w.id, { notes: 'self-contained edit' })
    flush(registry)

    // Both wire-v2 peers receive exactly the changed issue rows. There is no
    // full-list translation on the production path and the bystander is untouched.
    const legacyNew = legacy.inbox.slice(legacyBefore)
    expect(legacyNew.map((m) => m.type)).toEqual(['feedDelta'])
    const legacyChanges = deltas(legacyNew)
    expect(legacyChanges.map((change) => change.entity).sort()).toEqual([
      'issue',
      'issueProjection',
    ])
    expect(legacyChanges.every((change) => change.id === w.id)).toBe(true)
    // The cap-advertising peer observes the same canonical rows.
    const changes = deltas(delta.inbox.slice(deltaBefore))
    expect(changes.map((change) => change.entity).sort()).toEqual(['issue', 'issueProjection'])
    expect(changes.every((change) => change.id === w.id && change.op === 'upsert')).toBe(true)
    const residue = changes.find((change) => change.entity === 'issue')
    expect((residue as { value: IssueWire }).value.notes).toBe('self-contained edit')
  })

  it('streams session upserts through the same seam', () => {
    const registry = makeRegistry()
    const delta = client(registry, ['metadataDelta'])
    const before = delta.inbox.length
    const { sessionId } = registry.modules.sessions.createSession({ agentKind: 'shell', cwd: '/w' })
    flush(registry)
    const changes = deltas(delta.inbox.slice(before)).filter((c) => c.entity === 'session')
    expect(changes.length).toBeGreaterThanOrEqual(1)
    expect(changes[0]).toMatchObject({ entity: 'session', id: sessionId, op: 'upsert' })
    expect((changes[0]?.value as SessionMeta).cwd).toBe('/w')
  })

  it('batches carry seq of the last change and stay in order', () => {
    const registry = makeRegistry()
    const delta = client(registry, ['metadataDelta'])
    registry.issues.create({ repoPath: '/r', title: 'a', startNow: false })
    registry.issues.create({ repoPath: '/r', title: 'b', startNow: false })
    flush(registry)
    const batches = delta.inbox.filter((m) => m.type === 'metadataDelta')
    let prev = 0
    for (const b of batches) {
      expect(b.changes.at(-1)?.seq).toBe(b.seq)
      for (const c of b.changes) {
        expect(c.seq).toBeGreaterThan(prev)
        prev = c.seq
      }
    }
  })

  it('changesSince: snapshot on null cursor, delta after, snapshot-equivalent replay', () => {
    const registry = makeRegistry()
    registry.issues.create({ repoPath: '/r', title: 'a', startNow: false })

    const boot = registry.modules.sessions.syncChangesSince(null)
    expect(boot.kind).toBe('snapshot')
    if (boot.kind !== 'snapshot') return
    expect(boot.issues.map((i) => i.title)).toEqual(['a'])

    const created = registry.issues.create({ repoPath: '/r', title: 'b', startNow: false })
    registry.issues.close(created.id, 'wontfix')
    registry.modules.sessions.createSession({ agentKind: 'shell', cwd: '/w' })

    const catchUp = registry.modules.sessions.syncChangesSince(boot.cursor)
    expect(catchUp.kind).toBe('delta')
    if (catchUp.kind !== 'delta') return

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
    const fresh = registry.modules.sessions.syncChangesSince(null)
    if (fresh.kind !== 'snapshot') throw new Error('expected snapshot')
    const byId = <T>(l: T[], key: (t: T) => string) =>
      [...l].sort((x, y) => key(x).localeCompare(key(y)))
    expect(
      byId(
        fold(boot.issues, (i) => i.id, 'issue'),
        (i) => i.id,
      ),
    ).toEqual(byId(fresh.issues, (i) => i.id))
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
  // showing the row live again. Now it is an issue field and rides this seam.
  it('a tuck reaches other live clients and heals a reconnecting one', () => {
    const registry = makeRegistry()
    const w = registry.issues.create({ repoPath: '/r', title: 'finished', startNow: false })
    registry.issues.close(w.id)
    flush(registry)

    // The cursor a client held while it was away — nothing tucked yet.
    const away = registry.modules.sessions.syncChangesSince(null)
    if (away.kind !== 'snapshot') throw new Error('expected snapshot')
    expect(away.issues.find((i) => i.id === w.id)?.tuckedAt ?? null).toBeNull()

    // A SECOND client is watching while the first one tucks.
    const other = client(registry, ['metadataDelta'])
    const before = other.inbox.length
    registry.issues.setIssueTucked(w.id, true)
    flush(registry)

    const seen = deltas(other.inbox.slice(before)).filter((c) => c.entity === 'issue')
    expect(seen).toHaveLength(1)
    expect((seen[0] as { value: IssueWire }).value.tuckedAt).toBeTruthy()

    // And the client that was disconnected converges through catch-up rather
    // than painting the stale un-tucked row from its own storage.
    const healed = registry.modules.sessions.syncChangesSince(away.cursor)
    expect(healed.kind).toBe('delta')
    if (healed.kind !== 'delta') return
    const change = healed.changes.find((c) => c.entity === 'issue' && c.id === w.id)
    expect((change as { value: IssueWire } | undefined)?.value.tuckedAt).toBeTruthy()
  })

  it('a pre-hello client receives no entity world until it announces an eviction-capable wire', () => {
    const registry = makeRegistry()
    const inbox: ServerMessage[] = []
    attachTestClient(registry.clientGateway, (msg) => inbox.push(msg)) // no hello at all
    expect(inbox.some((message) => message.type === 'feedBootstrap')).toBe(false)
    const before = inbox.length
    registry.issues.create({ repoPath: '/r', title: 'x', startNow: false })
    flush(registry)
    expect(inbox.some((m) => m.type === 'metadataDelta')).toBe(false)
    expect(inbox).toHaveLength(before)
  })
})

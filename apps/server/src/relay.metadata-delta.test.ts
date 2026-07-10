import type { IssueWire, MetadataChange, ServerMessage, SessionMeta } from '@podium/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionRegistry } from './relay'

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
    const registry = new SessionRegistry()
    registries.push(registry)
    return registry
  }

  function client(registry: SessionRegistry, caps?: string[]): { inbox: ServerMessage[] } {
    const inbox: ServerMessage[] = []
    const id = registry.modules.sessions.attachClient((msg) => inbox.push(msg))
    registry.modules.sessions.onClientMessage(id, {
      type: 'hello',
      clientId: '',
      viewport: { cols: 80, rows: 24, dpr: 1 },
      ...(caps ? { caps } : {}),
    })
    return { inbox }
  }

  const deltas = (inbox: ServerMessage[]): MetadataChange[] =>
    inbox.flatMap((m) => (m.type === 'metadataDelta' ? m.changes : []))

  /** Emission is coalesced at microtask level since #256 (one ordered pipe);
   *  flush deterministically before reading a delta client's inbox. */
  const flush = (registry: SessionRegistry): void => registry.modules.funnel.flushDeltas()

  it('sends per-entity deltas to cap clients and full lists to legacy clients', () => {
    const registry = makeRegistry()
    const legacy = client(registry)
    const delta = client(registry, ['metadataDelta'])
    const legacyBefore = legacy.inbox.length
    const deltaBefore = delta.inbox.length

    registry.issues.create({ repoPath: '/r', title: 'first', startNow: false })
    flush(registry)

    // Legacy: a full issuesChanged list, and NEVER a metadataDelta.
    const legacyNew = legacy.inbox.slice(legacyBefore)
    expect(legacyNew.some((m) => m.type === 'issuesChanged')).toBe(true)
    expect(legacyNew.some((m) => m.type === 'metadataDelta')).toBe(false)

    // Cap client: exactly one issue upsert — not a full list — and NO issuesChanged.
    const deltaNew = delta.inbox.slice(deltaBefore)
    expect(deltaNew.some((m) => m.type === 'issuesChanged')).toBe(false)
    const changes = deltas(deltaNew)
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ entity: 'issue', op: 'upsert' })
    expect((changes[0]?.value as IssueWire).title).toBe('first')
  })

  it('a single-issue update fans out one issueUpdated + one oplog change — never the full list (#22)', () => {
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

    // Legacy client: exactly one single-issue message, no full issuesChanged.
    const legacyNew = legacy.inbox.slice(legacyBefore)
    expect(legacyNew.map((m) => m.type)).toEqual(['issueUpdated'])
    // Delta client: exactly one oplog upsert for that issue — the bystander is untouched.
    const changes = deltas(delta.inbox.slice(deltaBefore))
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ entity: 'issue', id: w.id, op: 'upsert' })
    expect((changes[0] as { value: IssueWire }).value.notes).toBe('self-contained edit')
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

  it('a pre-hello client is legacy: bootstrap snapshots, no deltas', () => {
    const registry = makeRegistry()
    const inbox: ServerMessage[] = []
    registry.modules.sessions.attachClient((msg) => inbox.push(msg)) // no hello at all
    expect(inbox.some((m) => m.type === 'sessionsChanged')).toBe(true)
    registry.issues.create({ repoPath: '/r', title: 'x', startNow: false })
    flush(registry)
    expect(inbox.some((m) => m.type === 'metadataDelta')).toBe(false)
    expect(inbox.filter((m) => m.type === 'issuesChanged').length).toBeGreaterThanOrEqual(2)
  })
})

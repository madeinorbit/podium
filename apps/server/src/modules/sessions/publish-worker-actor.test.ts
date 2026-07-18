import type { MetadataChange, SessionMeta } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import {
  createViewKey,
  type PublicationView,
  SessionPublicationActor,
} from './publish-worker-actor.js'

function session(sessionId: string, title = sessionId): SessionMeta {
  return {
    sessionId,
    agentKind: 'codex',
    cwd: `/work/${sessionId}`,
    title,
    machineId: 'local',
    machineName: 'Local',
    status: 'live',
    geometry: { cols: 80, rows: 24 },
    epoch: 0,
    clientCount: 0,
    controllerId: null,
    createdAt: '2026-07-18T00:00:00.000Z',
    lastActiveAt: '2026-07-18T00:00:00.000Z',
    origin: { kind: 'spawn' },
    archived: false,
    readAt: null,
    unread: false,
  }
}

function upsert(seq: number, value: SessionMeta): MetadataChange {
  return { seq, entity: 'session', id: value.sessionId, op: 'upsert', value }
}

function remove(seq: number, id: string): MetadataChange {
  return { seq, entity: 'session', id, op: 'remove' }
}

function view(principal: string, allowedSessionIds: string[], revision = 1): PublicationView {
  return {
    key: createViewKey({
      principal,
      scope: `scope:${principal}`,
      serverRole: 'standalone',
      protocolVersion: 1,
      capabilities: ['metadataDelta'],
    }),
    revision,
    allowedSessionIds,
  }
}

function decoded(publication: { bytes: string }) {
  return JSON.parse(publication.bytes)
}

describe('SessionPublicationActor', () => {
  it('builds distinct scoped bootstraps while identical ViewKeys share encoded bytes', () => {
    const actor = new SessionPublicationActor()
    actor.applyPatch({
      generation: 1,
      ledgerCursor: 2,
      changes: [upsert(1, session('a')), upsert(2, session('b'))],
    })

    const alice = view('alice', ['a'])
    const bob = view('bob', ['b'])
    const aliceFirst = actor.prepare({ view: alice, sinceCursor: null })
    const aliceSecond = actor.prepare({ view: alice, sinceCursor: null })
    const bobPublication = actor.prepare({ view: bob, sinceCursor: null })

    expect(aliceFirst.kind).toBe('snapshot')
    expect(decoded(aliceFirst)).toEqual({ type: 'sessionsChanged', sessions: [session('a')] })
    expect(decoded(bobPublication)).toEqual({
      type: 'sessionsChanged',
      sessions: [session('b')],
    })
    expect(aliceFirst.bytes).toBe(aliceSecond.bytes)
    expect(aliceFirst.bytes).not.toBe(bobPublication.bytes)
    expect(aliceFirst).toMatchObject({ generation: 1, ledgerCursor: 2, viewKey: alice.key })
  })

  it('advances the global source range without leaking hidden-only changes', () => {
    const actor = new SessionPublicationActor()
    const alice = view('alice', ['a'])
    const bob = view('bob', ['b'])
    actor.applyPatch({
      generation: 1,
      ledgerCursor: 2,
      changes: [upsert(1, session('a')), upsert(2, session('b'))],
    })
    actor.prepare({ view: alice, sinceCursor: null })
    actor.prepare({ view: bob, sinceCursor: null })

    actor.applyPatch({
      generation: 2,
      ledgerCursor: 4,
      changes: [upsert(3, session('a', 'renamed'))],
    })

    const visible = actor.prepare({ view: alice, sinceCursor: 2 })
    const hidden = actor.prepare({ view: bob, sinceCursor: 2 })
    expect(visible).toMatchObject({
      kind: 'delta',
      sourceRange: { fromExclusive: 2, toInclusive: 4 },
    })
    expect(hidden).toMatchObject({
      kind: 'delta',
      sourceRange: { fromExclusive: 2, toInclusive: 4 },
    })
    expect(decoded(visible)).toMatchObject({
      type: 'metadataDelta',
      seq: 4,
      changes: [{ seq: 3, id: 'a' }],
    })
    expect(decoded(hidden)).toEqual({
      type: 'metadataDelta',
      fromExclusive: 2,
      seq: 4,
      changes: [],
    })
    expect(hidden.bytes).not.toContain('"id":"a"')
    expect(hidden.bytes).not.toContain('renamed')
  })

  it('accepts a cursor-only source advance without inventing a dirty generation', () => {
    const actor = new SessionPublicationActor()
    const alice = view('alice', ['a'])
    actor.applyPatch({
      generation: 1,
      ledgerCursor: 1,
      changes: [upsert(1, session('a'))],
    })
    actor.prepare({ view: alice, sinceCursor: null })

    actor.applyPatch({ generation: 1, ledgerCursor: 3, changes: [] })
    const publication = actor.prepare({ view: alice, sinceCursor: 1 })

    expect(decoded(publication)).toEqual({
      type: 'metadataDelta',
      fromExclusive: 1,
      seq: 3,
      changes: [],
    })
    expect(publication.generation).toBe(1)
  })

  it('falls back to a scoped snapshot on revocation or a compacted reconnect cursor', () => {
    const actor = new SessionPublicationActor({ journalLimit: 2 })
    const both = view('alice', ['a', 'b'], 1)
    actor.applyPatch({
      generation: 1,
      ledgerCursor: 2,
      changes: [upsert(1, session('a')), upsert(2, session('b'))],
    })
    actor.prepare({ view: both, sinceCursor: null })

    const revoked = view('alice', ['a'], 2)
    const revocation = actor.prepare({ view: revoked, sinceCursor: 2 })
    expect(revocation.kind).toBe('snapshot')
    expect(decoded(revocation)).toEqual({ type: 'sessionsChanged', sessions: [session('a')] })

    actor.applyPatch({ generation: 2, ledgerCursor: 3, changes: [remove(3, 'b')] })
    actor.applyPatch({ generation: 3, ledgerCursor: 4, changes: [upsert(4, session('a', 'v2'))] })
    actor.applyPatch({ generation: 4, ledgerCursor: 5, changes: [upsert(5, session('a', 'v3'))] })

    const healed = actor.prepare({ view: revoked, sinceCursor: 2 })
    expect(healed.kind).toBe('snapshot')
    expect(healed).toMatchObject({ generation: 4, ledgerCursor: 5 })
    expect(decoded(healed)).toEqual({
      type: 'sessionsChanged',
      sessions: [session('a', 'v3')],
    })
  })

  it('rejects out-of-order generations and cursor regressions without mutating the model', () => {
    const actor = new SessionPublicationActor()
    const alice = view('alice', ['a'])
    actor.applyPatch({ generation: 1, ledgerCursor: 1, changes: [upsert(1, session('a'))] })

    expect(() =>
      actor.applyPatch({
        generation: 1,
        ledgerCursor: 2,
        changes: [upsert(2, session('a', 'bad-generation'))],
      }),
    ).toThrow(/generation/)
    expect(() =>
      actor.applyPatch({
        generation: 2,
        ledgerCursor: 0,
        changes: [upsert(2, session('a', 'bad-cursor'))],
      }),
    ).toThrow(/cursor/)

    expect(decoded(actor.prepare({ view: alice, sinceCursor: null }))).toEqual({
      type: 'sessionsChanged',
      sessions: [session('a')],
    })
  })
})

/**
 * THE PER-CONNECTION ENTITY SINK — the entanglement the cutover preserved
 * (POD-1203).
 *
 * `deliverEntityMessage` is the two deleted methods' branches transcribed:
 * `fanOutSnapshot` decided which snapshots a connection may receive,
 * `sendMetadataDelta` decided how a delta reaches one, and they were entangled
 * because a connection's publication AUTHORITY — not its wire capability —
 * decides both. Every case here drives ONE connection with ONE message and
 * asserts what that connection received, which is the only way to see the
 * branches apart.
 *
 * WHAT EACH REFUSING ARM DEPENDS ON: a publication authority this file
 * constructs, with `global` set either way. No case depends on a socket, a wire
 * version or a capability, and the two suppression rules are asserted against a
 * connection that PROVABLY receives other messages — a sink that dropped
 * everything would satisfy them just as well.
 */

import type { ServerMessage } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import type { ClientConn } from '../../gateway/client-registry'
import { SessionRegistry } from '../../relay'
import { testClientPrincipal } from '../../test-support/client-principal'

const SESSIONS_CHANGED: ServerMessage = { type: 'sessionsChanged', sessions: [] }
const ISSUES_CHANGED: ServerMessage = { type: 'issuesChanged', issues: [] }
const FEED_DELTA = {
  type: 'feedDelta',
  feedId: 'f',
  epoch: 'e',
  fromSeq: 0,
  seq: 1,
  minAvailableSeq: 0,
  changes: [],
} as unknown as ServerMessage

function connection(publication?: { global: boolean }) {
  const sent: ServerMessage[] = []
  const conn: ClientConn = {
    id: 'c-test',
    principal: testClientPrincipal('c-test'),
    send: (msg: ServerMessage) => {
      sent.push(msg)
      return 0
    },
    viewports: new Map(),
    attached: new Set(),
    caps: new Set(),
    wireVersion: 1,
    transcriptSubs: new Set(),
    visible: true,
    viewVisible: new Set(),
    focused: null,
    viewModes: {},
    ...(publication
      ? {
          publication: {
            principal: 'operator',
            scope: 'all',
            serverRole: 'standalone',
            protocolVersion: 1,
            global: publication.global,
            snapshot: () => ({ revision: 0, allowedSignature: 'global', allowedSessionIds: [] }),
            sendPrepared: (bytes: string) => sent.push(JSON.parse(bytes) as ServerMessage),
          } as ClientConn['publication'],
        }
      : {}),
  }
  return { conn, sent }
}

function sessions() {
  const registry = new SessionRegistry(undefined, undefined, { instanceId: 'default' })
  return {
    registry,
    deliver: (conn: ClientConn, msg: ServerMessage) =>
      registry.modules.sessions.deliverEntityMessage(conn, msg),
  }
}

describe('the per-connection entity sink', () => {
  it('a connection with NO publication receives everything', () => {
    // The positive first. Every suppression below is only meaningful against a
    // sink that is provably delivering something.
    const { registry, deliver } = sessions()
    const { conn, sent } = connection()
    for (const msg of [SESSIONS_CHANGED, ISSUES_CHANGED, FEED_DELTA]) deliver(conn, msg)
    expect(sent.map((m) => m.type)).toEqual(['sessionsChanged', 'issuesChanged', 'feedDelta'])
    registry.dispose()
  })

  it('a GLOBAL publication never receives sessionsChanged — its worker owns that world', () => {
    const { registry, deliver } = sessions()
    const { conn, sent } = connection({ global: true })
    deliver(conn, SESSIONS_CHANGED)
    expect(sent).toEqual([])
    // …and it is not deaf: the other lists still reach it.
    deliver(conn, ISSUES_CHANGED)
    expect(sent.map((m) => m.type)).toEqual(['issuesChanged'])
    registry.dispose()
  })

  it('a SCOPED publication receives nothing but its worker output', () => {
    const { registry, deliver } = sessions()
    const { conn, sent } = connection({ global: false })
    for (const msg of [SESSIONS_CHANGED, ISSUES_CHANGED]) deliver(conn, msg)
    expect(sent).toEqual([])
    registry.dispose()
  })

  it('a REFUSED connection receives nothing at all, publication or not', () => {
    const { registry, deliver } = sessions()
    const { conn, sent } = connection()
    conn.entityServingRefused = true
    for (const msg of [SESSIONS_CHANGED, ISSUES_CHANGED, FEED_DELTA]) deliver(conn, msg)
    expect(sent).toEqual([])
    registry.dispose()
  })

  it('THE REFUSAL CAN FIRE: a v2 frame to a SCOPED connection throws', () => {
    // A refusal nobody has seen fire is a refusal that might be unreachable. This
    // is the tripwire for POD-1208 — the prepared-publication worker speaks only
    // the v1 shapes, so it cannot narrow a v2 frame, and serving one unfiltered
    // would hand a scoped connection the global feed.
    const { registry, deliver } = sessions()
    const { conn } = connection({ global: false })
    expect(() => deliver(conn, FEED_DELTA)).toThrow(/SCOPED publication connection/)
    // And the paired half: the SAME frame to a global publication is fine, so the
    // throw is about scoping rather than about v2 frames.
    const { conn: globalConn, sent } = connection({ global: true })
    expect(() => deliver(globalConn, FEED_DELTA)).not.toThrow()
    expect(sent.map((m) => m.type)).toEqual(['feedDelta'])
    registry.dispose()
  })
})

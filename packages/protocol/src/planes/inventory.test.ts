import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { ClientMessage } from '../messages/client'
import { ControlMessage } from '../messages/control'
import { DaemonMessage } from '../messages/daemon'
import { DaemonHandshake, DaemonHandshakeReply } from '../messages/daemon-handshake'
import {
  CLIENT_MESSAGE_CLASS,
  CLIENT_PLANE_CLASS,
  CONTROL_MESSAGE_CLASS,
  CONTROL_PLANE_CLASS,
  DAEMON_MESSAGE_CLASS,
  DAEMON_PLANE_CLASS,
  SERVER_MESSAGE_CLASS,
  SERVER_PLANE_CLASS,
} from '../messages/message-class'
import { ServerMessage } from '../messages/server'
import {
  HANDSHAKE_PLANE_CLASS,
  NON_WS_SURFACE_INVENTORY,
  PENDING_FRAME_PLANE_CLASS_TABLES,
  PLANE_INVENTORY_COUNTS,
  POST_AUTH_PLANE_CLASS_TABLES,
  PRESENCE_ROOM_CLIENT_PLANE_CLASS,
  PRESENCE_ROOM_SERVER_PLANE_CLASS,
  planeClassOf,
  SCOPED_FEED_PLANE_CLASS,
} from './inventory'
import {
  PLANE_CLASS_OF_SYNC_CLASS,
  PLANE_CLASS_SEMANTICS,
  PLANE_CLASSES,
  planeOf,
  SYNC_CLASS_OF_PLANE_CLASS,
} from './plane'
import {
  AGENT_RELAY_FRAMES,
  edgeOf,
  HOST_EDGE_FRAMES,
  hostEdgeSeparationViolations,
  routableOverAgentRelay,
} from './port-rule'
import { PresenceRoomClientMessage, PresenceRoomServerMessage } from './presence-rooms'
import { ScopedFeedServerMessage } from './scoped-feed'

/** Literal `type` values of a discriminated union, read from the code. */
const unionTypes = (union: { readonly options: readonly unknown[] }): string[] =>
  union.options
    .map((option) => (option as { shape: { type: z.ZodLiteral<string> } }).shape.type.value)
    .sort()

const tableKeys = (table: Record<string, unknown>): string[] => Object.keys(table).sort()

describe('ADR 7 D6 totality — every wire message maps to exactly one plane·class', () => {
  const surfaces = [
    ['ServerMessage', ServerMessage, SERVER_PLANE_CLASS],
    ['ClientMessage', ClientMessage, CLIENT_PLANE_CLASS],
    ['ControlMessage', ControlMessage, CONTROL_PLANE_CLASS],
    ['DaemonMessage', DaemonMessage, DAEMON_PLANE_CLASS],
  ] as const

  for (const [name, union, table] of surfaces) {
    it(`${name}: the table's key set is exactly the union's type set`, () => {
      // The compile-time `satisfies Record<Union['type'], PlaneClass>` catches a
      // MISSING classification; this catches the other direction — a table key
      // for a type the union no longer has.
      expect(tableKeys(table)).toEqual(unionTypes(union))
    })

    it(`${name}: every value is one of the closed plane·class set`, () => {
      for (const value of Object.values(table)) {
        expect(PLANE_CLASSES).toContain(value)
      }
    })
  }

  it('re-derives the counts from the code at this baseline, not from ADR prose', () => {
    // ADR 7 D6 counted 122 post-auth types at baseline ca361327; D16 requires the
    // implementer to re-derive rather than copy. The tree has moved since.
    expect(PLANE_INVENTORY_COUNTS.ServerMessage).toBe(Object.keys(SERVER_PLANE_CLASS).length)
    expect(PLANE_INVENTORY_COUNTS.ClientMessage).toBe(Object.keys(CLIENT_PLANE_CLASS).length)
    expect(PLANE_INVENTORY_COUNTS.ControlMessage).toBe(Object.keys(CONTROL_PLANE_CLASS).length)
    expect(PLANE_INVENTORY_COUNTS.DaemonMessage).toBe(Object.keys(DAEMON_PLANE_CLASS).length)
    expect(PLANE_INVENTORY_COUNTS.postAuthWsTotal).toBe(
      PLANE_INVENTORY_COUNTS.ServerMessage +
        PLANE_INVENTORY_COUNTS.ClientMessage +
        PLANE_INVENTORY_COUNTS.ControlMessage +
        PLANE_INVENTORY_COUNTS.DaemonMessage,
    )
    // Sanity: the inventory grew relative to the ADR's snapshot; it did not shrink.
    expect(PLANE_INVENTORY_COUNTS.postAuthWsTotal).toBeGreaterThanOrEqual(122)
  })

  it('classifies the pre-auth handshake as control · handshake, outside the post-auth unions', () => {
    const handshake = [...unionTypes(DaemonHandshake), ...unionTypes(DaemonHandshakeReply)].sort()
    expect(tableKeys(HANDSHAKE_PLANE_CLASS)).toEqual(handshake)
    expect(PLANE_INVENTORY_COUNTS.handshake).toBe(6)
    for (const value of Object.values(HANDSHAKE_PLANE_CLASS)) {
      expect(value).toBe('control.handshake')
    }
  })

  it('planeClassOf refuses to guess for an unknown type', () => {
    expect(planeClassOf('ClientMessage', 'presence')).toBe('stream.live')
    expect(planeClassOf('ClientMessage', 'notAFrame')).toBeNull()
  })

  it('inventories the non-WS surfaces the gateway owns', () => {
    for (const surface of NON_WS_SURFACE_INVENTORY) {
      expect(PLANE_CLASSES).toContain(surface.planeClass)
    }
    // Bulk over HTTP is present and is the only bulk-plane surface there.
    const bulk = NON_WS_SURFACE_INVENTORY.filter((s) => s.planeClass === 'bulk.bulk')
    expect(bulk).toHaveLength(1)
  })
})

describe('ADR 7 D1 — three planes, command as a class inside control', () => {
  it('has exactly three planes across the closed plane·class set', () => {
    expect([...new Set(PLANE_CLASSES.map((pc) => planeOf(pc)))].sort()).toEqual([
      'bulk',
      'control',
      'stream',
    ])
  })

  it('carries command inside control, with its own delivery semantics', () => {
    expect(PLANE_CLASSES).toContain('control.command')
    expect(PLANE_CLASSES).not.toContain('command.command')
    const command = PLANE_CLASS_SEMANTICS['control.command']
    const entity = PLANE_CLASS_SEMANTICS['control.entity']
    expect(command.requiresLivePeer).toBe(true)
    expect(command.oplogged).toBe(false)
    expect(command.routing).toBe('point-to-point')
    // Same port, different delivery — that is the whole content of "not a plane".
    expect(entity.oplogged).toBe(true)
    expect(entity.routing).toBe('per-principal')
  })

  it('bridges today’s four sync-class labels to plane·class, both ways', () => {
    expect(PLANE_CLASS_OF_SYNC_CLASS).toEqual({
      durable: 'control.entity',
      command: 'control.command',
      live: 'stream.live',
      bulk: 'bulk.bulk',
    })
    for (const [label, planeClass] of Object.entries(PLANE_CLASS_OF_SYNC_CLASS)) {
      expect(SYNC_CLASS_OF_PLANE_CLASS[planeClass]).toBe(label)
    }
    // Handshake has no legacy label; `null` is the honest answer.
    expect(SYNC_CLASS_OF_PLANE_CLASS['control.handshake']).toBeNull()
  })

  it('derives the legacy tables from the plane tables (one migration window)', () => {
    const pairs = [
      [SERVER_PLANE_CLASS, SERVER_MESSAGE_CLASS],
      [CLIENT_PLANE_CLASS, CLIENT_MESSAGE_CLASS],
      [CONTROL_PLANE_CLASS, CONTROL_MESSAGE_CLASS],
      [DAEMON_PLANE_CLASS, DAEMON_MESSAGE_CLASS],
    ] as const
    for (const [planeTable, legacy] of pairs) {
      for (const [type, planeClass] of Object.entries(planeTable)) {
        expect((legacy as Record<string, string>)[type]).toBe(
          SYNC_CLASS_OF_PLANE_CLASS[planeClass as keyof typeof SYNC_CLASS_OF_PLANE_CLASS],
        )
      }
    }
    // Spot-check the shipped classifications are unchanged by the migration.
    expect(SERVER_MESSAGE_CLASS.sessionsChanged).toBe('durable')
    expect(SERVER_MESSAGE_CLASS.outputFrame).toBe('live')
    expect(CLIENT_MESSAGE_CLASS.transcriptSubscribe).toBe('bulk')
    expect(CONTROL_MESSAGE_CLASS.spawn).toBe('command')
  })
})

describe('ADR 7 D3/D4/D5 — the ambiguous cases ship as resolved', () => {
  it('titles: the spinner-rate message is stream; the entity field is control', () => {
    expect(SERVER_PLANE_CLASS.sessionTitleChanged).toBe('stream.live')
    expect(DAEMON_PLANE_CLASS.title).toBe('stream.live')
    // Curated name / nameSource are entity-only: there is no dedicated frame.
    expect(Object.keys(SERVER_PLANE_CLASS)).not.toContain('sessionNameChanged')
    // The entity carrier is the durable session aggregate.
    expect(SERVER_PLANE_CLASS.sessionsChanged).toBe('control.entity')
  })

  it('agent runtime state: dual delivery, stream message + entity field', () => {
    expect(SERVER_PLANE_CLASS.sessionAgentStateChanged).toBe('stream.live')
    expect(DAEMON_PLANE_CLASS.agentState).toBe('stream.live')
    expect(SERVER_PLANE_CLASS.metadataDelta).toBe('control.entity')
  })

  it('drafts: the write is entity, the push is stream', () => {
    expect(CLIENT_PLANE_CLASS.setSessionDraft).toBe('control.entity')
    expect(CLIENT_PLANE_CLASS.draftEdit).toBe('control.entity')
    expect(SERVER_PLANE_CLASS.sessionDraftChanged).toBe('stream.live')
  })

  it('browser-open (D8) and sessionResumeRefAck keep their drift-refreshed classes', () => {
    expect(SERVER_PLANE_CLASS.sessionOpenUrl).toBe('stream.live')
    expect(SERVER_PLANE_CLASS.sessionOpenUrlResult).toBe('stream.live')
    expect(CLIENT_PLANE_CLASS.sessionOpenUrlCallback).toBe('control.command')
    expect(CLIENT_PLANE_CLASS.sessionOpenUrlDismiss).toBe('control.command')
    expect(CONTROL_PLANE_CLASS.sessionResumeRefAck).toBe('control.command')
    expect(DAEMON_PLANE_CLASS.sessionResumeRef).toBe('control.command')
  })

  it('handoff (D7): every frame is command class, chunk mechanics notwithstanding', () => {
    const handoff = [
      ...Object.keys(CONTROL_PLANE_CLASS),
      ...Object.keys(DAEMON_PLANE_CLASS),
    ].filter((t) => t.startsWith('handoff'))
    expect(handoff).toHaveLength(8)
    for (const type of handoff) {
      const planeClass =
        (CONTROL_PLANE_CLASS as Record<string, string>)[type] ??
        (DAEMON_PLANE_CLASS as Record<string, string>)[type]
      expect(planeClass).toBe('control.command')
    }
  })
})

describe('ADR 7 Amendment 1 D16 — new frames are not exempt from totality', () => {
  it('classifies room / presence frames as stream · live in both directions', () => {
    expect(tableKeys(PRESENCE_ROOM_CLIENT_PLANE_CLASS)).toEqual(
      unionTypes(PresenceRoomClientMessage),
    )
    expect(tableKeys(PRESENCE_ROOM_SERVER_PLANE_CLASS)).toEqual(
      unionTypes(PresenceRoomServerMessage),
    )
    for (const table of [PRESENCE_ROOM_CLIENT_PLANE_CLASS, PRESENCE_ROOM_SERVER_PLANE_CLASS]) {
      for (const value of Object.values(table)) expect(value).toBe('stream.live')
    }
    // D10.4: the join's ANSWER is stream too — never promoted to control · command.
    expect(PRESENCE_ROOM_SERVER_PLANE_CLASS.presenceRoomState).toBe('stream.live')
    expect(PRESENCE_ROOM_SERVER_PLANE_CLASS.presenceRoomClosed).toBe('stream.live')
  })

  it('classifies rescope as control · entity, and gives watermark/evict no frame', () => {
    expect(tableKeys(SCOPED_FEED_PLANE_CLASS)).toEqual(unionTypes(ScopedFeedServerMessage))
    expect(SCOPED_FEED_PLANE_CLASS.rescope).toBe('control.entity')
    // ADR 2 Amd 1 D13: a watermark is metadataDelta with an empty change list.
    const everyType = [
      ...Object.keys(SERVER_PLANE_CLASS),
      ...Object.keys(SCOPED_FEED_PLANE_CLASS),
      ...Object.keys(PRESENCE_ROOM_SERVER_PLANE_CLASS),
    ]
    expect(everyType).not.toContain('watermark')
    expect(everyType).not.toContain('evict')
  })

  it('keeps every pending frame inside the closed plane·class set', () => {
    for (const table of Object.values(PENDING_FRAME_PLANE_CLASS_TABLES)) {
      for (const value of Object.values(table)) expect(PLANE_CLASSES).toContain(value)
    }
    expect(PLANE_INVENTORY_COUNTS.pendingFrames).toBe(7)
  })

  it('does not double-classify a type across the post-auth tables of one direction', () => {
    // A type may legitimately appear on two directions (agentExit, transcriptDelta);
    // what must never happen is one type with two classes on the SAME surface.
    for (const table of Object.values(POST_AUTH_PLANE_CLASS_TABLES)) {
      const keys = Object.keys(table)
      expect(new Set(keys).size).toBe(keys.length)
    }
  })
})

describe('ADR 7 D2 — host↔server separation is a NAMED port rule', () => {
  it('has no frame on both edges', () => {
    expect(hostEdgeSeparationViolations()).toEqual([])
  })

  it('limits the agent relay to exactly two peer frames', () => {
    expect([...AGENT_RELAY_FRAMES]).toEqual(['agentRelayRequest', 'agentRelayResult'])
    expect(CONTROL_PLANE_CLASS.agentRelayResult).toBe('control.command')
    expect(DAEMON_PLANE_CLASS.agentRelayRequest).toBe('control.command')
  })

  it('refuses to route a host callback over the agent relay', () => {
    for (const frame of HOST_EDGE_FRAMES) {
      expect(routableOverAgentRelay(frame)).toBe(false)
      expect(edgeOf(frame)).toBe('host')
    }
    for (const frame of AGENT_RELAY_FRAMES) {
      expect(routableOverAgentRelay(frame)).toBe(true)
      expect(edgeOf(frame)).toBe('agent-relay')
    }
  })

  it('names the host channels the specs call out (hooks, browser-open, resume-ref, PTY)', () => {
    for (const frame of [
      'agentState',
      'title',
      'sessionResumeRef',
      'sessionResumeRefAck',
      'sessionOpenUrl',
      'sessionOpenUrlCallback',
      'agentFrame',
    ]) {
      expect(HOST_EDGE_FRAMES as readonly string[]).toContain(frame)
    }
  })

  it('every host-edge frame is itself classified in the inventory', () => {
    const classified = new Set([
      ...Object.keys(SERVER_PLANE_CLASS),
      ...Object.keys(CLIENT_PLANE_CLASS),
      ...Object.keys(CONTROL_PLANE_CLASS),
      ...Object.keys(DAEMON_PLANE_CLASS),
    ])
    for (const frame of HOST_EDGE_FRAMES) expect(classified).toContain(frame)
  })
})

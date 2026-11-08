import { describe, expect, it } from 'vitest'
import { ClientMessage } from '../messages/client'
import { ControlMessage } from '../messages/control'
import { DaemonMessage } from '../messages/daemon'
import {
  CLIENT_PLANE_CLASS,
  CONTROL_PLANE_CLASS,
  DAEMON_PLANE_CLASS,
  SERVER_PLANE_CLASS,
} from '../messages/message-class'
import { ServerMessage } from '../messages/server'
import { roomRoutingKey } from './routing'
import {
  checkoutTopicId,
  isNewerTopicPosition,
  parseCheckoutTopicId,
  parseTopicKey,
  parseTopicPayload,
  TOPIC_KIND_NAMES,
  TOPIC_KINDS,
  TOPIC_PRODUCERS,
  TOPIC_STYLES,
  TOPIC_VISIBILITY,
  topicKey,
  topicRefFromRoutingKey,
  topicRoutingKey,
} from './topics'

describe('TOPIC_KINDS (ADR 7 Amendment 2 D17/D18)', () => {
  it('declares every field for every kind, from the closed vocabularies', () => {
    expect(TOPIC_KIND_NAMES.length).toBeGreaterThan(0)
    for (const kind of TOPIC_KIND_NAMES) {
      const decl = TOPIC_KINDS[kind]
      expect(TOPIC_STYLES, kind).toContain(decl.style)
      expect(TOPIC_PRODUCERS, kind).toContain(decl.producer)
      expect(TOPIC_VISIBILITY, kind).toContain(decl.visibility)
      expect(Number.isInteger(decl.minIntervalMs) && decl.minIntervalMs >= 0, kind).toBe(true)
      expect(typeof decl.id.safeParse, kind).toBe('function')
      expect(typeof decl.payload.safeParse, kind).toBe('function')
      // A daemon kind says what its daemon publishes; a server kind publishes nothing.
      expect('publish' in decl, kind).toBe(decl.producer === 'daemon')
      // Values and logs are rate-limited; events are not coalesced.
      if (decl.style === 'event') expect(decl.minIntervalMs, kind).toBe(0)
      else expect(decl.minIntervalMs, kind).toBeGreaterThan(0)
    }
  })

  it('names the D26 first kinds with their declared shape', () => {
    expect(TOPIC_KINDS['machine.condition']).toMatchObject({
      style: 'value',
      producer: 'server',
      visibility: 'machine',
      minIntervalMs: 1_000,
    })
    expect(TOPIC_KINDS['machine.metrics']).toMatchObject({
      style: 'value',
      producer: 'daemon',
      visibility: 'machine',
      minIntervalMs: 5_000,
    })
    expect(TOPIC_KINDS['account.events']).toMatchObject({
      style: 'event',
      producer: 'server',
      visibility: 'account.self',
    })
  })

  it('checks payloads against their kind', () => {
    expect(parseTopicPayload('machine.condition', { online: true, since: null })).toEqual({
      online: true,
      since: null,
    })
    expect(parseTopicPayload('machine.condition', { online: 'yes' })).toBeUndefined()
    expect(
      parseTopicPayload('account.events', {
        type: 'attentionEvent',
        sessionId: 's-1',
        title: 't',
        body: 'b',
      }),
    ).toMatchObject({ type: 'attentionEvent' })
    // Only the declared one-off notices ride account.events.
    expect(parseTopicPayload('account.events', { type: 'pong' })).toBeUndefined()
  })
})

describe('topic keys', () => {
  it('round-trips kind and id, escaping separators so two keys never collide', () => {
    const plain = topicKey('machine.metrics', 'm-1')
    expect(plain).toBe('machine.metrics:m-1')
    expect(parseTopicKey(plain)).toEqual({ kind: 'machine.metrics', id: 'm-1' })
    const colon = topicKey('machine.metrics', 'a:b')
    expect(parseTopicKey(colon)).toEqual({ kind: 'machine.metrics', id: 'a:b' })
    expect(colon).not.toBe(topicKey('machine.metrics', 'a'))
  })

  it('round-trips checkout addresses and refuses relative paths and forged machine sentinels', () => {
    const id = checkoutTopicId(
      'machine' as import('@podium/model').MachineId,
      '/repo:with\\separators',
    )
    expect(parseCheckoutTopicId(id)).toEqual({
      machineId: 'machine',
      path: '/repo:with\\separators',
    })
    expect(parseCheckoutTopicId('machine:relative')).toBeUndefined()
    expect(parseCheckoutTopicId('local:/repo')).toBeUndefined()
    expect(TOPIC_KINDS['checkout.changed'].id.safeParse(id).success).toBe(true)
  })

  it('refuses malformed keys instead of guessing', () => {
    expect(parseTopicKey('no-separator')).toBeUndefined()
    expect(parseTopicKey(':id')).toBeUndefined()
    expect(parseTopicKey('kind:')).toBeUndefined()
  })

  it('lives in its own registry namespace beside rooms', () => {
    const key = topicRoutingKey({ kind: 'machine.metrics', id: 'm-1' })
    expect(key.startsWith('topic:')).toBe(true)
    expect(topicRefFromRoutingKey(key)).toEqual({ kind: 'machine.metrics', id: 'm-1' })
    expect(topicRefFromRoutingKey(roomRoutingKey({ kind: 'session', id: 's-1' }))).toBeUndefined()
  })
})

describe('topic positions (D19)', () => {
  it('applies only a larger seq in the same epoch', () => {
    const held = { epoch: 'e1', seq: 4 }
    expect(isNewerTopicPosition(undefined, held)).toBe(true)
    expect(isNewerTopicPosition(held, { epoch: 'e1', seq: 5 })).toBe(true)
    expect(isNewerTopicPosition(held, { epoch: 'e1', seq: 4 })).toBe(false)
    expect(isNewerTopicPosition(held, { epoch: 'e1', seq: 3 })).toBe(false)
    // A new epoch arrives as a snapshot; an UPDATE from another epoch never applies.
    expect(isNewerTopicPosition(held, { epoch: 'e2', seq: 9 })).toBe(false)
  })
})

describe('topic frames (D23)', () => {
  it('are members of the four wire unions, stream · live except the daemon demand', () => {
    expect(ClientMessage.parse({ type: 'topicSubscribe', key: 'machine.metrics:m' })).toBeTruthy()
    expect(ClientMessage.parse({ type: 'topicUnsubscribe', key: 'machine.metrics:m' })).toBeTruthy()
    expect(
      ServerMessage.parse({
        type: 'topicSnapshot',
        key: 'machine.metrics:m',
        position: { epoch: 'e', seq: 0 },
      }),
    ).toBeTruthy()
    expect(
      ServerMessage.parse({ type: 'topicClosed', key: 'x.y:m', reason: 'unsupported' }),
    ).toBeTruthy()
    expect(
      ControlMessage.parse({ type: 'topicWatch', key: 'machine.metrics:m', on: false }),
    ).toBeTruthy()
    expect(
      DaemonMessage.parse({ type: 'topicPublish', key: 'machine.metrics:m', payload: {} }),
    ).toBeTruthy()
    for (const type of ['topicSubscribe', 'topicUnsubscribe'] as const) {
      expect(CLIENT_PLANE_CLASS[type]).toBe('stream.live')
    }
    for (const type of ['topicSnapshot', 'topicUpdate', 'topicEvent', 'topicClosed'] as const) {
      expect(SERVER_PLANE_CLASS[type]).toBe('stream.live')
    }
    // The daemon ACTS on demand, so it is a command, like runtimeWatch.
    expect(CONTROL_PLANE_CLASS.topicWatch).toBe('control.command')
    expect(DAEMON_PLANE_CLASS.topicPublish).toBe('stream.live')
  })

  it('an unknown KIND still parses, so the server can answer unsupported; a malformed key does not', () => {
    expect(ClientMessage.safeParse({ type: 'topicSubscribe', key: 'future.kind:x' }).success).toBe(
      true,
    )
    expect(ClientMessage.safeParse({ type: 'topicSubscribe', key: 'nonsense' }).success).toBe(false)
  })
})

/**
 * The legacy adapter is ONE translation onto the permanent mechanism, not a second
 * auth path (ADR 5 D3.1 / POD-308). These tests pin that: a legacy frame reaches
 * the SAME acceptor, the SAME strategies and the same principal as an envelope
 * peer, and the reply it gets back is the shape today's shipped daemon expects.
 */

import { describe, expect, it } from 'vitest'
import type { DaemonHandshake } from '../messages/daemon-handshake'
import { createHandshakeAcceptor } from './acceptor'
import {
  helloFromLegacyDaemonFrame,
  isLegacyDaemonFrame,
  legacyReplyFor,
} from './legacy-daemon-frames'
import { createDefaultAuthRegistry } from './strategies/default-registry'
import {
  createRecordingMinter,
  fakeMachines,
  machineRecord,
  pairedMachineRecord,
  transportFacts,
} from './test-support'

const acceptor = () =>
  createHandshakeAcceptor({
    registry: createDefaultAuthRegistry({
      machines: fakeMachines({
        tokens: {
          'tok-ok': machineRecord('mach-vps', {
            owner: 'usr-ada',
            name: 'vps',
            updatePubkey: 'server-key-2',
          }),
        },
        codes: {
          'code-1': pairedMachineRecord('mach-new', 'tok-minted', {
            owner: 'usr-ada',
            name: 'new-box',
            updatePubkey: 'server-key-1',
          }),
        },
      }),
      mint: createRecordingMinter(),
    }),
    transport: transportFacts({ endpoint: '/daemon' }),
  })

const legacyHello: DaemonHandshake = {
  type: 'hello',
  machineId: 'mach-vps',
  token: 'tok-ok',
  hostname: 'vps.local',
}

const legacyPair: DaemonHandshake = {
  type: 'pair',
  code: 'code-1',
  machineId: 'mach-new',
  hostname: 'new.local',
  name: 'New Box',
}

describe('legacy daemon frames ride the permanent mechanism', () => {
  it('recognises the legacy frames and nothing else', () => {
    expect(isLegacyDaemonFrame({ type: 'hello' })).toBe(true)
    expect(isLegacyDaemonFrame({ type: 'pair' })).toBe(true)
    expect(isLegacyDaemonFrame({ type: 'peerHello' })).toBe(false)
    expect(isLegacyDaemonFrame('nope')).toBe(false)
  })

  it('a legacy hello authenticates through the same strategy as an envelope peer', () => {
    const step = acceptor().receive(JSON.stringify(helloFromLegacyDaemonFrame(legacyHello)))
    expect(step.action).toBe('establish')
    if (step.action !== 'establish') return
    expect(step.peer.strategy).toBe('machine-token')
    expect(step.peer.principal).toMatchObject({ kind: 'machine', machine: 'mach-vps' })
    expect(legacyReplyFor(legacyHello, step.reply)).toEqual({
      type: 'helloOk',
      name: 'vps',
      updatePubkey: 'server-key-2',
    })
  })

  it("a legacy hello's machineId becomes a hint, not the identity", () => {
    const envelope = helloFromLegacyDaemonFrame(legacyHello)
    expect(envelope.credential).toEqual({
      kind: 'machineToken',
      token: 'tok-ok',
      machineHint: 'mach-vps',
    })
    expect(envelope.claims).toMatchObject({ machineId: 'mach-vps' })
    // A stolen token presented with someone else's machineId resolves to the
    // token's own machine, not the claimed one.
    const forged = { ...legacyHello, machineId: 'mach-someone-elses' }
    const step = acceptor().receive(JSON.stringify(helloFromLegacyDaemonFrame(forged)))
    expect(step.action === 'establish' && step.peer.principal).toMatchObject({
      machine: 'mach-vps',
    })
  })

  it('a legacy pair mints a token once and reports the id the server resolved', () => {
    const step = acceptor().receive(JSON.stringify(helloFromLegacyDaemonFrame(legacyPair)))
    expect(step.action).toBe('establish')
    if (step.action !== 'establish') return
    expect(legacyReplyFor(legacyPair, step.reply)).toEqual({
      type: 'paired',
      token: 'tok-minted',
      machineId: 'mach-new',
      name: 'new-box',
      updatePubkey: 'server-key-1',
    })
  })

  it('maps refusals back to the legacy reply the shipped daemon expects', () => {
    const badHello: DaemonHandshake = { ...legacyHello, token: 'tok-rotated' }
    const step = acceptor().receive(JSON.stringify(helloFromLegacyDaemonFrame(badHello)))
    expect(step.action).toBe('reject')
    if (step.action !== 'reject') return
    expect(legacyReplyFor(badHello, step.reply)).toEqual({
      type: 'helloRejected',
      // The closed reason code, since a token failure carries no peer message.
      reason: 'auth-failed',
    })

    const badPair: DaemonHandshake = { ...legacyPair, code: 'expired' }
    const pairStep = acceptor().receive(JSON.stringify(helloFromLegacyDaemonFrame(badPair)))
    expect(pairStep.action === 'reject' && legacyReplyFor(badPair, pairStep.reply)).toEqual({
      type: 'pairRejected',
      // The pairing ceremony keeps its human-readable UX.
      reason: 'invalid or expired code',
    })
  })
})

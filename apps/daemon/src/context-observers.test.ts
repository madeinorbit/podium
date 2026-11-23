import {
  type HarnessObserveInput,
  type HarnessObserverHost,
  harnessAdapterFor,
  supported,
} from '@podium/harness'
import { testHarnessContext } from '@podium/harness/driver/testing'
import { asSessionId } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import { createSessionObservers } from './session-observers'

describe('opaque context observer ownership', () => {
  it('forwards fresh invocation facts, while persisted adoption has no start witness', () => {
    const adapter = harnessAdapterFor('codex')!
    const inputs: HarnessObserveInput[] = []
    const observers = createSessionObservers({
      send: vi.fn(),
      onTranscriptDirty: vi.fn(),
      cwdTracker: { onHookCwd: vi.fn(async () => {}) },
      harnessAdapterFor: () => ({
        ...adapter,
        observer: supported((input) => {
          inputs.push(input)
          return { stop() {} }
        }),
      }),
    })
    const sessionId = asSessionId('invocation-facts')
    const first = testHarnessContext({ kind: 'codex', version: 'codex-cli 0.169.0' })
    const changed = testHarnessContext({ kind: 'codex', version: 'codex-cli 0.170.0' })
    try {
      observers.bindHeadlessSession(sessionId, 'codex', '/invented', 'native', {
        harnessContext: first,
        startedAtMs: 1000,
      })
      observers.bindHeadlessSession(sessionId, 'codex', '/invented', 'native', {
        harnessContext: changed,
      })
      observers.bindHeadlessSession(sessionId, 'codex', '/invented', 'native', {
        harnessContext: changed,
        startedAtMs: 2000,
      })
      expect(inputs.map((input) => [input.harnessContext, input.startedAtMs])).toEqual([
        [first, 1000],
        [changed, undefined],
        [changed, 2000],
      ])
      expect(inputs[0]?.account).toBe(first)
    } finally {
      observers.disposeObservers()
      observers.stopAllTails()
    }
  })
  it('uses actual driver identity for non-causal stores and fences old callbacks across rebind/disposal', () => {
    const adapter = harnessAdapterFor('opencode')
    if (!adapter) throw new Error('No adapter for the observer fixture')
    const hosts: HarnessObserverHost[] = []
    let identity = { observerGeneration: 7, turnEpoch: 4 }
    const onContextPayload = vi.fn()
    const observers = createSessionObservers({
      send: vi.fn(),
      onTranscriptDirty: vi.fn(),
      cwdTracker: { onHookCwd: vi.fn(async () => {}) },
      contextIdentity: () => identity,
      onContextPayload,
      harnessAdapterFor: () => ({
        ...adapter,
        observer: supported((_input, host) => {
          hosts.push(host)
          return { stop: vi.fn() }
        }),
      }),
    })
    const sessionId = asSessionId('opaque-store-context')
    const source = {
      at: '2026-11-21T12:00:00.000Z',
      provenance: 'bootstrap' as const,
      cursor: { segmentId: 'invented-native-rows', components: { time: 10 } },
      ...identity,
    }
    try {
      observers.bindHeadlessSession(sessionId, 'opencode', '/tmp/invented', 'native-first')
      const first = hosts[0]
      expect(first?.contextIdentity?.()).toEqual(identity)
      first?.onContextPayload?.({ opaque: 'original-native-body' }, source)
      expect(onContextPayload).toHaveBeenLastCalledWith(
        sessionId,
        { opaque: 'original-native-body' },
        source,
      )
      identity = { observerGeneration: 8, turnEpoch: 5 }
      expect(first?.contextIdentity?.()).toBeUndefined()
      first?.onContextPayload?.({ opaque: 'late-generation' }, { ...source, ...identity })
      expect(onContextPayload).toHaveBeenCalledTimes(1)
      observers.bindHeadlessSession(sessionId, 'opencode', '/tmp/invented', 'native-second')
      expect(hosts[1]?.contextIdentity?.()).toEqual(identity)
      first?.onContextPayload?.({ opaque: 'late-old-owner' }, source)
      hosts[1]?.onContextPayload?.({ opaque: 'current-owner' }, { ...source, ...identity })
      expect(onContextPayload).toHaveBeenCalledTimes(2)
      observers.disposeObservers()
      expect(hosts[1]?.contextIdentity?.()).toBeUndefined()
      hosts[1]?.onContextPayload?.({ opaque: 'disposed-owner' }, { ...source, ...identity })
      expect(onContextPayload).toHaveBeenCalledTimes(2)
    } finally {
      observers.stopAllTails()
      observers.disposeObservers()
    }
  })
})

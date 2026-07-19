import type { AgentObservationRebindAckMessage } from '@podium/protocol'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HarnessObservationLease, HarnessObserverHost } from '../adapter.js'

const mockedObserver = vi.hoisted(() => ({
  starts: [] as Array<{
    opts: {
      resumeValue?: string
      onSession?: (id: string, path: string, confidence?: 'exact' | 'heuristic') => void
    }
    stop: ReturnType<typeof vi.fn>
  }>,
}))

vi.mock('../../agent-state/codex.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../agent-state/codex.js')>()
  return {
    ...actual,
    observeCodexState: vi.fn((opts) => {
      const observation = {
        opts,
        stop: vi.fn(),
        onObservationAck: vi.fn(),
      }
      mockedObserver.starts.push(observation)
      return observation
    }),
  }
})

import { codexAdapter } from './codex.js'

function lease(providerSessionId: string | null): HarnessObservationLease {
  return {
    provider: 'codex',
    providerSessionId,
    observerGeneration: 5,
    bindingVersion: 3,
    acceptedCheckpoint: null,
  }
}

function host(): HarnessObserverHost {
  return {
    tailFile: vi.fn(),
    onResumeValue: vi.fn(),
    onTitle: vi.fn(),
    onStateEvents: vi.fn(),
    onObservation: vi.fn(),
    onExactProviderRebind: vi.fn(),
    onTranscriptItems: vi.fn(),
  }
}

function ack(
  result: 'accepted' | 'rejected',
  providerSessionId: string | null,
): AgentObservationRebindAckMessage {
  return {
    type: 'agentObservationRebindAck',
    sessionId: 'podium-1',
    provider: 'codex',
    rebindId: 'codex:3:5:thread-b',
    priorObserverGeneration: 5,
    priorBindingVersion: 3,
    nextProviderSessionId: 'thread-b',
    providerSessionId,
    result,
    ...(result === 'rejected' ? { rejectionReason: 'provider_binding_mismatch' as const } : {}),
    observerGeneration: result === 'accepted' ? 6 : 5,
    bindingVersion: result === 'accepted' ? 4 : 3,
    checkpoint: null,
  }
}

function start(initialLease: HarnessObservationLease) {
  const observerHost = host()
  const observerFactory = codexAdapter.observer
  if (!observerFactory) throw new Error('codex observer is required')
  const observation = observerFactory(
    {
      cwd: '/repo',
      podiumSessionId: 'podium-1',
      resumeValue: initialLease.providerSessionId ?? undefined,
      observationLease: initialLease,
    },
    observerHost,
  )
  return { observation, observerHost }
}

function firstStart() {
  const initial = mockedObserver.starts[0]
  if (!initial) throw new Error('codex observer did not start')
  return initial
}

describe('codex adapter exact rebind fence', () => {
  beforeEach(() => {
    mockedObserver.starts.length = 0
  })

  it('keeps discovered and hook-bound B pending until an accepted ack publishes B', () => {
    const { observation, observerHost } = start(lease('thread-a'))
    const initial = firstStart()
    initial.opts.onSession?.('thread-a', '/rollout/a.jsonl', 'exact')
    initial.opts.onSession?.('thread-b', '/rollout/b.jsonl', 'exact')
    observation.bindHookThread?.('thread-b')

    expect(mockedObserver.starts).toHaveLength(1)
    expect(observerHost.onResumeValue).toHaveBeenCalledTimes(1)
    expect(observerHost.onResumeValue).toHaveBeenLastCalledWith('thread-a', 'exact')
    expect(observerHost.tailFile).toHaveBeenCalledTimes(1)
    expect(observerHost.tailFile).toHaveBeenLastCalledWith('/rollout/a.jsonl')
    expect(observerHost.onExactProviderRebind).toHaveBeenCalledTimes(1)

    observation.onProviderRebindAck?.(ack('accepted', 'thread-b'))

    expect(mockedObserver.starts).toHaveLength(2)
    expect(mockedObserver.starts[1]?.opts.resumeValue).toBe('thread-b')
    expect(observerHost.onResumeValue).toHaveBeenLastCalledWith('thread-b', 'exact')
    expect(observerHost.tailFile).toHaveBeenLastCalledWith('/rollout/b.jsonl')
  })

  it('keeps A observer, resume, and tail when the B proposal is rejected', () => {
    const { observation, observerHost } = start(lease('thread-a'))
    const initial = firstStart()
    initial.opts.onSession?.('thread-a', '/rollout/a.jsonl', 'exact')
    initial.opts.onSession?.('thread-b', '/rollout/b.jsonl', 'heuristic')
    observation.bindHookThread?.('thread-b')

    observation.onProviderRebindAck?.(ack('rejected', 'thread-a'))

    expect(mockedObserver.starts).toHaveLength(1)
    expect(initial.stop).not.toHaveBeenCalled()
    expect(observerHost.onResumeValue).toHaveBeenCalledTimes(1)
    expect(observerHost.onResumeValue).toHaveBeenLastCalledWith('thread-a', 'exact')
    expect(observerHost.tailFile).toHaveBeenCalledTimes(1)
    expect(observerHost.tailFile).toHaveBeenLastCalledWith('/rollout/a.jsonl')
  })

  it('publishes nothing from a null binding until B is accepted', () => {
    const { observation, observerHost } = start(lease(null))
    mockedObserver.starts[0]?.opts.onSession?.('thread-b', '/rollout/b.jsonl', 'exact')

    expect(mockedObserver.starts).toHaveLength(1)
    expect(observerHost.onResumeValue).not.toHaveBeenCalled()
    expect(observerHost.tailFile).not.toHaveBeenCalled()
    expect(observerHost.onExactProviderRebind).toHaveBeenCalledTimes(1)

    observation.onProviderRebindAck?.(ack('accepted', 'thread-b'))

    expect(mockedObserver.starts).toHaveLength(2)
    expect(mockedObserver.starts[1]?.opts.resumeValue).toBe('thread-b')
    expect(observerHost.onResumeValue).toHaveBeenCalledWith('thread-b', 'exact')
    expect(observerHost.tailFile).toHaveBeenCalledWith('/rollout/b.jsonl')
  })
})

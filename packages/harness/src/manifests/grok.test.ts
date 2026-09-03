import { asSessionId } from '@podium/model'
import type { AgentObservationRebindAckMessage } from '@podium/protocol'
import type { StatTick } from '@podium/transcript'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HarnessObservationLease, HarnessObserverHost } from '../manifest.js'

const mocked = vi.hoisted(() => ({
  locate: vi.fn(),
  starts: [] as Array<{
    opts: {
      resumeValue?: string
      onSession: (id: string) => void
      onSessionCandidate: (id: string) => boolean
    }
    stop: ReturnType<typeof vi.fn>
  }>,
}))

vi.mock('../agent-state/grok-locate.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../agent-state/grok-locate.js')>()
  return { ...actual, locateGrokChatHistory: mocked.locate }
})

vi.mock('../agent-state/grok.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../agent-state/grok.js')>()
  return {
    ...actual,
    observeGrokState: vi.fn((opts) => {
      const observation = {
        opts,
        stop: vi.fn(),
        onObservationAck: vi.fn(),
        onHookPayload: vi.fn(() => false),
      }
      mocked.starts.push(observation)
      if (opts.resumeValue) opts.onSession(opts.resumeValue)
      return observation
    }),
  }
})

import { grokManifest } from './grok.js'

class ManualStatTick implements StatTick {
  readonly watchers = new Set<() => void>()
  subscribe(watcher: () => void): () => void {
    this.watchers.add(watcher)
    return () => this.watchers.delete(watcher)
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function lease(providerSessionId: string | null): HarnessObservationLease {
  return {
    provider: 'grok',
    providerSessionId,
    observerGeneration: 1,
    bindingVersion: 1,
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

function start(statTick: ManualStatTick) {
  if (!grokManifest.observer.supported) {
    throw new Error(`grok observer unsupported: ${grokManifest.observer.reason}`)
  }
  const observerHost = host()
  const observation = grokManifest.observer.value(
    {
      cwd: '/repo',
      podiumSessionId: asSessionId('podium-grok'),
      resumeValue: 'session-a',
      homeDir: '/isolated-home',
      transcriptRoot: '/isolated-state/transcripts',
      statTick,
      observationLease: lease('session-a'),
    },
    observerHost,
  )
  return { observation, observerHost }
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('grok current-authority lookup lifecycle', () => {
  beforeEach(() => {
    mocked.locate.mockReset()
    mocked.starts.length = 0
  })

  it('fences a deferred lookup across clear and coalesces overlapping ticks', async () => {
    const pending = deferred<string | null>()
    mocked.locate.mockReturnValue(pending.promise)
    const statTick = new ManualStatTick()
    const { observation, observerHost } = start(statTick)

    for (const watcher of statTick.watchers) {
      watcher()
      watcher()
    }
    expect(mocked.locate).toHaveBeenCalledTimes(1)

    observation.stop()
    pending.resolve('/isolated-state/transcripts/project/session-a.jsonl')
    await settle()
    expect(observerHost.tailFile).toHaveBeenCalledTimes(1)
    expect(statTick.watchers.size).toBe(0)
  })

  it('fences the replaced session and resolves the replacement only once', async () => {
    const pendingA = deferred<string | null>()
    const pendingB = deferred<string | null>()
    mocked.locate.mockReturnValueOnce(pendingA.promise).mockReturnValueOnce(pendingB.promise)
    const statTick = new ManualStatTick()
    const { observation, observerHost } = start(statTick)
    const first = mocked.starts[0]
    if (!first) throw new Error('first Grok observer missing')
    expect(first.opts.onSessionCandidate('session-b')).toBe(false)
    const request = vi.mocked(observerHost.onExactProviderRebind).mock.calls[0]?.[0]
    if (!request) throw new Error('Grok rebind request missing')

    const ack: AgentObservationRebindAckMessage = {
      type: 'agentObservationRebindAck',
      sessionId: asSessionId('podium-grok'),
      provider: 'grok',
      rebindId: request.rebindId,
      priorObserverGeneration: 1,
      priorBindingVersion: 1,
      nextProviderSessionId: 'session-b',
      providerSessionId: 'session-b',
      result: 'accepted',
      observerGeneration: 2,
      bindingVersion: 2,
      checkpoint: null,
    }
    observation.onProviderRebindAck?.(ack)
    expect(mocked.locate).toHaveBeenCalledTimes(2)

    pendingA.resolve('/isolated-state/transcripts/project/session-a.jsonl')
    await settle()
    expect(observerHost.tailFile).not.toHaveBeenCalledWith(
      '/isolated-state/transcripts/project/session-a.jsonl',
    )

    for (const watcher of statTick.watchers) {
      watcher()
      watcher()
    }
    expect(mocked.locate).toHaveBeenCalledTimes(2)

    pendingB.resolve('/isolated-state/transcripts/project/session-b.jsonl')
    await settle()
    expect(observerHost.tailFile).toHaveBeenCalledTimes(3)
    expect(observerHost.tailFile).toHaveBeenLastCalledWith(
      '/isolated-state/transcripts/project/session-b.jsonl',
    )
    for (const watcher of statTick.watchers) watcher()
    expect(mocked.locate).toHaveBeenCalledTimes(2)
  })
})

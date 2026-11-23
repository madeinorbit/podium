import { ContextSummary, invalidateContextSummary } from '@podium/model'
import type { CausalEnvelope } from '@podium/protocol/daemon'
import { describe, expect, it } from 'vitest'
import type {
  ContextObservation,
  ContextStrategyInput,
  HarnessContextStrategy,
} from './context-types'

const revision = { bindingVersion: 1, observerGeneration: 1, contextRevision: 1, turnEpoch: 0 }
const causal: CausalEnvelope = {
  at: '2026-11-21T12:00:00.000Z',
  provenance: 'live',
  observerGeneration: 1,
  turnEpoch: 0,
  cursor: { segmentId: 'synthetic', components: { seq: 1 } },
}
const summary = ContextSummary.parse({
  version: 1,
  status: 'available',
  sample: { ...revision, id: 'synthetic-request', at: causal.at },
  occupancy: {
    basis: 'native-estimate',
    usedTokens: { value: 647, accuracy: 'estimated', source: 'synthetic adapter' },
  },
})

/** A synthetic adapter, not family event selection: it decides which raw event
 * triggers async native work and owns cancellation/coalescing after boundaries. */
function strategyFixture(): HarnessContextStrategy {
  return {
    capability: { summary: 'passive-and-explicit', detail: 'none' },
    probe: async () => ({ status: 'available' }),
    bind(input) {
      let currentRevision = input.revision
      let current: ContextObservation | undefined
      let pending: AbortController | undefined
      return {
        observe(payload, envelope) {
          if (payload !== 'synthetic-native-boundary' || !input.probe) return undefined
          pending?.abort()
          pending = new AbortController()
          const signal = AbortSignal.any([input.signal, pending.signal])
          const capturedRevision = currentRevision
          void input.probe
            .request({ operation: 'synthetic-summary' }, { timeoutMs: 500, signal })
            .then((raw) => {
              if (signal.aborted || capturedRevision !== currentRevision) return
              current = { ...envelope, context: ContextSummary.parse(raw) }
              input.publish(current)
            })
          return undefined
        },
        invalidate(cause, envelope) {
          pending?.abort()
          currentRevision = {
            ...currentRevision,
            contextRevision: currentRevision.contextRevision + 1,
          }
          current = {
            ...envelope,
            context: invalidateContextSummary(current?.context, cause, currentRevision),
          }
          return current
        },
        async summary() {
          return current
            ? { status: 'observation', observation: current }
            : {
                status: 'refused',
                reason: { code: 'waiting', message: 'No causal native reading yet' },
              }
        },
        async detail(request) {
          return {
            version: 1,
            sample: request.sample,
            status: 'unsupported',
            reason: { code: 'no-detail', message: 'This synthetic adapter exposes only summary' },
          }
        },
      }
    },
  }
}

function probeFixture(publish: ContextStrategyInput['publish']) {
  let resolve: (value: unknown) => void = () => {
    throw new Error('Probe promise not initialized')
  }
  const response = new Promise<unknown>((done) => {
    resolve = done
  })
  const lifetime = new AbortController()
  const requests: { operation: unknown; signal?: AbortSignal }[] = []
  const bound = strategyFixture().bind({
    harness: 'synthetic',
    driver: 'fake',
    revision,
    signal: lifetime.signal,
    publish,
    probe: {
      request: async (operation, options) => {
        requests.push({ operation, signal: options.signal })
        return response
      },
    },
  })
  return { bound, requests, lifetime, resolve, response }
}

describe('adapter-owned asynchronous context publication', () => {
  it('publishes after a native boundary probe without any summary hover or family selection', async () => {
    let publish: (value: ContextObservation) => void = () => {
      throw new Error('Publication promise not initialized')
    }
    const observation = new Promise<ContextObservation>((done) => {
      publish = done
    })
    const probe = probeFixture(publish)
    expect(probe.bound.observe('unrelated', causal)).toBeUndefined()
    expect(probe.requests).toHaveLength(0)
    expect(probe.bound.observe('synthetic-native-boundary', causal)).toBeUndefined()
    expect(probe.requests).toHaveLength(1)
    probe.resolve(summary)
    expect(await observation).toEqual({ ...causal, context: summary })
  })
  it.each([
    'compaction',
    'dispose',
  ] as const)('discards an asynchronous reading after %s', async (boundary) => {
    const published: ContextObservation[] = []
    const probe = probeFixture((value) => {
      published.push(value)
    })
    probe.bound.observe('synthetic-native-boundary', causal)
    if (boundary === 'compaction')
      expect(probe.bound.invalidate('compaction', causal).context).toMatchObject({
        status: 'pending',
        revision: { contextRevision: 2 },
      })
    else probe.lifetime.abort()
    expect(probe.requests[0]?.signal?.aborted).toBe(true)
    probe.resolve(summary)
    await probe.response
    await Promise.resolve()
    expect(published).toEqual([])
  })
})

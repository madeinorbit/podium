/** Invented native protocol for generic delivery tests; no production harness fields. */
import {
  type ContextInvalidationCause,
  ContextSummary,
  invalidateContextSummary,
} from '@podium/model'
import type { CausalEnvelope } from '@podium/protocol/daemon'
import { fixtureManifest } from '../../adapters/fixture/index.js'
import type {
  ContextObservation,
  ContextStrategyInput,
  HarnessContextStrategy,
} from '../../context-types.js'
import { supported } from '../../manifest.js'
import { registerTestManifest } from '../../registry.js'

export const contextFixtureAt = '2026-11-21T12:00:00.000Z'
export const contextFixtureCausal = (seq: number, generation = 1): CausalEnvelope => ({
  at: contextFixtureAt,
  provenance: 'live',
  cursor: { segmentId: 'invented-context-source', components: { seq } },
  observerGeneration: generation,
  turnEpoch: 0,
})
export function installContextFixture() {
  const bindings: ContextStrategyInput[] = []
  const requests: unknown[] = []
  const strategy: HarnessContextStrategy = {
    capability: { summary: 'passive-and-explicit', detail: 'on-demand' },
    probe: async () => ({ status: 'available' }),
    bind(input) {
      bindings.push(input)
      let revision = input.revision
      let current: ContextObservation | undefined
      return {
        observe(payload, causal) {
          const native = payload as {
            id?: string
            nativeSessionId?: string
            percent?: number
            at?: string
            boundary?: ContextInvalidationCause
            crash?: boolean
          }
          if (native.crash) throw new Error('Invented telemetry decoder failure')
          if (
            native.nativeSessionId !== undefined &&
            native.nativeSessionId !== input.nativeSessionId
          )
            return undefined
          if (native.boundary) return this.invalidate(native.boundary, causal)
          if (!native.id || native.percent === undefined) return undefined
          current = {
            ...causal,
            at: native.at ?? causal.at,
            context: ContextSummary.parse({
              version: 1,
              status: 'available',
              sample: {
                ...revision,
                turnEpoch: causal.turnEpoch,
                id: native.id,
                at: native.at ?? causal.at,
                nativeSessionId: input.nativeSessionId,
              },
              model: { modelId: 'invented-native-model' },
              occupancy: {
                basis: 'current-context',
                percent: {
                  value: native.percent,
                  accuracy: 'reported',
                  source: 'invented native protocol',
                },
              },
            }),
          }
          return current
        },
        invalidate(cause, causal) {
          revision = {
            ...revision,
            turnEpoch: causal.turnEpoch,
            contextRevision: revision.contextRevision + 1,
          }
          current = {
            ...causal,
            context: invalidateContextSummary(current?.context, cause, revision),
          }
          return current
        },
        async summary(options) {
          if (!current && input.probe) {
            requests.push('invented-summary')
            const raw = await input.probe.request('invented-summary', options)
            if (raw) current = raw as ContextObservation
          }
          return current
            ? { status: 'observation', observation: current }
            : {
                status: 'refused',
                reason: { code: 'waiting', message: 'No attributable invented sample' },
              }
        },
        async detail(request) {
          return {
            version: 1,
            status: 'unsupported',
            sample: request.sample,
            reason: { code: 'no-detail', message: 'The invented transport has no detail' },
          }
        },
      }
    },
  }
  const release = registerTestManifest({
    ...fixtureManifest,
    runtime: { ...fixtureManifest.runtime, context: { forDriver: () => supported(strategy) } },
  })
  return { bindings, requests, release }
}

import { randomUUID } from 'node:crypto'
import { request } from 'node:http'
import { asSessionId, ContextSummary } from '@podium/model'
import { describe, expect, it } from 'vitest'
import type { ContextObservation } from '../../context-types.js'
import { startHookIngest } from '../../driver/families/terminal/instrumentation.js'
import fixtures from './__fixtures__/context-observations.json' with { type: 'json' }
import { piContext } from './context.js'
import { piContextExtensionSource } from './context-extension.js'

type Handler = (event: unknown, context: unknown) => Promise<void>

describe('Pi extension through the existing callback transport', () => {
  it('publishes a committed response to the adapter, unregisters on shutdown and closes its listener', async () => {
    const terminal = fixtures.terminal as Record<string, unknown>[]
    const response = terminal.find((row) => row.event === 'turn_end')
    if (!response) throw new Error('missing captured response')
    const lifetime = new AbortController()
    const declaration = piContext.forDriver('generic-pty')
    if (!declaration.supported) throw new Error(declaration.reason)
    const bound = declaration.value.bind({
      harness: 'pi',
      driver: 'generic-pty',
      nativeSessionId: String(response.sessionId),
      revision: { bindingVersion: 1, observerGeneration: 1, turnEpoch: 0, contextRevision: 0 },
      signal: lifetime.signal,
      publish: () => {},
    })
    const observations: ContextObservation[] = []
    let sequence = 0
    const ingest = await startHookIngest({
      port: 0,
      onPayload(sessionId, payload) {
        expect(sessionId).toBe('invented-pi-row')
        const result = bound.observe(payload, {
          at: new Date().toISOString(),
          cursor: { segmentId: 'callback', components: { seq: ++sequence } },
          provenance: 'live',
          observerGeneration: 1,
          turnEpoch: 0,
        })
        if (result) {
          ContextSummary.parse(result.context)
          observations.push(result)
        }
      },
    })
    const handlers = new Map<string, Handler>()
    try {
      const source = piContextExtensionSource(
        ingest.endpointFor(asSessionId('invented-pi-row')),
        '1.5.0',
      )
        .replace(/^import .*\n/gm, '')
        .replace('export default function', 'return function')
      const initialize = new Function('request', 'randomUUID', source)(request, randomUUID)
      initialize({
        on(name: string, handler: Handler) {
          handlers.set(name, handler)
          return () => handlers.delete(name)
        },
      })
      const anchor: Record<string, unknown> = {
        ...(response.anchor as Record<string, unknown>),
        timestamp: Date.now() + 10,
      }
      let branch: unknown[] = []
      const ctx = {
        model: response.model,
        getContextUsage: () => response.contextUsage,
        sessionManager: {
          getSessionId: () => response.sessionId,
          getLeafId: () => response.leafId,
          getBranch: () => branch,
        },
      }
      async function emit(type: string, extra = {}) {
        const handler = handlers.get(type)
        if (!handler) throw new Error(`missing ${type} handler`)
        await handler({ type, ...extra }, ctx)
      }
      await emit('session_start', { reason: 'startup' })
      await emit('message_start', { message: { ...anchor, stopReason: 'pending' } })
      await emit('message_end', { message: anchor })
      expect(observations.every((row) => row.context.status === 'pending')).toBe(true)
      branch = [{ type: 'message', id: anchor.id, message: anchor }]
      await emit('turn_end', { message: anchor })
      expect(observations.at(-1)?.context).toMatchObject({
        status: 'available',
        occupancy: { usedTokens: { value: 1320 }, percent: { value: 8.25 } },
      })
      await emit('agent_settled')
      expect(observations.filter((row) => row.context.status === 'available')).toHaveLength(1)
      await emit('session_shutdown')
      expect(handlers.size).toBe(0)
    } finally {
      lifetime.abort()
      await ingest.close()
    }
    expect(await bound.summary({ timeoutMs: 100 })).toMatchObject({ status: 'cancelled' })
  })
})

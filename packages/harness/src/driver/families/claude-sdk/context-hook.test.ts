import { describe, expect, it } from 'vitest'
import fixtures from '../../../adapters/claude-code/__fixtures__/context-reports.json' with {
  type: 'json',
}
import { claudeContext } from '../../../adapters/claude-code/context.js'
import type { ContextObservation } from '../../../context-types.js'
import { type ClaudeStreamTransport, createClaudeStreamClient } from './protocol.js'

function transport() {
  const writes: Record<string, unknown>[] = []
  let listener: (line: string) => void = () => {}
  let exited: (code: number, signal: null) => void = () => {}
  return {
    writes,
    emit(value: unknown) {
      listener(JSON.stringify(value))
    },
    exit() {
      exited(0, null)
    },
    port: {
      writeLine(line) {
        writes.push(JSON.parse(line))
      },
      onLine(cb) {
        listener = cb
        return () => {
          listener = () => {}
        }
      },
      onExit(cb) {
        exited = cb
        return () => {}
      },
      close() {},
    } satisfies ClaudeStreamTransport,
  }
}
const tick = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

describe('Claude adapter through the actual stream-client hook', () => {
  it('publishes using raw lifecycle and the existing opaque control channel, with no turn or full read', async () => {
    const fake = transport()
    const declaration = claudeContext.forDriver('claude-sdk')
    if (!declaration.supported) throw new Error(declaration.reason)
    const lifetime = new AbortController()
    const published: ContextObservation[] = []
    let seq = 0
    const bound = declaration.value.bind({
      harness: 'claude-code',
      driver: 'claude-sdk',
      nativeSessionId: 'native',
      revision: { bindingVersion: 1, observerGeneration: 1, turnEpoch: 0, contextRevision: 0 },
      signal: lifetime.signal,
      publish: (value) => published.push(value),
      probe: { request: (operation, options) => client.request(operation, options) },
    })
    const client = createClaudeStreamClient(fake.port, {
      sessionId: 'native',
      onNativePayload(raw) {
        bound.observe(raw, {
          at: '2026-11-21T12:00:00.000Z',
          provenance: 'live',
          observerGeneration: 1,
          turnEpoch: 0,
          cursor: { segmentId: 'native', components: { seq: ++seq } },
        })
      },
    })
    const init = fake.writes[0]!
    fake.emit({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: init.request_id,
        response: { claude_code_version: '2.1.319' },
      },
    })
    await tick()
    expect(fake.writes).toHaveLength(2)
    const request = fake.writes[1]!
    expect(request).toMatchObject({ type: 'control_request', request: { detail: 'summary' } })
    fake.emit({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: request.request_id,
        response: fixtures.control['engine-2.1.319/after-2-summary'],
      },
    })
    await tick()
    expect(published).toHaveLength(1)
    const summary = published[0]!.context
    if (summary.status !== 'available') throw new Error('expected summary')
    const detail = await bound.detail({ sample: summary.sample, maxRows: 128, timeoutMs: 500 })
    expect(detail.status).toBe('available')
    expect(fake.writes).toHaveLength(2)
    expect(fake.writes.some((value) => value.type === 'user')).toBe(false)
    lifetime.abort()
    client.close()
  })
  it('bounds opaque requests including handshake delay, cancellation and late replies', async () => {
    const fake = transport()
    const client = createClaudeStreamClient(fake.port, { sessionId: 'native' })
    await expect(client.request({ synthetic: 'read' }, { timeoutMs: 5 })).rejects.toThrow(
      'timed out',
    )
    const init = fake.writes[0]!
    fake.emit({
      type: 'control_response',
      response: { subtype: 'success', request_id: init.request_id, response: {} },
    })
    await tick()
    expect(fake.writes).toHaveLength(1)
    const abort = new AbortController()
    const pending = client.request({ synthetic: 'read' }, { timeoutMs: 500, signal: abort.signal })
    await tick()
    abort.abort()
    await expect(pending).rejects.toThrow('cancelled')
    const request = fake.writes.at(-1)!
    fake.emit({
      type: 'control_response',
      response: { subtype: 'success', request_id: request.request_id, response: { ignored: true } },
    })
    const exiting = client.request({ synthetic: 'read' }, { timeoutMs: 500 })
    await tick()
    fake.exit()
    await expect(exiting).rejects.toThrow('exited')
    await expect(client.request({}, { timeoutMs: 500 })).rejects.toThrow('closed')
    client.close()
  })
})

import { EventEmitter } from 'node:events'
import { asSessionId } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import { testHarnessContext } from '../../driver/testing/harness-context.js'
import type { InstrumentationDestination } from '../../manifest.js'
import { piContextExtensionSource } from './context-extension.js'
import { installPiContext, piInstrumentation } from './instrumentation.js'

function destination(version = '1.5.0'): InstrumentationDestination {
  return {
    sessionId: asSessionId('invented-session'),
    endpointUrl: 'http://127.0.0.1:1/hooks/invented-session',
    settingsDir: '/owned/settings',
    harnessContext: testHarnessContext({ kind: 'pi', version }),
  }
}
type Handler = (event: Record<string, unknown>, context: unknown) => Promise<void>
function extension() {
  const posted: Record<string, unknown>[] = []
  const request = vi.fn(() => {
    const req = new EventEmitter() as EventEmitter & { end(value: string): void; destroy(): void }
    req.end = (value) => {
      posted.push(JSON.parse(value))
      queueMicrotask(() => req.emit('close'))
    }
    req.destroy = () => req.emit('close')
    return req
  })
  const handlers = new Map<string, Handler>()
  const source = piContextExtensionSource(destination().endpointUrl, '1.5.0')
    .replace(/^import .*\n/gm, '')
    .replace('export default function', 'return function')
  const initialize = new Function('request', 'randomUUID', source)(request, () => 'invented-run')
  const dispose = vi.fn((name: string) => handlers.delete(name))
  initialize({
    on: (name: string, handler: Handler) => {
      handlers.set(name, handler)
      return () => dispose(name)
    },
  })
  const handler = (name: string) => {
    const value = handlers.get(name)
    if (!value) throw new Error(`missing handler: ${name}`)
    return value
  }
  return { handlers, handler, dispose, posted, request }
}

describe('Pi session extension installation', () => {
  it('produces only a launch-scoped file and explicit extension arg on the admitted version', async () => {
    const result = await piInstrumentation.install(destination())
    expect(piInstrumentation.scope).toEqual({ kind: 'session' })
    expect(piInstrumentation.driverIds).toEqual(['generic-pty', 'headless'])
    expect(piInstrumentation.hookTransport).toBe('loopback-http')
    expect(result.args).toEqual(['-e', '/owned/settings/invented-session.pi-context.mjs'])
    expect(result.file?.contents).toContain('ctx.getContextUsage()')
    expect(result.file?.contents).not.toMatch(/process\.stdout|console\./)
    expect(result.env).toBeUndefined()
  })
  it('never loads an explicit extension when print policy prohibits extensions', async () => {
    expect(await installPiContext({ ...destination(), extensionsAllowed: false })).toEqual({
      args: [],
    })
  })
  it.each([
    '',
    '0.84.4',
    '1.1.0',
    '1.5.1',
    '2.0.0',
  ])('does not promise the API on unverified Pi %s', async (version) => {
    expect(await piInstrumentation.install(destination(version))).toMatchObject({
      args: [],
      degradedKind: 'unsupported-version',
    })
  })
  it('refuses destinations outside the existing loopback observation transport', () => {
    expect(() => piContextExtensionSource('https://example.com/', '1.5.0')).toThrow('loopback')
  })
})

describe('Pi extension event witnesses and disposal', () => {
  it('sends only context/identity/accounting, follows the branch, and unregisters on shutdown', async () => {
    const h = extension()
    const ctx = {
      model: { id: 'invented-model', provider: 'invented-provider', privateKey: 'exclude' },
      getContextUsage: () => ({ tokens: null, contextWindow: 16000, percent: null }),
      sessionManager: {
        getSessionId: () => 'invented-native',
        getLeafId: () => 'leaf-after-compaction',
        getBranch: () => [
          {
            type: 'message',
            id: 'old',
            message: { role: 'assistant', content: ['exclude'], usage: { input: 2110 } },
          },
          { type: 'compaction', id: 'compact' },
        ],
      },
    }
    await h.handler('session_start')({ type: 'session_start', reason: 'startup' }, ctx)
    expect(h.posted).toHaveLength(1)
    expect(h.posted[0]).toMatchObject({
      schema: 'podium.pi-context.v1',
      piVersion: '1.5.0',
      sequence: 1,
      runId: 'invented-run',
      sessionId: 'invented-native',
      compactionId: 'compact',
      contextUsage: { tokens: null, contextWindow: 16000, percent: null },
      model: { id: 'invented-model', provider: 'invented-provider' },
    })
    expect(h.posted[0]).not.toHaveProperty('anchor')
    expect(JSON.stringify(h.posted)).not.toContain('exclude')
    const saved = h.handler('message_end')
    const count = h.handlers.size
    await h.handler('session_shutdown')({ type: 'session_shutdown' }, ctx)
    expect(h.handlers.size).toBe(0)
    expect(h.dispose).toHaveBeenCalledTimes(count)
    await saved({ type: 'message_end' }, ctx)
    expect(h.posted).toHaveLength(2)
    expect(h.request).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ agent: false }),
      expect.any(Function),
    )
  })
  it('keeps error/aborted responses out of the latest valid anchor', async () => {
    const h = extension()
    await h.handler('turn_end')(
      { type: 'turn_end' },
      {
        model: { id: 'model', provider: 'provider' },
        getContextUsage: () => undefined,
        sessionManager: {
          getSessionId: () => 'session',
          getLeafId: () => 'failed',
          getBranch: () => [
            {
              type: 'message',
              id: 'valid',
              message: {
                role: 'assistant',
                model: 'model',
                provider: 'provider',
                stopReason: 'stop',
                content: ['exclude'],
                usage: { input: 1, output: 2 },
              },
            },
            { type: 'message', id: 'failed', message: { role: 'assistant', stopReason: 'error' } },
          ],
        },
      },
    )
    expect(h.posted[0]).toMatchObject({
      contextUsage: null,
      anchor: { id: 'valid', model: 'model', provider: 'provider', usage: { input: 1, output: 2 } },
    })
    expect(JSON.stringify(h.posted)).not.toContain('exclude')
  })
  it('keeps lifecycle state decoding poll-only and exposes native session association', async () => {
    const raw = { schema: 'podium.pi-context.v1', sessionId: 'invented-native' }
    expect(piInstrumentation.payloadCodec.eventName(raw)).toBe('PodiumPiContext')
    expect(piInstrumentation.payloadCodec.sessionId(raw)).toBe('invented-native')
    expect(piInstrumentation.payloadCodec.transcriptPath(raw)).toBeUndefined()
    expect(
      await piInstrumentation.payloadCodec.decode(raw, {
        home: '/invented',
        env: {},
        roots: { state: '/invented' },
      }),
    ).toEqual([])
  })
})

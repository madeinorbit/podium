import { describe, expect, expectTypeOf, it } from 'vitest'
import { createDispatcher, type DispatchHandlers } from './dispatch'

type Ping = { type: 'ping'; nonce: number }
type Say = { type: 'say'; text: string }
type Close = { type: 'close' }
type Msg = Ping | Say | Close

describe('createDispatcher', () => {
  it('routes each message to its handler with the narrowed type', async () => {
    const seen: string[] = []
    const dispatch = createDispatcher<Msg>({
      ping: (msg) => {
        expectTypeOf(msg).toEqualTypeOf<Ping>()
        seen.push(`ping:${msg.nonce}`)
      },
      say: async (msg) => {
        expectTypeOf(msg).toEqualTypeOf<Say>()
        seen.push(`say:${msg.text}`)
      },
      close: () => {
        seen.push('close')
      },
    })
    await dispatch({ type: 'ping', nonce: 7 }, undefined)
    await dispatch({ type: 'say', text: 'hi' }, undefined)
    await dispatch({ type: 'close' }, undefined)
    expect(seen).toEqual(['ping:7', 'say:hi', 'close'])
  })

  it('threads the context through to every handler', () => {
    type Ctx = { log: string[] }
    const dispatch = createDispatcher<Msg, Ctx>({
      ping: (msg, ctx) => {
        ctx.log.push(`ping:${msg.nonce}`)
      },
      say: (msg, ctx) => {
        ctx.log.push(`say:${msg.text}`)
      },
      close: (_msg, ctx) => {
        ctx.log.push('close')
      },
    })
    const ctx: Ctx = { log: [] }
    dispatch({ type: 'say', text: 'yo' }, ctx)
    dispatch({ type: 'ping', nonce: 1 }, ctx)
    expect(ctx.log).toEqual(['say:yo', 'ping:1'])
  })

  it('propagates async handler results (awaitable dispatch)', async () => {
    const dispatch = createDispatcher<Msg>({
      ping: async () => {
        await Promise.resolve()
      },
      say: () => {},
      close: () => {},
    })
    await expect(dispatch({ type: 'ping', nonce: 1 }, undefined)).resolves.toBeUndefined()
  })

  it('throws a descriptive error on an unknown type (zod upstream normally prevents this)', () => {
    const dispatch = createDispatcher<Msg>({ ping: () => {}, say: () => {}, close: () => {} })
    expect(() => dispatch({ type: 'evil' } as unknown as Msg, undefined)).toThrow(
      /no handler for message type 'evil'/,
    )
  })

  it('is total over the union (type-level): a missing member is a compile error', () => {
    // @ts-expect-error 'close' lacks a handler — the mapped type is total over M['type']
    createDispatcher<Msg>({ ping: () => {}, say: () => {} })
    const _extra: DispatchHandlers<Msg> = {
      ping: () => {},
      say: () => {},
      close: () => {},
      // @ts-expect-error handlers for types outside the union are rejected
      bogus: () => {},
    }
    expect(true).toBe(true)
  })
})

describe('widened discriminant rejection (Codex round-2)', () => {
  it('a bare { type: string } union does not compile', () => {
    // @ts-expect-error — exhaustiveness would silently collapse to an index signature
    createDispatcher<{ type: string }>({})
    expect(true).toBe(true)
  })
})

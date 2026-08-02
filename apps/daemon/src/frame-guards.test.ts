import type { ControlMessage } from '@podium/protocol'
import { describe, expect, it, vi } from 'vitest'
import type { DaemonContext } from './control/context'
import {
  controlFrameByteLength,
  createFrameGuard,
  MAX_CONTROL_FRAME_BYTES,
} from './frame-guards'

const context = (): DaemonContext =>
  ({
    agentRelayHub: { onResult: vi.fn() },
  }) as unknown as DaemonContext

describe('daemon frame guards', () => {
  it('measures every ws RawData representation without stringifying it', () => {
    expect(controlFrameByteLength(Buffer.from('hello'))).toBe(5)
    expect(controlFrameByteLength([Buffer.from('he'), Buffer.from('llo')])).toBe(5)
    expect(controlFrameByteLength(new Uint8Array([1, 2, 3]).buffer)).toBe(3)
  })

  it('drops and reports an oversized frame before parsing', () => {
    const warn = vi.fn()
    const guard = createFrameGuard(context(), { warn })
    guard.receive(Buffer.alloc(MAX_CONTROL_FRAME_BYTES + 1))
    expect(warn).toHaveBeenCalledWith('[podium:daemon] dropping oversized control frame')
  })

  it('tolerates the benign malformed reattach frame and keeps dispatching', () => {
    const onResult = vi.fn()
    const ctx = context()
    ctx.agentRelayHub.onResult = onResult
    const warn = vi.fn()
    let at = 1_000
    const guard = createFrameGuard(ctx, { warn, now: () => at })

    guard.receive(Buffer.from('{not-json'))
    at += 10
    guard.receive(Buffer.from('{still-not-json'))
    const valid: ControlMessage = {
      type: 'agentRelayResult',
      requestId: 'req-1',
      ok: true,
      result: null,
    }
    guard.receive(Buffer.from(JSON.stringify(valid)))

    expect(warn).toHaveBeenCalledTimes(1)
    expect(onResult).toHaveBeenCalledWith(valid)
  })

  it('contains outbound encoding/socket throws', () => {
    const warn = vi.fn()
    const guard = createFrameGuard(context(), { warn })
    const send = vi.fn(() => {
      throw new Error('closing')
    })
    guard.send({ readyState: 1, send } as never, { type: 'inventoryReport', inventory: { agents: [], tools: [] } })
    expect(warn).toHaveBeenCalledWith(
      '[podium:daemon] dropped malformed outbound control frame:',
      expect.any(Error),
    )
  })
})

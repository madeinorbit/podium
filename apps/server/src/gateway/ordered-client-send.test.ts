import { describe, expect, it, vi } from 'vitest'
import { BootstrapZstdMetadata, decodeBinaryEnvelope } from '@podium/protocol'
import { decodeBootstrapZstd } from '../../../../packages/client-core/src/socket-transport/bootstrap-zstd'
import {
  BootstrapCompressionBudget,
  OrderedClientSend,
  compressBootstrap,
} from './ordered-client-send'
import type { SendSocket } from './ws-send'

const limits = { sendBufferLimitBytes: 1024 * 1024, lossySendBufferLimitBytes: 256 * 1024 }
const bootstrap = (seq = 1) => ({
  type: 'feedBootstrap' as const,
  feedId: 'feed',
  epoch: 'epoch',
  fromSeq: 0,
  seq,
  minAvailableSeq: 0,
  changes: [],
  last: true,
})
function setup(
  compress = compressBootstrap,
  budget = new BootstrapCompressionBudget(),
  maxBytes?: number,
) {
  const sent: Array<{ data: string | Uint8Array; compress: boolean | undefined }> = []
  const ws: SendSocket = {
    readyState: 1,
    bufferedAmount: 0,
    send: (data, compress) => sent.push({ data, compress }),
    sendBinary: (data, compress) => sent.push({ data, compress }),
    terminate: vi.fn(),
  }
  const sink = new OrderedClientSend(ws, limits, compress, budget, maxBytes)
  sink.enableBootstrapCompression(true)
  return { sink, sent, ws, budget }
}
const tick = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

describe('ordered bootstrap compression', () => {
  it('roundtrips native Zstd through the portable client decoder with deflate disabled', async () => {
    const { sink, sent, budget } = setup()
    sink.send(bootstrap())
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    const frame = sent[0]!
    expect(frame.compress).toBe(false)
    expect(frame.data).toBeInstanceOf(Uint8Array)
    const decoded = decodeBinaryEnvelope(frame.data as Uint8Array, BootstrapZstdMetadata)
    expect(
      JSON.parse(
        decodeBootstrapZstd({
          payload: decoded.payload,
          uncompressedBytes: decoded.metadata.uncompressedBytes,
        }),
      ),
    ).toEqual(bootstrap())
    expect(budget.bytes).toBe(0)
  })

  it('roundtrips multi-block compressed Unicode payloads', async () => {
    const json = JSON.stringify({ text: 'bootstrap café 東京 '.repeat(30000) })
    const payload = await compressBootstrap(json)
    expect(payload.byteLength).toBeLessThan(Buffer.byteLength(json) / 10)
    expect(decodeBootstrapZstd({ payload, uncompressedBytes: Buffer.byteLength(json) })).toBe(json)
  })

  it('holds later text, binary and bootstrap chunks behind the active chunk', async () => {
    const resolvers: Array<(bytes: Uint8Array) => void> = []
    const compress = vi.fn(() => new Promise<Uint8Array>((resolve) => resolvers.push(resolve)))
    const { sink, sent } = setup(compress)
    sink.send(bootstrap(1))
    sink.send({ type: 'welcome', clientId: 'later' })
    const source = Uint8Array.of(17)
    sink.sendBinary(source)
    source[0] = 99
    sink.send(bootstrap(2))
    await tick()
    expect(compress).toHaveBeenCalledTimes(1)
    expect(sent).toEqual([])
    resolvers[0]!(Uint8Array.of(1))
    await tick()
    expect(sent).toHaveLength(3)
    expect(JSON.parse(sent[1]!.data as string).type).toBe('welcome')
    expect(sent[2]!.data).toEqual(Uint8Array.of(17))
    expect(compress).toHaveBeenCalledTimes(2)
    resolvers[1]!(Uint8Array.of(2))
    await tick()
    expect(sent).toHaveLength(4)
  })

  it('falls back in place on compression failure and keeps capless peers synchronous', async () => {
    const { sink, sent } = setup(async () => {
      throw new Error('worker unavailable')
    })
    sink.send(bootstrap())
    sink.send({ type: 'welcome', clientId: 'later' })
    await tick()
    expect(sent.map((frame) => JSON.parse(frame.data as string).type)).toEqual([
      'feedBootstrap',
      'welcome',
    ])
    expect(sent[0]!.compress).toBe(false)
    sink.enableBootstrapCompression(false)
    sink.send(bootstrap(2))
    expect(sent).toHaveLength(3)
    expect(sent[2]!.compress).toBe(false)
  })

  it('bounds concurrency across sockets and cancels waiting work on close', async () => {
    const budget = new BootstrapCompressionBudget(4096, 1)
    let finish!: (bytes: Uint8Array) => void
    const compress = vi.fn(
      () =>
        new Promise<Uint8Array>((resolve) => {
          finish = resolve
        }),
    )
    const a = setup(compress, budget)
    const b = setup(compress, budget)
    a.sink.send(bootstrap())
    b.sink.send(bootstrap())
    await tick()
    expect(compress).toHaveBeenCalledTimes(1)
    b.sink.dispose()
    a.sink.dispose()
    await tick()
    expect(budget.bytes).toBeGreaterThan(0) // native input still held
    finish(Uint8Array.of(1))
    await tick()
    expect(compress).toHaveBeenCalledTimes(1)
    expect(a.sent).toEqual([])
    expect(b.sent).toEqual([])
    expect(budget.bytes).toBe(0)
  })

  it('terminates on queued input limits and drops lossy frames without terminating', async () => {
    let finish!: (bytes: Uint8Array) => void
    const { sink, ws, budget } = setup(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
      undefined,
      1024,
    )
    sink.send(bootstrap())
    await tick()
    expect(sink.sendBinaryLossy(new Uint8Array(300 * 1024))).toBe(false)
    expect(ws.terminate).not.toHaveBeenCalled()
    sink.sendBinary(new Uint8Array(1024))
    expect(ws.terminate).toHaveBeenCalledOnce()
    finish(Uint8Array.of(1))
    await tick()
    expect(budget.bytes).toBe(0)
  })

  it('reports immediate lossy send failures and rechecks the stream budget at drain', async () => {
    const immediate = setup()
    immediate.ws.send = () => {
      throw new Error('socket closing')
    }
    expect(immediate.sink.sendLossy({ type: 'welcome', clientId: 'stream' })).toBe(false)
    expect(immediate.ws.terminate).not.toHaveBeenCalled()
    let finish!: (bytes: Uint8Array) => void
    const { sink, ws, sent } = setup(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    sink.send(bootstrap())
    expect(sink.sendBinaryLossy(Uint8Array.of(1))).toBe(true)
    await tick()
    ws.bufferedAmount = limits.lossySendBufferLimitBytes + 1
    finish(Uint8Array.of(1))
    await tick()
    expect(sent).toHaveLength(1) // reliable bootstrap sent; stream dropped
    expect(ws.terminate).not.toHaveBeenCalled()
  })

  it('enforces the shared byte budget and rechecks socket pressure before sending', async () => {
    const tooSmall = setup(compressBootstrap, new BootstrapCompressionBudget(1))
    tooSmall.sink.send(bootstrap())
    expect(tooSmall.ws.terminate).toHaveBeenCalledOnce()
    let finish!: (bytes: Uint8Array) => void
    const { sink, ws, sent } = setup(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    sink.send(bootstrap())
    await tick()
    ws.bufferedAmount = limits.sendBufferLimitBytes + 1
    finish(Uint8Array.of(1))
    await tick()
    expect(ws.terminate).toHaveBeenCalledOnce()
    expect(sent).toEqual([])
  })
})

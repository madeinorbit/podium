import { createLogger } from '@podium/logger'
import { BOOTSTRAP_ZSTD_MAX_BYTES, encodeBinaryEnvelope } from '@podium/protocol'
import { encodeDaemonMessage } from '@podium/protocol/daemon'
import type { PlaneSink } from './plane-liveness'
import { type SendSocket, shouldCompressWebSocketFrame } from './ws-send'

const log = createLogger('server:gateway')
type Compressor = (json: string) => Promise<Uint8Array>

/** Bun 1.3.14 JSZstd.ZstdJob dispatches with jsc.WorkPool.schedule;
 * serialization stays on this loop. See src/runtime/api/BunObject.zig in Bun. */
export const compressBootstrap: Compressor = (json) => {
  const runtime = globalThis as typeof globalThis & {
    Bun: { zstdCompress(input: string, options: { level: number }): Promise<Uint8Array> }
  }
  return runtime.Bun.zstdCompress(json, { level: 3 })
}

/** One shared admission budget, including input still owned by an active native job. */
export class BootstrapCompressionBudget {
  bytes = 0
  private active = 0
  private readonly waiting = new Set<() => void>()
  constructor(
    readonly maxBytes = 256 * 1024 * 1024,
    readonly concurrency = 2,
  ) {}

  reserve(bytes: number): boolean {
    if (this.bytes + bytes > this.maxBytes) return false
    this.bytes += bytes
    return true
  }
  release(bytes: number): void {
    this.bytes -= bytes
  }

  async run(work: () => Promise<Uint8Array>, signal: AbortSignal): Promise<Uint8Array> {
    if (signal.aborted) throw new Error('socket closed')
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        this.waiting.delete(start)
        reject(new Error('socket closed'))
      }
      const start = () => {
        signal.removeEventListener('abort', abort)
        this.active += 1
        resolve()
      }
      if (this.active < this.concurrency) start()
      else {
        this.waiting.add(start)
        signal.addEventListener('abort', abort, { once: true })
      }
    })
    try {
      if (signal.aborted) throw new Error('socket closed')
      return await work()
    } finally {
      this.active -= 1
      const next = this.waiting.values().next().value
      if (next) {
        this.waiting.delete(next)
        next()
      }
    }
  }
}
const sharedBudget = new BootstrapCompressionBudget()

type Entry = {
  data: string | Uint8Array
  charge: number
  compress: boolean
  zstd: boolean
  lossy: boolean
  sent?: boolean
}

/** All application frames share this FIFO. Protocol ping/pong bypasses it.
 * Lossy sends return false for immediate rejection; true means admitted, and a
 * queued stream frame may still be dropped if the socket stops draining. */
export class OrderedClientSend implements PlaneSink {
  private readonly queue: Entry[] = []
  private readonly abort = new AbortController()
  private queuedBytes = 0
  private active: Entry | undefined
  private enabled = false
  private stopped = false

  constructor(
    private readonly ws: SendSocket,
    private readonly limits: { sendBufferLimitBytes: number; lossySendBufferLimitBytes: number },
    private readonly compress: Compressor = compressBootstrap,
    private readonly budget = sharedBudget,
    private readonly maxQueuedBytes = 128 * 1024 * 1024,
  ) {}

  enableBootstrapCompression(enabled: boolean): void {
    this.enabled = enabled && this.ws.sendBinary !== undefined
  }

  send: PlaneSink['send'] = (msg) => {
    this.json(msg, false)
  }
  sendLossy: PlaneSink['sendLossy'] = (msg) => this.json(msg, true)
  sendBinary: PlaneSink['sendBinary'] = (bytes) => {
    this.binary(bytes, false)
  }
  sendBinaryLossy: PlaneSink['sendBinaryLossy'] = (bytes) => this.binary(bytes, true)

  private json(msg: Parameters<PlaneSink['send']>[0], lossy: boolean): boolean {
    if (!this.admit(lossy)) return false
    try {
      const data = encodeDaemonMessage(msg)
      const zstd = this.enabled && msg.type === 'feedBootstrap'
      if (zstd && Buffer.byteLength(data) > BOOTSTRAP_ZSTD_MAX_BYTES) {
        this.fail()
        return false
      }
      return this.enqueue(
        {
          data,
          charge: Math.max(data.length * 2, Buffer.byteLength(data)),
          compress: shouldCompressWebSocketFrame(data, msg),
          zstd,
          lossy,
        },
        lossy,
      )
    } catch {
      // Serialization failure cannot leave a hole in the feed.
      if (!lossy) this.fail()
      return false
    }
  }

  private binary(bytes: Uint8Array, lossy: boolean): boolean {
    if (!this.admit(lossy)) return false
    if (!this.ws.sendBinary) {
      if (!lossy) this.fail()
      return false
    }
    // A queued producer may reuse its buffer after this call returns.
    return this.enqueue(
      {
        data: this.active || this.queue.length ? bytes.slice() : bytes,
        charge: bytes.byteLength,
        compress: shouldCompressWebSocketFrame(bytes),
        zstd: false,
        lossy,
      },
      lossy,
    )
  }

  private admit(lossy: boolean): boolean {
    if (this.stopped) return false
    if (this.ws.readyState !== 1) {
      this.dispose()
      return false
    }
    const limit = lossy ? this.limits.lossySendBufferLimitBytes : this.limits.sendBufferLimitBytes
    if (this.ws.bufferedAmount + (lossy ? this.queuedBytes : 0) > limit) {
      if (!lossy) this.fail()
      return false
    }
    return true
  }

  private enqueue(entry: Entry, lossy: boolean): boolean {
    const limit = lossy ? this.limits.lossySendBufferLimitBytes : this.maxQueuedBytes
    if (
      this.queuedBytes + entry.charge > limit ||
      this.queue.length >= 8192 ||
      !this.budget.reserve(entry.charge)
    ) {
      if (!lossy) this.fail()
      return false
    }
    this.queuedBytes += entry.charge
    this.queue.push(entry)
    this.drain()
    return !this.stopped && entry.sent !== false
  }

  private release(entry: Entry): void {
    this.queuedBytes -= entry.charge
    this.budget.release(entry.charge)
  }

  private drain(): void {
    if (this.active || this.stopped) return
    while (this.queue.length && !this.stopped) {
      const entry = this.queue.shift()!
      if (entry.zstd && typeof entry.data === 'string') {
        this.active = entry
        const json = entry.data
        void this.budget
          .run(() => this.compress(json), this.abort.signal)
          .then((compressed) => {
            if (this.stopped) return
            const bytes = encodeBinaryEnvelope(
              { v: 1, type: 'feedBootstrapZstd', uncompressedBytes: Buffer.byteLength(json) },
              compressed,
            )
            // Explicitly bypass native synchronous WebSocket deflate.
            this.write(bytes, false)
          })
          .catch((error: unknown) => {
            if (this.stopped) return
            log.warn('bootstrap compression failed; sending ordered JSON fallback', { error })
            this.write(json, false)
          })
          .finally(() => {
            this.active = undefined
            this.release(entry)
            this.drain()
          })
        return
      }
      entry.sent = this.write(entry.data, entry.compress, entry.lossy)
      this.release(entry)
    }
  }

  private write(data: string | Uint8Array, compress: boolean, lossy = false): boolean {
    if (lossy && this.ws.bufferedAmount > this.limits.lossySendBufferLimitBytes) return false
    if (!this.admit(false)) return false
    try {
      if (typeof data === 'string') this.ws.send(data, compress)
      else if (this.ws.sendBinary) this.ws.sendBinary(data, compress)
      else {
        if (!lossy) this.fail()
        return false
      }
      return true
    } catch {
      if (!lossy) this.fail()
      return false
    }
  }

  private fail(): void {
    this.dispose()
    this.ws.terminate()
  }

  dispose(): void {
    if (this.stopped) return
    this.stopped = true
    this.abort.abort()
    for (const entry of this.queue.splice(0)) this.release(entry)
    // Active input is accounted until the native job actually releases it.
  }
}

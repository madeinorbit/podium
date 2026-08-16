/** A strict newline-delimited JSON-RPC client for `grok agent stdio`. */
import {
  GROK_ACP_METHODS,
  type GrokAcpFrame,
  GrokAcpFrame as GrokAcpFrameSchema,
  type GrokAcpInitializeResult,
  GrokAcpInitializeResult as GrokAcpInitializeResultSchema,
  GrokAcpProtocolError,
  GrokAcpRpcError,
  type GrokAcpRpcId,
} from './protocol.js'

export interface GrokAcpTransport {
  write(line: string): void
  onLine(handler: { line(line: string): void; closed(): void }): void
  close(): void
}

export interface GrokAcpServerRequest {
  id: GrokAcpRpcId
  method: string
  params: unknown
}

export interface GrokAcpClientConfig {
  transport: GrokAcpTransport
  onNotification(frame: GrokAcpFrame): void
  onServerRequest(request: GrokAcpServerRequest): void
  onClose?(): void
  timeoutMs?: number
  setTimer?(fn: () => void, ms: number): unknown
  clearTimer?(handle: unknown): void
}

const DEFAULT_TIMEOUT_MS = 120_000

export interface GrokAcpClient {
  readonly ready: boolean
  initialize(): Promise<GrokAcpInitializeResult>
  call<T = unknown>(method: string, params?: unknown): Promise<T>
  notify(method: string, params?: unknown): void
  respond(id: GrokAcpRpcId, result: unknown): void
  respondError(id: GrokAcpRpcId, code: number, message: string): void
  close(): void
}

export function createGrokAcpClient(config: GrokAcpClientConfig): GrokAcpClient {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const setTimer =
    config.setTimer ??
    ((fn: () => void, ms: number) => {
      const timer = setTimeout(fn, ms)
      if (typeof timer === 'object' && 'unref' in timer) timer.unref()
      return timer
    })
  const clearTimer = config.clearTimer ?? ((handle: unknown) => clearTimeout(handle as never))
  const pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void; method: string; timer: unknown }
  >()
  let nextId = 1
  let ready = false
  let initialized = false
  let closed = false

  const fail = (error: Error): void => {
    for (const entry of pending.values()) {
      clearTimer(entry.timer)
      entry.reject(error)
    }
    pending.clear()
  }

  const send = (frame: Record<string, unknown>): void => {
    if (closed) throw new GrokAcpProtocolError('grok ACP client is closed')
    config.transport.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`)
  }

  const dispatch = (line: string): void => {
    const trimmed = line.trim()
    if (!trimmed) return
    let raw: unknown
    try {
      raw = JSON.parse(trimmed)
    } catch {
      return
    }
    const parsed = GrokAcpFrameSchema.safeParse(raw)
    if (!parsed.success) return
    const frame = parsed.data
    if (frame.id !== undefined && frame.method !== undefined) {
      config.onServerRequest({ id: frame.id, method: frame.method, params: frame.params })
      return
    }
    if (frame.id !== undefined) {
      const key = typeof frame.id === 'number' ? frame.id : Number(frame.id)
      const entry = pending.get(key)
      if (!entry) return
      pending.delete(key)
      clearTimer(entry.timer)
      if (frame.error) {
        entry.reject(
          new GrokAcpRpcError(
            frame.error.code,
            entry.method,
            frame.error.message,
            frame.error.data,
          ),
        )
      } else {
        entry.resolve(frame.result)
      }
      return
    }
    if (frame.method !== undefined) config.onNotification(frame)
  }

  config.transport.onLine({
    line(line) {
      if (!closed) dispatch(line)
    },
    closed() {
      if (closed) return
      closed = true
      fail(new GrokAcpProtocolError('grok agent stdio closed its pipe'))
      config.onClose?.()
    },
  })

  const call = <T>(method: string, params?: unknown): Promise<T> => {
    if (!ready && method !== GROK_ACP_METHODS.initialize) {
      return Promise.reject(
        new GrokAcpProtocolError(`grok ACP method '${method}' called before initialize`),
      )
    }
    const id = nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimer(() => {
        pending.delete(id)
        reject(new GrokAcpProtocolError(`grok ACP ${method} did not answer within ${timeoutMs}ms`))
      }, timeoutMs)
      pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        method,
        timer,
      })
      try {
        send({ id, method, ...(params !== undefined ? { params } : {}) })
      } catch (error) {
        pending.delete(id)
        clearTimer(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  return {
    get ready() {
      return ready
    },

    async initialize() {
      if (initialized) throw new GrokAcpProtocolError('grok ACP initialize already performed')
      initialized = true
      const result = await call<unknown>(GROK_ACP_METHODS.initialize, {
        protocolVersion: 1,
        clientInfo: { name: 'Podium', version: '1' },
        // Declaring a callback without serving it deadlocks Grok on its first
        // delegated file read. The W7 probe reproduced that failure.
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      })
      const response = GrokAcpInitializeResultSchema.parse(result)
      ready = true
      return response
    },

    call,
    notify(method, params) {
      send({ method, ...(params !== undefined ? { params } : {}) })
    },
    respond(id, result) {
      send({ id, result })
    },
    respondError(id, code, message) {
      send({ id, error: { code, message } })
    },
    close() {
      if (closed) return
      closed = true
      fail(new GrokAcpProtocolError('grok ACP client closed'))
      config.transport.close()
    },
  }
}

/**
 * THE OUTBOUND CHOKEPOINT (POD-389; moved verbatim from `wsServer.ts`).
 *
 * Every server→client and server→daemon frame funnels through {@link safeSend}.
 * It (a) never throws — a dead/closing socket's `send` raising must not abort a
 * broadcast loop or, from a timer/microtask context, take down the whole process
 * (there is no uncaughtException net); and (b) applies backpressure — a socket
 * whose buffered bytes exceed `limit` isn't draining, so we terminate it rather
 * than grow this process's memory unbounded. Exported for deterministic unit
 * testing.
 */

import type { encode as encodeFn } from '@podium/protocol'
import { encode } from '@podium/protocol'

/** Minimal slice of a gateway socket {@link safeSend} needs (kept tiny for tests). */
export interface SendSocket {
  readyState: number
  bufferedAmount: number
  send(data: string, compress?: boolean): unknown
  terminate(): void
}

export interface GatewaySocket extends SendSocket {
  ping(): void
  on(event: 'message', listener: (raw: string | Buffer) => void): this
  on(event: 'close', listener: () => void): this
  on(event: 'pong', listener: () => void): this
}

export const WS_COMPRESSION_MIN_BYTES = 1024
export const WS_COMPRESSION_MAX_BYTES = 32 * 1024 * 1024
export const WS_MAX_PAYLOAD_BYTES = 64 * 1024 * 1024

const PRECOMPRESSED_MIME =
  /^(?:image\/(?!svg\+xml)|audio\/|video\/|font\/|application\/(?:gzip|zip|x-7z-compressed|x-rar-compressed|pdf|wasm))\b/i

function carriesPrecompressedBytes(msg: unknown): boolean {
  if (!msg || typeof msg !== 'object') return false
  const frame = msg as { type?: unknown; contentType?: unknown }
  if (frame.type === 'imageUploadRequest') return true
  return (
    frame.type === 'fileAssetResult' &&
    typeof frame.contentType === 'string' &&
    PRECOMPRESSED_MIME.test(frame.contentType)
  )
}

export function shouldCompressWebSocketFrame(bytes: string, msg?: unknown): boolean {
  const byteLength = Buffer.byteLength(bytes)
  return (
    byteLength >= WS_COMPRESSION_MIN_BYTES &&
    byteLength <= WS_COMPRESSION_MAX_BYTES &&
    !carriesPrecompressedBytes(msg)
  )
}

export function safeSend(ws: SendSocket, msg: Parameters<typeof encodeFn>[0], limit: number): void {
  const bytes = encode(msg)
  safeSendEncoded(ws, bytes, limit, shouldCompressWebSocketFrame(bytes, msg))
}

/** Lossy stream send: pressure drops this frame and NEVER terminates the socket. */
export function safeSendLossy(
  ws: SendSocket,
  msg: Parameters<typeof encodeFn>[0],
  limit: number,
): boolean {
  if (ws.readyState !== 1 /* OPEN */ || ws.bufferedAmount > limit) return false
  try {
    const bytes = encode(msg)
    ws.send(bytes, shouldCompressWebSocketFrame(bytes, msg))
    return true
  } catch {
    return false
  }
}

/** Same backpressure/dead-socket gate for bytes already encoded in the worker. */
export function safeSendEncoded(
  ws: SendSocket,
  bytes: string,
  limit: number,
  compress = shouldCompressWebSocketFrame(bytes),
): void {
  if (ws.readyState !== 1 /* OPEN */) return
  if (ws.bufferedAmount > limit) {
    ws.terminate()
    return
  }
  try {
    ws.send(bytes, compress)
  } catch {
    // Socket went away between the readyState check and the send — drop the frame;
    // the heartbeat sweep (or this same gate next time) reaps it.
  }
}

// A malformed frame is dropped so it can't wedge the connection — but the drop is
// logged (never silent), throttled so a misbehaving peer can't flood the journal.
const FRAME_WARN_THROTTLE_MS = 1_000
const lastFrameWarnAt: Record<'client' | 'daemon', number> = { client: 0, daemon: 0 }

export function warnDroppedFrame(kind: 'client' | 'daemon', err: unknown): void {
  const now = Date.now()
  if (now - lastFrameWarnAt[kind] < FRAME_WARN_THROTTLE_MS) return
  lastFrameWarnAt[kind] = now
  console.warn(`[podium] dropped malformed ${kind} frame:`, err)
}

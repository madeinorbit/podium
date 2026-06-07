import { decodeInput } from '../parser.js'
import type { EmitFn } from './types.js'

/** Attach a raw-byte capture source to a stdin-like stream. Returns a detach fn. */
export function attachRawSource(stdin: NodeJS.ReadStream, emit: EmitFn): () => void {
  let pending: Buffer = Buffer.alloc(0)
  // Ink puts stdin in utf8 string mode, so chunks may arrive as strings. node-pty
  // and a piped TTY may deliver Buffers. Normalize to Buffer either way.
  const onData = (chunk: Buffer | string) => {
    const incoming = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
    const buf = pending.length ? Buffer.concat([pending, incoming]) : incoming
    const { events, rest } = decodeInput(buf)
    pending = rest
    for (const e of events) emit(e)
  }
  stdin.on('data', onData)
  return () => {
    stdin.off('data', onData)
  }
}

import { decodeInput } from '../parser.js'
import type { EmitFn } from './types.js'

/** Attach a raw-byte capture source to a stdin-like stream. Returns a detach fn. */
export function attachRawSource(stdin: NodeJS.ReadStream, emit: EmitFn): () => void {
  let pending: Buffer = Buffer.alloc(0)
  const onData = (chunk: Buffer) => {
    const buf = pending.length ? Buffer.concat([pending, chunk]) : chunk
    const { events, rest } = decodeInput(buf)
    pending = rest
    for (const e of events) emit(e)
  }
  stdin.on('data', onData)
  return () => {
    stdin.off('data', onData)
  }
}

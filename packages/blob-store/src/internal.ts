/** Helpers the adapters share. Not exported from the package root. */

import type { BlobBody } from './types'

/** The chunks of a put body, in order. */
export async function* bodyChunks(body: BlobBody): AsyncGenerator<Uint8Array> {
  if (body instanceof Uint8Array) {
    yield body
    return
  }
  const reader = body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return
      if (value.byteLength > 0) yield value
    }
  } finally {
    reader.releaseLock()
  }
}

/** A put body as one byte array. */
export async function collectBody(body: BlobBody): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body.slice()
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of bodyChunks(body)) {
    chunks.push(chunk)
    size += chunk.byteLength
  }
  const out = new Uint8Array(size)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.byteLength
  }
  return out
}

export function bytesStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (bytes.byteLength > 0) controller.enqueue(bytes)
      controller.close()
    },
  })
}

/**
 * A per-key mutex inside one process. The local adapter checks a condition and
 * renames under it, which is why it assumes one server process per state
 * directory [POD-6963 design 2.1, "Conditional writes"].
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>()

  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    let release!: () => void
    const done = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = previous.then(() => done)
    this.tails.set(key, tail)
    await previous
    try {
      return await task()
    } finally {
      release()
      if (this.tails.get(key) === tail) this.tails.delete(key)
    }
  }
}

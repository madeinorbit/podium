import { BOOTSTRAP_ZSTD_MAX_BYTES } from '@podium/protocol'
import { Decompress } from 'fzstd'

export interface CompressedBootstrap {
  payload: Uint8Array
  uncompressedBytes: number
}

/** Runs inside the existing one-chunk-per-task feed scheduler. */
export function decodeBootstrapZstd({ payload, uncompressedBytes }: CompressedBootstrap): string {
  if (
    !Number.isSafeInteger(uncompressedBytes) ||
    uncompressedBytes <= 0 ||
    uncompressedBytes > BOOTSTRAP_ZSTD_MAX_BYTES
  ) {
    throw new RangeError('invalid bootstrap decoded size')
  }
  validateZstdFrame(payload, uncompressedBytes)
  const output = new Uint8Array(uncompressedBytes)
  let offset = 0
  const decoder = new Decompress((chunk) => {
    if (offset + chunk.byteLength > output.byteLength) {
      throw new RangeError('bootstrap exceeds declared decoded size')
    }
    output.set(chunk, offset)
    offset += chunk.byteLength
  })
  decoder.push(payload, true)
  if (offset !== output.byteLength) throw new RangeError('bootstrap decoded size mismatch')
  return new TextDecoder('utf-8', { fatal: true }).decode(output)
}

/** Admit exactly one dictionary-free frame before fzstd allocates its window.
 * Bun's one-shot compressor includes the source size. Reject concatenated or
 * skippable frames, unknown sizes and oversized windows rather than trusting a
 * compressed header to choose an allocation. */
function validateZstdFrame(bytes: Uint8Array, expected: number): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.length < 6 || view.getUint32(0, true) !== 0xfd2fb528)
    throw new Error('invalid Zstd frame')
  const flags = bytes[4]!
  if (flags & 0x1b) throw new Error('unsupported Zstd frame flags or dictionary')
  const single = (flags & 0x20) !== 0
  const sizeFlag = flags >>> 6
  let offset = single ? 5 : 6
  if (!single) {
    const descriptor = bytes[5]!
    const base = 2 ** (10 + (descriptor >>> 3))
    const window = base + (base / 8) * (descriptor & 7)
    if (window > BOOTSTRAP_ZSTD_MAX_BYTES) throw new RangeError('Zstd window exceeds budget')
  }
  const sizeBytes = sizeFlag ? 2 ** sizeFlag : single ? 1 : 0
  if (!sizeBytes || offset + sizeBytes > bytes.length) throw new Error('missing Zstd content size')
  let size = 0
  for (let i = 0; i < sizeBytes; i++) size += bytes[offset + i]! * 2 ** (8 * i)
  if (sizeFlag === 1) size += 256
  if (size !== expected) throw new RangeError('Zstd content size mismatch')
  offset += sizeBytes
  let last = false
  while (!last) {
    if (offset + 3 > bytes.length) throw new Error('truncated Zstd block')
    const header = bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16)
    offset += 3
    last = (header & 1) !== 0
    const type = (header >>> 1) & 3
    if (type === 3) throw new Error('reserved Zstd block type')
    offset += type === 1 ? 1 : header >>> 3
    if (offset > bytes.length) throw new Error('truncated Zstd block payload')
  }
  if (flags & 4) offset += 4
  if (offset !== bytes.length) throw new Error('trailing or truncated Zstd frame')
}

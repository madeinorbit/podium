import { describe, expect, it } from 'vitest'
import { decodeBootstrapZstd } from './bootstrap-zstd'

// Single-segment frame, three-byte source size, one last raw block: "abc".
const valid = Uint8Array.of(0x28, 0xb5, 0x2f, 0xfd, 0x20, 3, 25, 0, 0, 97, 98, 99)
const decode = (payload: Uint8Array, uncompressedBytes = 3) =>
  decodeBootstrapZstd({ payload, uncompressedBytes })
describe('bounded portable Zstd decoding', () => {
  it('decodes a complete frame and validates decoded size', () => {
    expect(decode(valid)).toBe('abc')
    expect(() => decode(valid, 4)).toThrow(/size mismatch/)
    expect(() => decode(valid, 64 * 1024 * 1024 + 1)).toThrow(/decoded size/)
  })
  it('rejects truncation, trailing frames, and invalid UTF-8', () => {
    expect(() => decode(valid.subarray(0, valid.length - 1))).toThrow(/truncated/)
    expect(() => decode(Uint8Array.from([...valid, ...valid]))).toThrow(/trailing/)
    const invalid = valid.slice()
    invalid[9] = 255
    expect(() => decode(invalid)).toThrow()
  })
  it('refuses an oversized window before the decoder can allocate it', () => {
    // Multi-segment, content size encoded as u16 (+256), 128 MiB window.
    const frame = Uint8Array.of(0x28, 0xb5, 0x2f, 0xfd, 0x40, 136, 0, 0, 1, 0, 0)
    expect(() => decode(frame, 256)).toThrow(/window exceeds/)
  })
  it('bounds output even when a raw block contradicts its frame header', () => {
    const frame = valid.slice()
    frame[5] = 2
    expect(() => decode(frame, 2)).toThrow(/exceeds declared/)
  })
})

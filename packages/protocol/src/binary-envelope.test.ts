import { asSessionId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import {
  BINARY_ENVELOPE_MAX_METADATA_BYTES,
  DaemonPtyOutputMetadata,
  decodeBinaryEnvelope as decodeEnvelope,
  encodeBinaryEnvelope,
  PtyOutputBinaryMetadata,
} from './binary-envelope'

const metadata: PtyOutputBinaryMetadata = {
  v: 1,
  type: 'ptyOutput',
  sessionId: asSessionId('session-1'),
  seq: 7,
  epoch: 2,
}
const rawEnvelope = (meta: Uint8Array, payload = new Uint8Array()): Uint8Array => {
  const frame = new Uint8Array(4 + meta.byteLength + payload.byteLength)
  new DataView(frame.buffer).setUint32(0, meta.byteLength, false)
  frame.set(meta, 4)
  frame.set(payload, 4 + meta.byteLength)
  return frame
}
const ascii = (value: string): Uint8Array => Uint8Array.from(value, (char) => char.charCodeAt(0))
const jsonEnvelope = (value: unknown, payload = new Uint8Array()): Uint8Array =>
  rawEnvelope(ascii(JSON.stringify(value)), payload)
const decodeBinaryEnvelope = (input: ArrayBuffer | ArrayBufferView) =>
  decodeEnvelope(input, PtyOutputBinaryMetadata)

describe('binary envelope v1', () => {
  it('round-trips metadata and exact payload bytes', () => {
    const payload = Uint8Array.of(0, 0xff, 0xe2, 0x82)
    const decoded = decodeBinaryEnvelope(encodeBinaryEnvelope(metadata, payload))
    expect(decoded.metadata).toEqual(metadata)
    expect(decoded.payload).toEqual(payload)
  })
  it('retains unknown additive metadata fields', () => {
    const decoded = decodeBinaryEnvelope(jsonEnvelope({ ...metadata, future: { enabled: true } }))
    expect(decoded.metadata).toMatchObject({ ...metadata, future: { enabled: true } })
  })
  it('allows an empty payload', () => {
    expect(decodeBinaryEnvelope(encodeBinaryEnvelope(metadata, new Uint8Array())).payload).toEqual(
      new Uint8Array(),
    )
  })
  it('rejects a truncated header', () => {
    expect(() => decodeBinaryEnvelope(Uint8Array.of(0, 0, 1))).toThrow(/header is truncated/)
  })
  it('rejects an impossible metadata length before slicing', () => {
    const frame = new Uint8Array(5)
    new DataView(frame.buffer).setUint32(0, 10, false)
    expect(() => decodeBinaryEnvelope(frame)).toThrow(/length exceeds the message/)
  })
  it('rejects metadata over 16 KiB before decoding it', () => {
    const frame = new Uint8Array(4)
    new DataView(frame.buffer).setUint32(0, BINARY_ENVELOPE_MAX_METADATA_BYTES + 1, false)
    expect(() => decodeBinaryEnvelope(frame)).toThrow(/exceeds the 16 KiB limit/)
  })
  it('rejects invalid UTF-8 and JSON metadata', () => {
    expect(() => decodeBinaryEnvelope(rawEnvelope(Uint8Array.of(0xff)))).toThrow()
    expect(() => decodeBinaryEnvelope(rawEnvelope(ascii('{')))).toThrow()
  })
  it('rejects unknown message types and unsupported metadata versions', () => {
    expect(() =>
      decodeBinaryEnvelope(jsonEnvelope({ ...metadata, type: 'futureOutput' })),
    ).toThrow()
    expect(() => decodeBinaryEnvelope(jsonEnvelope({ ...metadata, v: 2 }))).toThrow()
  })
  it('applies a caller schema when planes share the same header discriminator', () => {
    const frame = jsonEnvelope({
      v: 1,
      type: 'ptyOutput',
      sessionId: asSessionId('session-1'),
      sourceFrames: 3,
    })
    expect(decodeEnvelope(frame, DaemonPtyOutputMetadata).metadata.sourceFrames).toBe(3)
    expect(() => decodeEnvelope(frame, PtyOutputBinaryMetadata)).toThrow()
  })
  it('validates daemon output required fields and positive source frame counts', () => {
    expect(() =>
      decodeEnvelope(
        jsonEnvelope({ v: 1, type: 'ptyOutput', sessionId: asSessionId('session-1') }),
        DaemonPtyOutputMetadata,
      ),
    ).toThrow()
    expect(() =>
      decodeEnvelope(
        jsonEnvelope({ v: 1, type: 'ptyOutput', sourceFrames: 1 }),
        DaemonPtyOutputMetadata,
      ),
    ).toThrow()
    expect(() =>
      decodeEnvelope(
        jsonEnvelope({
          v: 1,
          type: 'ptyOutput',
          sessionId: asSessionId('session-1'),
          sourceFrames: 0,
        }),
        DaemonPtyOutputMetadata,
      ),
    ).toThrow()
    expect(() =>
      decodeEnvelope(
        jsonEnvelope({
          v: 1,
          type: 'ptyOutput',
          sessionId: asSessionId('session-1'),
          sourceFrames: Number.MAX_SAFE_INTEGER,
        }),
        DaemonPtyOutputMetadata,
      ),
    ).toThrow()
  })
  it('retains additive daemon output metadata fields', () => {
    const daemonMetadata = {
      v: 1 as const,
      type: 'ptyOutput' as const,
      sessionId: asSessionId('session-1'),
      sourceFrames: 2,
      future: true,
    }
    expect(
      decodeEnvelope(
        encodeBinaryEnvelope(daemonMetadata, Uint8Array.of(0xff)),
        DaemonPtyOutputMetadata,
      ).metadata,
    ).toMatchObject(daemonMetadata)
  })
})

/**
 * Shared binary WebSocket envelope.
 *
 * A frame is `[u32be metadata byte length][UTF-8 JSON metadata][raw payload]`.
 * The framing is plane-agnostic: metadata schemas select the message while the
 * payload remains uninterpreted bytes. Bounds are checked before metadata is
 * sliced, decoded, or parsed, so an untrusted length cannot allocate freely.
 */
import { Attribution, SessionIdField } from '@podium/model'
import { z } from 'zod'
import { ObservationInputOrigin } from './messages/runtime-state'

export const BINARY_ENVELOPE_HEADER_BYTES = 4
export const BINARY_ENVELOPE_MAX_METADATA_BYTES = 16 * 1024
export const BINARY_ENVELOPE_MAX_MESSAGE_BYTES = 64 * 1024 * 1024
/** A scheduler batch cannot legitimately contain more one-byte PTY reads than this. */
export const DAEMON_PTY_OUTPUT_MAX_SOURCE_FRAMES = 64 * 1024

/** V1 server-to-browser PTY output metadata. Unknown additive fields survive. */
export const PtyOutputBinaryMetadata = z
  .object({
    v: z.literal(1),
    type: z.literal('ptyOutput'),
    sessionId: SessionIdField,
    seq: z.number().int().nonnegative(),
    epoch: z.number().int().nonnegative(),
  })
  .passthrough()
export type PtyOutputBinaryMetadata = z.infer<typeof PtyOutputBinaryMetadata>

/** V1 daemon-to-server PTY output metadata. Unknown additive fields survive. */
export const DaemonPtyOutputMetadata = z
  .object({
    v: z.literal(1),
    type: z.literal('ptyOutput'),
    sessionId: SessionIdField,
    sourceFrames: z.number().int().positive().safe().max(DAEMON_PTY_OUTPUT_MAX_SOURCE_FRAMES),
  })
  .passthrough()
export type DaemonPtyOutputMetadata = z.infer<typeof DaemonPtyOutputMetadata>
/** V1 browser-client-to-server PTY input metadata. Identity is transport-derived. */
export const ClientPtyInputMetadata = z
  .object({
    v: z.literal(1),
    type: z.literal('ptyInput'),
    sessionId: SessionIdField,
  })
  .passthrough()
export type ClientPtyInputMetadata = z.infer<typeof ClientPtyInputMetadata>

/** V1 server-to-daemon PTY input metadata. The server stamps authority fields. */
export const DaemonPtyInputMetadata = z
  .object({
    v: z.literal(1),
    type: z.literal('ptyInput'),
    sessionId: SessionIdField,
    inputOrigin: ObservationInputOrigin,
    attribution: Attribution.optional(),
  })
  .passthrough()
export type DaemonPtyInputMetadata = z.infer<typeof DaemonPtyInputMetadata>

/** Supported framing header. Plane schemas validate fields beyond this header. */
export const BinaryEnvelopeHeader = z
  .object({ v: z.literal(1), type: z.enum(['ptyOutput', 'ptyInput']) })
  .passthrough()
export type BinaryEnvelopeHeader = z.infer<typeof BinaryEnvelopeHeader>

export interface DecodedBinaryEnvelope<Metadata> {
  metadata: Metadata
  payload: Uint8Array
}

type Utf8CodecGlobals = {
  TextEncoder: new () => { encode(input: string): Uint8Array }
  TextDecoder: new (
    label?: string,
    options?: { fatal?: boolean },
  ) => {
    decode(input?: ArrayBufferView): string
  }
}
const utf8Codecs = globalThis as unknown as Utf8CodecGlobals
const utf8Encoder = new utf8Codecs.TextEncoder()
const utf8Decoder = new utf8Codecs.TextDecoder('utf-8', { fatal: true })
const bytesOf = (input: ArrayBuffer | ArrayBufferView): Uint8Array =>
  input instanceof ArrayBuffer
    ? new Uint8Array(input)
    : new Uint8Array(input.buffer, input.byteOffset, input.byteLength)

function assertMessageSize(byteLength: number): void {
  if (byteLength > BINARY_ENVELOPE_MAX_MESSAGE_BYTES) {
    throw new RangeError('binary envelope exceeds the 64 MiB message limit')
  }
}

export function encodeBinaryEnvelope(
  metadata: BinaryEnvelopeHeader,
  payload: Uint8Array,
): Uint8Array {
  const metadataBytes = utf8Encoder.encode(JSON.stringify(metadata))
  if (metadataBytes.byteLength > BINARY_ENVELOPE_MAX_METADATA_BYTES) {
    throw new RangeError('binary envelope metadata exceeds the 16 KiB limit')
  }
  const byteLength = BINARY_ENVELOPE_HEADER_BYTES + metadataBytes.byteLength + payload.byteLength
  assertMessageSize(byteLength)
  const encoded = new Uint8Array(byteLength)
  new DataView(encoded.buffer).setUint32(0, metadataBytes.byteLength, false)
  encoded.set(metadataBytes, BINARY_ENVELOPE_HEADER_BYTES)
  encoded.set(payload, BINARY_ENVELOPE_HEADER_BYTES + metadataBytes.byteLength)
  return encoded
}

/** The payload returned here is a zero-copy view over the received message. */
export function decodeBinaryEnvelope<Schema extends z.ZodTypeAny>(
  input: ArrayBuffer | ArrayBufferView,
  schema: Schema,
): DecodedBinaryEnvelope<z.output<Schema> & BinaryEnvelopeHeader> {
  const bytes = bytesOf(input)
  assertMessageSize(bytes.byteLength)
  if (bytes.byteLength < BINARY_ENVELOPE_HEADER_BYTES) {
    throw new RangeError('binary envelope header is truncated')
  }
  const metadataLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
    0,
    false,
  )
  if (metadataLength > BINARY_ENVELOPE_MAX_METADATA_BYTES) {
    throw new RangeError('binary envelope metadata exceeds the 16 KiB limit')
  }
  const payloadOffset = BINARY_ENVELOPE_HEADER_BYTES + metadataLength
  if (payloadOffset > bytes.byteLength) {
    throw new RangeError('binary envelope metadata length exceeds the message')
  }
  const metadataBytes = bytes.subarray(BINARY_ENVELOPE_HEADER_BYTES, payloadOffset)
  const metadataJson = utf8Decoder.decode(metadataBytes)
  const candidate: unknown = JSON.parse(metadataJson)
  BinaryEnvelopeHeader.parse(candidate)
  const metadata = schema.parse(candidate) as z.output<Schema> & BinaryEnvelopeHeader
  return { metadata, payload: bytes.subarray(payloadOffset) }
}

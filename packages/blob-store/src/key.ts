/**
 * Blob keys [POD-6963 design 2.1, "Keys"].
 *
 * A `BlobKey` is a branded relative path, and {@link blobKey} is the one
 * validator that mints it: `/`-separated segments of `[A-Za-z0-9._-]`, no
 * empty, `.` or `..` segment, no leading or trailing `/`. Callers build keys
 * through small per-owner functions (`artifactKey(issue, artifact, rel)`),
 * never by string joins.
 *
 * An id that is not already a valid segment is encoded by {@link keySegment} as
 * `~` followed by its base64url form. `~` is outside the plain alphabet, so an
 * encoded id can never equal a plain one, and the validator accepts the encoded
 * form as a segment of its own.
 *
 * Two refusals beyond the alphabet keep keys safe on both backends: a plain
 * segment may not start with `.tmp-` (the local adapter's temp-file prefix, so
 * a key can never name or collide with an in-flight write), and segments are at
 * most 255 bytes, keys at most 1024 (a filename on local disk, an S3 key).
 *
 * Numbers in keys (part numbers, chunk offsets) go through {@link padNumber},
 * so lexicographic order is numeric order.
 */

declare const blobKeyBrand: unique symbol
export type BlobKey = string & { readonly [blobKeyBrand]: true }

export const MAX_SEGMENT_BYTES = 255
export const MAX_KEY_BYTES = 1024
/** Local temp files are named `<TEMP_PREFIX><uuid>`; no key segment may start with it. */
export const TEMP_PREFIX = '.tmp-'

const PLAIN_SEGMENT = /^[A-Za-z0-9._-]+$/
const ENCODED_SEGMENT = /^~[A-Za-z0-9_-]+$/

export class InvalidBlobKey extends TypeError {
  override readonly name = 'InvalidBlobKey'
  constructor(
    readonly value: string,
    readonly reason: string,
  ) {
    super(`invalid blob key ${JSON.stringify(value)}: ${reason}`)
  }
}

/** Why `segment` is not a plain (unencoded) segment, or `undefined` when it is one. */
function plainSegmentProblem(segment: string): string | undefined {
  if (segment.length === 0) return 'empty segment'
  if (segment === '.' || segment === '..') return `'${segment}' segment`
  if (!PLAIN_SEGMENT.test(segment))
    return `segment '${segment}' has characters outside [A-Za-z0-9._-]`
  if (segment.startsWith(TEMP_PREFIX))
    return `segment '${segment}' starts with the reserved '${TEMP_PREFIX}'`
  if (segment.length > MAX_SEGMENT_BYTES) return `segment longer than ${MAX_SEGMENT_BYTES} bytes`
  return undefined
}

function segmentProblem(segment: string): string | undefined {
  if (segment.startsWith('~')) {
    if (!ENCODED_SEGMENT.test(segment)) return `segment '${segment}' is not '~' + base64url`
    if (segment.length > MAX_SEGMENT_BYTES) return `segment longer than ${MAX_SEGMENT_BYTES} bytes`
    return undefined
  }
  return plainSegmentProblem(segment)
}

function keyProblem(value: string): string | undefined {
  if (value.length === 0) return 'empty key'
  if (value.startsWith('/')) return 'leading /'
  // Every valid key is ASCII, so its length is its byte length.
  if (value.length > MAX_KEY_BYTES) return `key longer than ${MAX_KEY_BYTES} bytes`
  for (const segment of value.split('/')) {
    const problem = segmentProblem(segment)
    if (problem !== undefined) return problem
  }
  return undefined
}

/** The one validator: returns `value` as a `BlobKey` or throws {@link InvalidBlobKey}. */
export function blobKey(value: string): BlobKey {
  const problem = keyProblem(value)
  if (problem !== undefined) throw new InvalidBlobKey(value, problem)
  return value as BlobKey
}

export function isBlobKey(value: string): value is BlobKey {
  return keyProblem(value) === undefined
}

/** True when `segment` may appear as one segment of a key (plain or `~`-encoded). */
export function isKeySegment(segment: string): boolean {
  return segmentProblem(segment) === undefined
}

/** Join already-valid segments (and keys) into a key; each part is validated. */
export function joinKey(...parts: readonly string[]): BlobKey {
  return blobKey(parts.join('/'))
}

/**
 * The segment for an arbitrary id: the id itself when it is already a plain
 * segment, otherwise `~` + base64url of its UTF-8 bytes. Injective, so two
 * different ids never share a segment.
 */
export function keySegment(id: string): string {
  if (id.length === 0) throw new InvalidBlobKey(id, 'an empty id has no segment')
  if (plainSegmentProblem(id) === undefined) return id
  const encoded = `~${Buffer.from(id, 'utf8').toString('base64url')}`
  if (encoded.length > MAX_SEGMENT_BYTES) {
    throw new InvalidBlobKey(id, `encoded id longer than ${MAX_SEGMENT_BYTES} bytes`)
  }
  return encoded
}

/** The id a {@link keySegment} result stands for. */
export function decodeKeySegment(segment: string): string {
  const problem = segmentProblem(segment)
  if (problem !== undefined) throw new InvalidBlobKey(segment, problem)
  if (!segment.startsWith('~')) return segment
  return Buffer.from(segment.slice(1), 'base64url').toString('utf8')
}

/** A non-negative integer zero-padded to `width` digits, so string order is numeric order. */
export function padNumber(value: number, width: number): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`padNumber needs a non-negative safe integer, got ${value}`)
  }
  if (!Number.isSafeInteger(width) || width < 1) {
    throw new RangeError(`padNumber needs a positive width, got ${width}`)
  }
  const digits = String(value)
  if (digits.length > width) throw new RangeError(`${value} does not fit in ${width} digits`)
  return digits.padStart(width, '0')
}

/** The number a {@link padNumber} segment holds; refuses anything that is not `width` digits. */
export function parsePadded(segment: string, width: number): number {
  if (segment.length !== width || !/^[0-9]+$/.test(segment)) {
    throw new RangeError(`'${segment}' is not a ${width}-digit padded number`)
  }
  const value = Number(segment)
  if (!Number.isSafeInteger(value)) throw new RangeError(`'${segment}' is not a safe integer`)
  return value
}

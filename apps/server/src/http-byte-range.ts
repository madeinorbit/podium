export type ByteRangeRequest =
  | { kind: 'bounded'; start: number; end?: number }
  | { kind: 'suffix'; length: number }

export type ResolvedByteRange = { offset: number; length: number; end: number }

/** Parse one HTTP byte range. Multipart ranges are deliberately unsupported. */
export function parseByteRange(header: string | undefined): ByteRangeRequest | null | 'invalid' {
  if (!header) return null
  const value = header.trim()
  const bounded = /^bytes=(\d+)-(\d*)$/i.exec(value)
  if (bounded) {
    const start = Number(bounded[1])
    const end = bounded[2] ? Number(bounded[2]) : undefined
    if (
      !Number.isSafeInteger(start) ||
      (end !== undefined && (!Number.isSafeInteger(end) || end < start))
    ) {
      return 'invalid'
    }
    return { kind: 'bounded', start, ...(end === undefined ? {} : { end }) }
  }
  const suffix = /^bytes=-(\d+)$/i.exec(value)
  if (suffix) {
    const length = Number(suffix[1])
    return Number.isSafeInteger(length) && length > 0 ? { kind: 'suffix', length } : 'invalid'
  }
  return 'invalid'
}

export function resolveByteRange(
  request: ByteRangeRequest,
  size: number,
  maxLength: number,
): ResolvedByteRange | 'unsatisfiable' {
  if (!Number.isSafeInteger(size) || size <= 0) return 'unsatisfiable'
  if (request.kind === 'suffix') {
    const length = Math.min(request.length, size, maxLength)
    const offset = size - length
    return { offset, length, end: size - 1 }
  }
  if (request.start >= size) return 'unsatisfiable'
  const requestedEnd = Math.min(request.end ?? size - 1, size - 1)
  const length = Math.min(requestedEnd - request.start + 1, maxLength)
  return { offset: request.start, length, end: request.start + length - 1 }
}

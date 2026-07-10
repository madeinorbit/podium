// `crypto.randomUUID` is only exposed in secure contexts (HTTPS or localhost).
// Podium is explicitly meant to be reached over plain HTTP on a LAN address
// ("point your phone at the same host"), where `crypto.randomUUID` is undefined.
// Fall back to a v4 UUID built from `crypto.getRandomValues`, which is available
// in every context, so client-minted ids work regardless of origin.
export function randomUUID(): string {
  const c = globalThis.crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()

  const bytes = new Uint8Array(16)
  c.getRandomValues(bytes)
  // Force the version (4) and variant (10xx) bits per RFC 4122 while hex-encoding.
  const hex = Array.from(bytes, (byte, i) => {
    const b = i === 6 ? (byte & 0x0f) | 0x40 : i === 8 ? (byte & 0x3f) | 0x80 : byte
    return b.toString(16).padStart(2, '0')
  }).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

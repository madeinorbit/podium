/**
 * WAS THIS REQUEST MADE OVER HTTPS, as far as the server may believe it.
 *
 * True when the server ended TLS itself, or when the reverse-proxy hop the
 * operator declared trusted reported https. A forwarded value is read only at
 * the position `trustedProxyHops` names; with zero trusted hops no forwarding
 * header is read at all.
 */
import type { Context } from 'hono'

export function isSecureRequest(
  url: string,
  forwardedProto?: string,
  trustedProxyHops: number = 0,
): boolean {
  try {
    if (new URL(url).protocol === 'https:') return true
  } catch {
    return false
  }
  if (trustedProxyHops <= 0 || !Number.isSafeInteger(trustedProxyHops)) return false
  const chain = (forwardedProto ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
  const index = chain.length - trustedProxyHops
  return index >= 0 && chain[index] === 'https'
}

export function isHttps(c: Context, trustedProxyHops: number = 0): boolean {
  return isSecureRequest(c.req.url, c.req.header('x-forwarded-proto'), trustedProxyHops)
}

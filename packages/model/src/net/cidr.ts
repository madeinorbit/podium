/**
 * NETWORK RANGES (CIDR), IPv4 AND IPv6, WITHOUT A DEPENDENCY.
 *
 * Used by the instance setting `daemonLink.trustedNetworks` (credential
 * management §8): the model validates what an admin writes, and the server asks
 * whether a daemon's address lies inside one of the ranges. Pure and
 * browser-safe, so the settings form and the server read one parser.
 *
 * An IPv4-mapped IPv6 address (`::ffff:192.168.1.5`, what a dual-stack listener
 * reports for an IPv4 peer) is read as the IPv4 address it carries, so an
 * IPv4 range matches it.
 */

import { z } from 'zod'

export interface ParsedCidr {
  readonly family: 4 | 6
  /** The range's network, host bits cleared. */
  readonly network: bigint
  readonly prefix: number
}

interface ParsedAddress {
  readonly family: 4 | 6
  readonly value: bigint
}

const DECIMAL_OCTET = /^(0|[1-9]\d{0,2})$/
const HEXTET = /^[0-9a-f]{1,4}$/i

function parseIpv4(text: string): bigint | null {
  const parts = text.split('.')
  if (parts.length !== 4) return null
  let value = 0n
  for (const part of parts) {
    if (!DECIMAL_OCTET.test(part)) return null
    const octet = Number(part)
    if (octet > 255) return null
    value = (value << 8n) | BigInt(octet)
  }
  return value
}

function parseIpv6(text: string): bigint | null {
  let body = text
  // An embedded IPv4 tail (`::ffff:1.2.3.4`) stands for the last two hextets.
  let tail: bigint | null = null
  const lastColon = body.lastIndexOf(':')
  if (lastColon !== -1 && body.slice(lastColon + 1).includes('.')) {
    tail = parseIpv4(body.slice(lastColon + 1))
    if (tail === null) return null
    body = `${body.slice(0, lastColon + 1)}0:0`
  }
  const halves = body.split('::')
  if (halves.length > 2) return null
  const groups = (half: string): string[] | null => {
    if (half === '') return []
    const out = half.split(':')
    return out.every((group) => HEXTET.test(group)) ? out : null
  }
  const head = groups(halves[0] ?? '')
  const rest = halves.length === 2 ? groups(halves[1] ?? '') : []
  if (head === null || rest === null) return null
  const missing = 8 - head.length - rest.length
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null
  const all = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...rest]
  let value = 0n
  for (const group of all) value = (value << 16n) | BigInt(Number.parseInt(group, 16))
  if (tail !== null) value = (value & ~0xffff_ffffn) | tail
  return value
}

const MAPPED_V4_PREFIX = 0xffffn << 32n

/** An address as a number, an IPv4-mapped IPv6 address read as IPv4. */
function parseAddress(raw: string): ParsedAddress | null {
  const text = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw
  if (text.includes(':')) {
    const value = parseIpv6(text)
    if (value === null) return null
    if (value >> 32n === MAPPED_V4_PREFIX >> 32n) return { family: 4, value: value & 0xffff_ffffn }
    return { family: 6, value }
  }
  const value = parseIpv4(text)
  return value === null ? null : { family: 4, value }
}

const bitsOf = (family: 4 | 6): number => (family === 4 ? 32 : 128)

function maskOf(family: 4 | 6, prefix: number): bigint {
  const bits = BigInt(bitsOf(family))
  const all = (1n << bits) - 1n
  return (all >> BigInt(prefix)) ^ all
}

/** `address/prefix`, or null when it is not one. Host bits are allowed and cleared. */
export function parseCidr(text: string): ParsedCidr | null {
  const slash = text.indexOf('/')
  if (slash === -1) return null
  const prefixText = text.slice(slash + 1)
  if (!/^(0|[1-9]\d{0,2})$/.test(prefixText)) return null
  const prefix = Number(prefixText)
  const addressText = text.slice(0, slash)
  // A range is written plainly: a mapped IPv6 spelling of an IPv4 range is not
  // accepted, so the prefix always counts the bits of the family as written.
  const family = addressText.includes(':') ? 6 : 4
  const value = family === 6 ? parseIpv6(addressText) : parseIpv4(addressText)
  if (value === null || prefix > bitsOf(family)) return null
  return { family, network: value & maskOf(family, prefix), prefix }
}

/** Whether `address` lies inside `range`. False for anything malformed. */
export function cidrContains(range: string, address: string): boolean {
  const parsed = parseCidr(range)
  const at = parseAddress(address)
  if (parsed === null || at === null || parsed.family !== at.family) return false
  return (at.value & maskOf(parsed.family, parsed.prefix)) === parsed.network
}

/** What a value that is not a range is refused with, on the server and in the form. */
export const CIDR_RANGE_MESSAGE = 'Not a network range. Write it like 192.168.1.0/24 or fd00::/8.'

/** One network range as an admin writes it. */
export const CidrRange = z.string().refine((text) => parseCidr(text) !== null, {
  message: CIDR_RANGE_MESSAGE,
})

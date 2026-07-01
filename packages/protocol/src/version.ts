/**
 * Podium WIRE protocol version (client↔server and server↔daemon message shapes in this
 * package). Bump on any breaking change. Distinct from the MCP spec-date constant in
 * apps/server/src/mcp-route.ts. Peers on different releases/machines compare this to
 * decide compatibility (see isProtocolCompatible) and tell the user to update on a miss.
 */
export const WIRE_VERSION = 1

/**
 * Two peers are compatible iff they share the same wire version. A single integer
 * today; this function is the seam for a major/minor scheme later.
 */
export function isProtocolCompatible(a: number, b: number): boolean {
  return Number.isInteger(a) && Number.isInteger(b) && a === b
}

/** Oldest wire version the server still accepts. Raise per breaking release to FORCE older peers. */
export const MIN_SUPPORTED_VERSION = 1

export function versionSupport(
  v: number,
  wire: number = WIRE_VERSION,
  min: number = MIN_SUPPORTED_VERSION,
): 'ok' | 'too-old' | 'too-new' {
  if (!Number.isInteger(v) || v < min) return 'too-old'
  if (v > wire) return 'too-new'
  return 'ok'
}

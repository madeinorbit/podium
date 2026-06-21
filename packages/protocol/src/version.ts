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

import type { SecretPresenceWire } from '@podium/model/browser'

/** Server-owned integration tokens publish presence and fingerprints, never values. */
export type SecretSurfaceState =
  | { status: 'loading' }
  | { status: 'available'; rows: readonly SecretPresenceWire[] }
  | { status: 'unavailable' }

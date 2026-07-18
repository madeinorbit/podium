import { z } from 'zod'

/**
 * Janitor compatibility is intentionally stricter than the public client wire.
 * Any incompatible janitor-read schema or command contract change bumps one of
 * these values so an old sibling stops before acquiring/renewing a lease.
 * [spec:SP-c29e]
 */
export const MAINTENANCE_PROTOCOL_VERSION = 1
export const MAINTENANCE_SCHEMA_VERSION = 'maintenance-v1'
export const MESSAGE_WAIT_TTL_MS = 7 * 24 * 60 * 60_000

const VersionClaim = {
  protocolVersion: z.number().int().positive(),
  schemaVersion: z.string().min(1).max(128),
}

export const MaintenanceHandshake = z.object({
  ...VersionClaim,
  generationId: z.string().min(1).max(128),
})
export type MaintenanceHandshake = z.infer<typeof MaintenanceHandshake>

export const MaintenanceHandshakeReply = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ready'),
    fencingToken: z.number().int().positive(),
    expiresAt: z.string().datetime(),
    messageWaitTtlMs: z.number().int().positive(),
  }),
  z.object({
    status: z.literal('busy'),
    retryAt: z.string().datetime(),
  }),
  z.object({
    status: z.literal('incompatible'),
    expectedProtocolVersion: z.number().int().positive(),
    expectedSchemaVersion: z.string().min(1),
  }),
])
export type MaintenanceHandshakeReply = z.infer<typeof MaintenanceHandshakeReply>

export const MessageExpiryObservation = z.object({
  messageId: z.string().min(1).max(256),
  status: z.literal('queued'),
  lifecycle: z.enum(['wait', 'wake']),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime().nullable(),
})
export type MessageExpiryObservation = z.infer<typeof MessageExpiryObservation>

export const MaintenanceCommand = z.object({
  ...VersionClaim,
  jobKind: z.literal('message-expiry'),
  runKey: z.string().min(1).max(1024),
  fencingToken: z.number().int().positive(),
  observed: MessageExpiryObservation,
})
export type MaintenanceCommand = z.infer<typeof MaintenanceCommand>

export const MaintenanceStaleReason = z.enum([
  'fenced',
  'lease-expired',
  'incompatible',
  'invalid-run-key',
  'precondition',
  'not-due',
])
export type MaintenanceStaleReason = z.infer<typeof MaintenanceStaleReason>

const CommandResultIdentity = {
  jobKind: z.literal('message-expiry'),
  runKey: z.string().min(1),
}

export const MaintenanceCommandReply = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('applied'),
    ...CommandResultIdentity,
  }),
  z.object({
    status: z.literal('already-applied'),
    ...CommandResultIdentity,
  }),
  z.object({
    status: z.literal('stale'),
    ...CommandResultIdentity,
    reason: MaintenanceStaleReason,
  }),
])
export type MaintenanceCommandReply = z.infer<typeof MaintenanceCommandReply>

/** Stable occurrence identity: changing any observed row fact creates a new key. */
export function messageExpiryRunKey(observed: MessageExpiryObservation): string {
  const encode = (value: string): string => encodeURIComponent(value)
  return [
    'message-expiry',
    encode(observed.messageId),
    encode(observed.createdAt),
    encode(observed.lifecycle),
    encode(observed.expiresAt ?? 'implicit'),
  ].join('/')
}

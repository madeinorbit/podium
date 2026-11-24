import { createLogger } from '@podium/logger'
import {
  asAgentIdentityId,
  asCapabilityRef,
  asDelegationRef,
  asDeviceId,
  type Principal,
  SYNC_RECOVERY_ID_HEADER,
  SYNC_RECOVERY_REASON_HEADER,
  SYNC_REFUSAL_STATUS,
  type SyncRecoveryReason,
  syncRecoveryReason,
} from '@podium/protocol'
import type { AuthorityPort } from '@podium/sync'
import type { CommandPrincipal } from '../command-principal'
import type { FeedServing } from '../gateway/feed-serving'

/** One namespace for both halves of the route's story: the INFO transfer line
 *  below, and the DEBUG line `routes.ts` emits when one bootstrap supersedes
 *  another (POD-4071 — that is how a `cancelled` transfer names its successor). */
export const transferLog = createLogger('sync-http')

export interface SyncDeltaPorts {
  authority: Pick<AuthorityPort, 'captureHead' | 'changesRange'>
  serving: Pick<FeedServing, 'identity' | 'retentionFloor' | 'accessMovedAfter'>
}

/** Shared with tRPC: transport authentication supplies identity, never query fields. */
export function syncFeedPrincipal(principal: CommandPrincipal | undefined): Principal | undefined {
  if (principal?.kind === 'user')
    return {
      kind: 'user',
      user: principal.user,
      device: asDeviceId(`trpc:${principal.user}`),
      capability: asCapabilityRef(`trpc:user:${principal.user}`),
    }
  if (principal?.kind === 'agent')
    return {
      kind: 'agent',
      agentIdentity: asAgentIdentityId(principal.agentSessionId),
      onBehalfOf: principal.onBehalfOf,
      device: asDeviceId(`trpc:${principal.agentSessionId}`),
      capability: asCapabilityRef(`trpc:agent:${principal.agentSessionId}`),
      delegation: asDelegationRef(`session:${principal.agentSessionId}`),
    }
  return undefined
}

export { negotiateContentCoding, syncResponseHeaders } from './content-coding'

/** The same refusal vocabulary is shared by both HTTP sync handlers. */
export function syncRefusal(kind: keyof typeof SYNC_REFUSAL_STATUS, reason: string): Response {
  const status = SYNC_REFUSAL_STATUS[kind]
  return Response.json(
    kind === 'bootstrapRequired' ? { kind: 'bootstrap-required', reason } : { error: reason },
    {
      status,
      headers: status === 503 ? { 'Retry-After': '5' } : undefined,
    },
  )
}

export interface SyncTransferMetrics {
  mode: 'bootstrap' | 'delta' | 'partial-reload'
  clientRecoveryId: string | null
  recoveryReason: SyncRecoveryReason
  transferId: string
  principal: string
  coding: string
  startedAt: number
  captureMs: number
  firstByteMs?: number
  bytesIn: number
  bytesOut: number
  rows: number
  records: number
  outcome: string
  err?: unknown
}

/** Client-supplied observability is bounded and never interpreted as identity.
 * Legacy/malformed headers are ignored; arbitrary text never reaches the log. */
export function syncRecoveryContext(
  request: Request,
): Pick<SyncTransferMetrics, 'clientRecoveryId' | 'recoveryReason'> {
  const candidate = request.headers.get(SYNC_RECOVERY_ID_HEADER)
  return {
    clientRecoveryId:
      candidate !== null &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate)
        ? candidate
        : null,
    recoveryReason: syncRecoveryReason(
      request.headers.get(SYNC_RECOVERY_REASON_HEADER) ?? undefined,
    ),
  }
}

export function logSyncTransfer(metrics: SyncTransferMetrics): void {
  const { startedAt, ...fields } = metrics
  transferLog.info('sync transfer finished', {
    ...fields,
    firstByteMs: fields.firstByteMs ?? null,
    totalMs: performance.now() - startedAt,
  })
}

/** Zero read-ahead: observe the existing bounded pipe, never queue another page. */
export function observeSyncTransfer(
  body: ReadableStream<Uint8Array>,
  metrics: SyncTransferMetrics,
  onFinish: () => void = () => logSyncTransfer(metrics),
): ReadableStream<Uint8Array> {
  const reader = body.getReader()
  let finished = false
  const finish = () => {
    if (finished) return
    finished = true
    onFinish()
  }
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const next = await reader.read()
          if (next.done) {
            finish()
            controller.close()
            return
          }
          metrics.firstByteMs ??= performance.now() - metrics.startedAt
          metrics.bytesOut += next.value.byteLength
          controller.enqueue(next.value)
        } catch (err) {
          metrics.outcome = 'stream-failed'
          metrics.err = err
          finish()
          controller.error(err)
        }
      },
      async cancel(reason) {
        metrics.outcome = 'cancelled'
        try {
          await reader.cancel(reason)
        } finally {
          finish()
        }
      },
    },
    { highWaterMark: 0 },
  )
}

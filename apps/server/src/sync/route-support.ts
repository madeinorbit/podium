import { createLogger } from '@podium/logger'
import { SYNC_REFUSAL_STATUS } from '@podium/protocol'
import { asAgentIdentityId, asCapabilityRef, asDelegationRef, asDeviceId, type Principal } from '@podium/protocol'
import type { CommandPrincipal } from '../command-principal'
import type { AuthorityPort } from '@podium/sync'
import type { FeedServing } from '../gateway/feed-serving'

const transferLog = createLogger('sync-http')

export interface SyncDeltaPorts {
  authority: Pick<AuthorityPort, 'captureHead' | 'changesRange'>
  serving: Pick<FeedServing, 'identity' | 'retentionFloor'>
}

/** Shared with tRPC: transport authentication supplies identity, never query fields. */
export function syncFeedPrincipal(principal: CommandPrincipal | undefined): Principal | undefined {
  if (principal?.kind === 'user') return {
    kind: 'user', user: principal.user,
    device: asDeviceId(`trpc:${principal.user}`),
    capability: asCapabilityRef(`trpc:user:${principal.user}`),
  }
  if (principal?.kind === 'agent') return {
    kind: 'agent', agentIdentity: asAgentIdentityId(principal.agentSessionId),
    onBehalfOf: principal.onBehalfOf,
    device: asDeviceId(`trpc:${principal.agentSessionId}`),
    capability: asCapabilityRef(`trpc:agent:${principal.agentSessionId}`),
    delegation: asDelegationRef(`session:${principal.agentSessionId}`),
  }
  return undefined
}

export { negotiateContentCoding, syncResponseHeaders } from './content-coding'

/** The same refusal vocabulary is shared by both HTTP sync handlers. */
export function syncRefusal(
  kind: keyof typeof SYNC_REFUSAL_STATUS,
  reason: string,
): Response {
  const status = SYNC_REFUSAL_STATUS[kind]
  return Response.json(kind === 'bootstrapRequired'
    ? { kind: 'bootstrap-required', reason } : { error: reason }, {
    status,
    headers: status === 503 ? { 'Retry-After': '5' } : undefined,
  })
}

export interface SyncTransferMetrics {
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

/** Zero read-ahead: observe the existing bounded pipe, never queue another page. */
export function observeSyncTransfer(body: ReadableStream<Uint8Array>, metrics: SyncTransferMetrics): ReadableStream<Uint8Array> {
  const reader = body.getReader()
  let finished = false
  const finish = () => {
    if (finished) return
    finished = true
    const { startedAt, ...fields } = metrics
    transferLog.info('sync transfer finished', { ...fields, totalMs: performance.now() - startedAt })
  }
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read()
        if (next.done) { finish(); controller.close(); return }
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
      try { await reader.cancel(reason) } finally { finish() }
    },
  }, { highWaterMark: 0 })
}

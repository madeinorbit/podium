import type { OneTimeCodeOperations } from '@podium/identity'
import type { UserId } from '@podium/model'

/**
 * Short-lived delivery state for a move. The code hashes are in the portable
 * database; plaintext is held here only until the source tells its sockets
 * where to go. A restarted source cannot recover a plaintext claim.
 */
export function clientRelocations(deps: {
  /** Read when a move uses it: the server opens its identity after the registry. */
  codes?: () => OneTimeCodeOperations
  clients: () => Iterable<{ id: string; principal: { user: UserId } }>
  accountFor: (memberId: UserId) => Promise<string | null | undefined>
}) {
  const operations = new Map<string, Map<string, { id: string; code: string }>>()
  return {
    async prepare(operationId: string) {
      if (!deps.codes) return
      const codes = deps.codes()
      const claims = operations.get(operationId) ?? new Map<string, { id: string; code: string }>()
      operations.set(operationId, claims)
      for (const client of deps.clients()) {
        if (claims.has(client.id)) continue
        const accountId = await deps.accountFor(client.principal.user)
        if (!accountId) continue
        const { id, code } = await codes.issue({
          purpose: 'transfer-claim',
          accountId,
          createdBy: 'host',
        })
        claims.set(client.id, { id, code })
      }
    },
    async cancel(operationId: string) {
      const claims = operations.get(operationId)
      if (!claims || !deps.codes) return
      const codes = deps.codes()
      for (const { id } of claims.values()) await codes.discardTransferClaim(id)
      operations.delete(operationId)
    },
    take(operationId: string) {
      const claims = operations.get(operationId)
      operations.delete(operationId)
      return (clientId: string) => claims?.get(clientId)?.code
    },
  }
}

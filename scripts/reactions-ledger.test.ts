import { describe, expect, it } from 'vitest'
import { REACTIONS } from '../apps/server/src/composition/reactions'
import { renderReactionsLedger } from './reactions-ledger'

describe('generated reactions ledger', () => {
  it('contains every registered reaction and every operational declaration', () => {
    const ledger = renderReactionsLedger()
    for (const reaction of REACTIONS) {
      expect(ledger).toContain(`\`${reaction.id}\``)
      expect(ledger).toContain(reaction.idempotency.key)
      expect(ledger).toContain(reaction.failureOwner)
      expect(ledger).toContain(reaction.scopeInvariant)
    }
  })
})

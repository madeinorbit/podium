import { describe, expect, it } from 'vitest'
import { harness } from './test-support'

describe('automation commands preserve generic record writes', () => {
  it('decides an approval against the revision shown and edits or removes subscriptions', async () => {
    const h = harness()
    await h.actions.decideApproval('approval', 'approve', 7)
    await h.actions.setSubscriptionEnabled('subscription', false)
    await h.actions.removeSubscription('subscription')
    expect(h.queued).toEqual([
      { kind: 'recordEdit', input: { kind: 'effect', id: 'approval', patch: { decision: 'approve' }, expectedRevision: 7 } },
      { kind: 'recordEdit', input: { kind: 'subscription', id: 'subscription', patch: { enabled: false } } },
      { kind: 'recordRemove', input: { kind: 'subscription', id: 'subscription' } },
    ])
  })
})

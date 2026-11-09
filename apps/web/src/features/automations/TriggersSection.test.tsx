// @vitest-environment happy-dom
import { asClientPrincipal } from '@podium/client-core/principal'
import { StoreProvider } from '@podium/client-core/react'
import { asUserId, subscriptionRowId } from '@podium/model/browser'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { attachWorklistPool } from '@/app/store-worklist-pool'
import type { Trpc } from '@/app/trpc'
import { createAutomationsFixture } from '../../../test/automations-fixture'
import { TriggersSection } from './TriggersSection'

afterEach(cleanup)

/** A session subscription of the fixture's first session, as the feed carries it. */
const subscription = (index: number, sessionId = 'synthetic-session-0') => ({
  id: `sub_${String(index).padStart(3, '0')}`,
  subscriberKind: 'session' as const,
  subscriberId: sessionId,
  event: 'issue.closed',
  sourceKind: 'issue' as const,
  sourceRef: `iss_src_${index}`,
  deliverNudge: true,
  deliverNotify: false,
  origin: 'custom' as const,
  enabled: index % 2 === 0,
  createdAt: `2026-10-01T00:00:${String(index % 60).padStart(2, '0')}.000Z`,
})

function setup(subs: ReturnType<typeof subscription>[]) {
  const fixture = createAutomationsFixture()
  for (const sub of subs) {
    const id = subscriptionRowId(sub.subscriberKind, sub.subscriberId, sub.id)
    fixture.records.set(`subscription:${id}`, {
      entity: 'subscription',
      entityId: id,
      value: sub,
      provenance: { seq: 1 },
    } as never)
  }
  const list = vi.fn()
  Object.assign(fixture.api, { issues: { subscriptionList: { query: list } } })
  const fatal = vi.fn()
  const principal = asClientPrincipal(asUserId('triggers-test'))
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <StoreProvider
        principal={principal}
        config={{ httpOrigin: 'http://offline.invalid', wsClientUrl: 'ws://offline.invalid' }}
        api={fixture.api}
        createReplicaFn={() => fixture.newReplica()}
        networkEnabled={false}
        onFatalError={fatal}
        attachRuntime={(runtime) => {
          fixture.bindHub(runtime.hub)
          return attachWorklistPool(runtime, fatal)
        }}
      >
        {children}
      </StoreProvider>
    )
  }
  return { fixture, list, fatal, Wrapper }
}

describe('TriggersSection', () => {
  it('lists my subscriptions from the pool, each with its state, and asks for no list (POD-6676)', async () => {
    const { list, fatal, Wrapper } = setup(Array.from({ length: 5 }, (_, index) => subscription(index)))
    render(
      <Wrapper>
        <TriggersSection trpc={{} as Trpc} />
      </Wrapper>,
    )
    await waitFor(() => expect(screen.getAllByRole('switch')).toHaveLength(5))
    const states = screen.getAllByRole('switch').map((toggle) => toggle.getAttribute('aria-checked'))
    expect(states).toEqual(['true', 'false', 'true', 'false', 'true'])
    // The records arrive on the feed: the old paged request is never made.
    expect(list).not.toHaveBeenCalled()
    expect(fatal).not.toHaveBeenCalled()
  })
})

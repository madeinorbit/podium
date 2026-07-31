/**
 * THE BROWSER'S SHIPPING STORE IS ONLY ADOPTED WHEN ATTRIBUTION IS CERTAIN (POD-1252).
 *
 * POD-1239 found this the sharpest of the six unattributed sites: a plain browser
 * with the kernel flag off passed no factory, the engine called `createReplica()`
 * with no argument, and the replica resolved `window.localStorage` itself — so the
 * SHIPPING path adopted whatever the last person on the device left behind, every
 * boot. That issue built this file's home and deliberately left the gate uncalled;
 * this is the call.
 *
 * WHY THE REFUSAL ARM IS THE WHOLE TEST. The default evidence on this tree is
 * `single-account`, which always adopts — so a suite that only ever presented the
 * default would pass against a root with no gate at all. That is exactly how the
 * original six survived being built, verified and merged.
 *
 * AND WHY THE COUNTERFACTUAL IS NOT OPTIONAL. Three refusal arms asserting a
 * warning would pass against a discard that quietly did nothing, and POD-1220
 * proved the count can reach zero with the property still absent: on their root,
 * entities and cursor were retired unconditionally either way, so the gate had a
 * caller and no effect. Here the discard is the effect, so it is measured the only
 * way that distinguishes it — re-open the SAME store and require the rows to be
 * GONE, with the adopting re-open beside it to prove they would otherwise be there.
 */

import type { StorageApi } from '@podium/client-core/replica'
import type { IssueWire } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { createWebReplica } from './webReplica'

/** Map-backed store standing in for `window.localStorage`, so "the same store,
 *  re-opened" is a thing a test can hold rather than a global to clean up. */
function deviceStorage(): StorageApi {
  const data = new Map<string, string>()
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  }
}

const issue = (id: string): IssueWire => ({ id, title: id }) as unknown as IssueWire

const UNKNOWN = { kind: 'unknown' } as const
const SOLE_OPERATOR = { kind: 'single-account', principal: 'default' } as const

interface Opened {
  readonly replica: ReturnType<typeof createWebReplica>
  readonly discarded: { reason: string; redactedCount: number }[]
}

function open(
  storage: StorageApi,
  evidence: Parameters<typeof createWebReplica>[0] extends undefined
    ? never
    : NonNullable<Parameters<typeof createWebReplica>[0]>['evidence'],
): Opened {
  const discarded: { reason: string; redactedCount: number }[] = []
  const replica = createWebReplica({
    storage,
    evidence,
    now: () => 1_700_000_000_000,
    onDiscarded: (detail) => discarded.push(detail),
  })
  return { replica, discarded }
}

/** Seed a store the way a previous person would have left it. */
async function seed(storage: StorageApi): Promise<void> {
  const { replica } = open(storage, SOLE_OPERATOR)
  replica.applySnapshot('issues', [issue('iss_previous')])
  replica.setCursor(4211)
  replica.uiState().set('podium.view', 'home')
  await replica.flush()
}

describe('the web replica store is only adopted when attribution is CERTAIN', () => {
  it('ADOPTS under the shared-password grade — no identities exist, so the store is the operator’s', () => {
    const { discarded } = open(deviceStorage(), SOLE_OPERATOR)
    expect(discarded).toEqual([])
  })

  it('REFUSES when nobody could say who the store belongs to', () => {
    const { discarded } = open(deviceStorage(), UNKNOWN)
    expect(discarded).toEqual([{ reason: 'discarded-identity-unknown', redactedCount: 0 }])
  })

  it('REFUSES a device that has held sessions for someone else', () => {
    const { discarded } = open(deviceStorage(), {
      kind: 'multi-user',
      signedInAs: 'alice',
      identitiesEverSignedIn: ['alice', 'bob'],
    })
    expect(discarded).toEqual([{ reason: 'discarded-multiple-identities', redactedCount: 0 }])
  })

  it('REFUSES a ledger that does not name the signed-in user', () => {
    const { discarded } = open(deviceStorage(), {
      kind: 'multi-user',
      signedInAs: 'alice',
      identitiesEverSignedIn: ['bob'],
    })
    expect(discarded).toEqual([{ reason: 'discarded-foreign-identity', redactedCount: 0 }])
  })

  it('ADOPTS when the device has only ever been this user — the certainty the rule allows', () => {
    const { discarded } = open(deviceStorage(), {
      kind: 'multi-user',
      signedInAs: 'alice',
      identitiesEverSignedIn: ['alice'],
    })
    expect(discarded).toEqual([])
  })

  it('DISCARDS THE ROWS on a refusal — the store re-bootstraps instead of serving them', async () => {
    // The assertion that makes the refusal real rather than cosmetic: a warning
    // that left the rows in place would satisfy every case above and none of the
    // privacy rule.
    const storage = deviceStorage()
    await seed(storage)

    const { replica } = open(storage, UNKNOWN)
    expect(replica.rows('issues')).toEqual([])
    expect(replica.getCursor()).toBeNull()
  })

  it('…and the SAME store IS still there when attribution succeeds', async () => {
    // The counterfactual for the case above. Without it, a discard that ran
    // unconditionally would pass every assertion in this file.
    const storage = deviceStorage()
    await seed(storage)

    const { replica } = open(storage, SOLE_OPERATOR)
    expect(replica.rows('issues').map((row) => row.id)).toEqual(['iss_previous'])
    expect(replica.getCursor()).toBe(4211)
  })

  it('LEAVES THE LAYOUT ALONE — a discard is not a factory reset', async () => {
    // ADR 6 D1 allows the ui preferences to stay on localStorage and
    // `LEGACY_PREFERENCE_KEYS` records the decision to leave them. Measured, so
    // that a future discard widened to a prefix sweep of `podium.replica.` — which
    // would take the ui-state blob with it — is a red test rather than a surprise.
    const storage = deviceStorage()
    await seed(storage)

    const { replica } = open(storage, UNKNOWN)
    expect(replica.uiState().get('podium.view')).toBe('home')
  })

  it('PARKS the previous person’s queued work — never adopted, never destroyed, always redacted', async () => {
    // ADR 6 D4.3 makes losing a queued entry a correctness bug, and adopting one is
    // the sharpest form of the harm: replayed under the new principal's name it is
    // re-authorized against THEIR rights at drain (ADR 3 D8), which is not a check
    // that can catch it, because they genuinely are allowed to do the thing they now
    // appear to be asking for.
    const storage = deviceStorage()
    const previous = open(storage, SOLE_OPERATOR)
    previous.replica.outboxStorage().save([
      {
        mutationId: 'mut_1',
        kind: 'sessions.rename',
        input: { title: 'the-users-own-words' },
        queuedAt: 10,
      },
    ])
    await previous.replica.flush()

    const next = open(storage, UNKNOWN)
    expect(next.discarded).toEqual([{ reason: 'discarded-identity-unknown', redactedCount: 1 }])
    // Not drainable…
    expect(next.replica.outboxStorage().load()).toEqual([])
    expect(next.replica.outboxAwaitingStorage().load()).toEqual([])
    // …not gone…
    const parked = next.replica.outboxDeadLetterStorage().load()
    expect(parked.map((entry) => entry.mutationId)).toEqual(['mut_1'])
    expect(parked[0]?.state).toBe('dead-letter')
    expect(parked[0]?.deadLetter?.reason).toEqual({ code: 'unauthorized' })
    // …and not readable. The envelope tells the user work was queued here and could
    // not be attributed; it does not show them what it said.
    expect(parked[0]?.input).toBeNull()
    expect(JSON.stringify(parked)).not.toContain('the-users-own-words')
  })
})

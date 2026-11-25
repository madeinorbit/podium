/**
 * A share that races a manage revocation never leaves an edge a re-grant revives
 * (POD-7605). The share command's check and its edge are one write, and so are
 * the revocation's, so the two serialise on either engine: whichever order they
 * meet in, nothing the revoked chain gave comes back when manage is given again.
 */
import { asCredentialId, asUserId, type UserId } from '@podium/model'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CREDENTIAL_COMMANDS_TRPC, type CredentialsState } from '../modules/credentials/commands'
import type { CredentialHealth } from '../modules/credentials/health'
import { mayUse } from '../modules/credentials/may-use'
import type { SessionStore } from '../store'
import { openTestStore } from '../test-support/open-test-store'
import { memberFacts } from './fixtures/test-support'
import type { GrantRow } from './grants'

const OWNER = asUserId('race-owner')
const MANAGER = asUserId('race-manager')
const DELEGATE = asUserId('race-delegate')
const READER = asUserId('race-reader')
const KEY = asCredentialId('cred_share-revocation-race')
const credential = { id: KEY, ownerUserId: OWNER }

/** Long enough for an unserialised revocation to commit; a serialised one cannot. */
const WINDOW_MS = 150

const edge = (owner: string, grantee: string, verb: 'use' | 'manage'): GrantRow => ({
  resourceKind: 'credential',
  resourceId: KEY,
  grantee,
  verb,
  owner,
  visibility: 'secret',
  createdAt: '2026-11-25T00:00:00.000Z',
  actorKind: 'user',
  actorId: owner,
  onBehalfOf: owner,
})

/** Sessions and notices are not under test: the health hooks do nothing. */
const health = {
  afterShare: async () => {},
  afterWithdraw: async () => {},
} as unknown as CredentialHealth

const as = (store: SessionStore, callerUserId: UserId): CredentialsState => ({
  store,
  callerUserId,
  health,
})

const share = (store: SessionStore, by: UserId, to: UserId, verb: 'use' | 'manage') =>
  CREDENTIAL_COMMANDS_TRPC.share.handler(as(store, by), {
    credentialId: KEY,
    grantee: { userId: to },
    verb,
    acknowledgeDisclosure: true,
    acknowledgeWarning: true,
  }) as Promise<unknown>

const unshare = (store: SessionStore, by: UserId, from: UserId, verb: 'use' | 'manage') =>
  CREDENTIAL_COMMANDS_TRPC.unshare.handler(as(store, by), {
    credentialId: KEY,
    grantee: { userId: from },
    verb,
  }) as Promise<unknown>

/** A gate the spied write waits at: `reached` once it is there, `open()` lets it on. */
function gate(): {
  reached: Promise<void>
  arrive: () => void
  open: () => void
  opened: Promise<void>
} {
  let arrive = () => {}
  let open = () => {}
  const reached = new Promise<void>((resolve) => {
    arrive = resolve
  })
  const opened = new Promise<void>((resolve) => {
    open = resolve
  })
  return { reached, arrive, open, opened }
}

/** Whether `call` settles inside the window: a serialised write must not. */
async function settlesWithin(call: Promise<unknown>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const waited = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), WINDOW_MS)
  })
  const settled = call.then(
    () => true as const,
    () => true as const,
  )
  try {
    return await Promise.race([settled, waited])
  } finally {
    clearTimeout(timer)
  }
}

async function outcome(call: Promise<unknown>): Promise<string> {
  try {
    await call
    return 'applied'
  } catch (error) {
    return (error as { code?: string }).code ?? String(error)
  }
}

/** The owner gives manage again, to the revoked manager and to the delegate directly. */
async function regrant(store: SessionStore): Promise<void> {
  expect(await outcome(share(store, OWNER, MANAGER, 'manage'))).toBe('applied')
  expect(await outcome(share(store, OWNER, DELEGATE, 'manage'))).toBe('applied')
  expect(await mayUse(store, MANAGER, credential)).toBe('manage')
  expect(await mayUse(store, DELEGATE, credential)).toBe('manage')
}

describe('a share racing a manage revocation', () => {
  let store: SessionStore

  beforeEach(async () => {
    store = await openTestStore(':memory:')
    await store.credentials.insert({ ...credential, label: 'Team key', type: 'openai.api-key' })
    for (const id of [OWNER, MANAGER, DELEGATE, READER]) {
      await memberFacts(store).create(
        {
          id,
          displayName: id,
          role: 'member',
          createdAt: '2026-11-25T00:00:00.000Z',
          disabledAt: null,
        },
        'not-a-real-hash',
      )
    }
    // OWNER gives MANAGER manage, and MANAGER gives DELEGATE manage.
    await store.grants.upsert(edge(OWNER, MANAGER, 'manage'))
    await store.grants.upsert(edge(MANAGER, DELEGATE, 'manage'))
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    await store.close()
  })

  it.each([
    'use',
    'manage',
  ] as const)('checked first: the revocation waits for the %s share and its cascade ends it', async (verb) => {
    // DELEGATE's share has passed its check and is about to write its edge.
    const at = gate()
    const upsert = store.grants.upsert.bind(store.grants)
    vi.spyOn(store.grants, 'upsert').mockImplementationOnce(async (row) => {
      at.arrive()
      await at.opened
      await upsert(row)
    })
    const shared = share(store, DELEGATE, READER, verb)
    await at.reached
    // OWNER revokes MANAGER's manage now. It must wait for the share's write.
    const revoked = unshare(store, OWNER, MANAGER, 'manage')
    expect(await settlesWithin(revoked)).toBe(false)
    at.open()
    expect(await outcome(shared)).toBe('applied')
    expect(await outcome(revoked)).toBe('applied')

    // The cascade ended the share it waited for: no edge from the chain stands.
    expect(await store.grants.listForResource('credential', KEY)).toEqual([])
    await regrant(store)
    expect(await mayUse(store, READER, credential)).toBeNull()

    // The audit names what the cascade ended, and who had given it.
    const [unshared] = (await store.settingsAudit.list()).filter(
      (row) => row.command === 'credentials.unshare',
    )
    const { detail } = unshared?.detail as { detail: string }
    expect(detail).toMatch(new RegExp(`^manage from ${MANAGER}, and 2 shares given through it: `))
    expect(detail).toContain(`manage from ${DELEGATE} (given by ${MANAGER})`)
    expect(detail).toContain(`${verb} from ${READER} (given by ${DELEGATE})`)
  })

  it.each([
    'use',
    'manage',
  ] as const)('revoked first: the %s share waits, then is refused, and nothing returns', async (verb) => {
    // OWNER's revocation has passed its check and is about to delete.
    const at = gate()
    const revoke = store.grants.revoke.bind(store.grants)
    vi.spyOn(store.grants, 'revoke').mockImplementationOnce(async (...args) => {
      at.arrive()
      await at.opened
      return await revoke(...args)
    })
    const revoked = unshare(store, OWNER, MANAGER, 'manage')
    await at.reached
    // DELEGATE shares now. The check must wait for the revocation's write.
    const shared = share(store, DELEGATE, READER, verb)
    expect(await settlesWithin(shared)).toBe(false)
    at.open()
    expect(await outcome(revoked)).toBe('applied')
    // DELEGATE holds nothing any more, so the share finds no such credential.
    expect(await outcome(shared)).toBe('NOT_FOUND')

    expect(await store.grants.listForResource('credential', KEY)).toEqual([])
    await regrant(store)
    expect(await mayUse(store, READER, credential)).toBeNull()
  })

  it('a share and a revocation run concurrently, both orders, leave nothing to revive', async () => {
    for (const first of ['share', 'revoke'] as const) {
      const shared = () => outcome(share(store, DELEGATE, READER, 'use'))
      const revoked = () => outcome(unshare(store, OWNER, MANAGER, 'manage'))
      await Promise.all(first === 'share' ? [shared(), revoked()] : [revoked(), shared()])
      expect(
        (await store.grants.listForResource('credential', KEY)).filter(
          (row) => row.owner !== OWNER,
        ),
      ).toEqual([])
      await regrant(store)
      expect(await mayUse(store, READER, credential)).toBeNull()
      // Set the chain up again for the other order: MANAGER gives DELEGATE manage.
      await store.grants.upsert(edge(MANAGER, DELEGATE, 'manage'))
    }
  })
})

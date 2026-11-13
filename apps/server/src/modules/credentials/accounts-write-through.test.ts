/**
 * THE OLD `accounts.*` COMMANDS CHANGE THE CREDENTIAL AT ONCE (credential
 * management Task 4, coordinator note of 2026-11-13).
 *
 * Launches read credentials only. A key connected, sent, shared, taken back or
 * disconnected through the Settings page's old commands, in a running server,
 * must be what the very next launch reads, with no restart. Each step below is
 * followed by the read the resolver makes: the credential, its secret, its
 * allowed machines and `mayUse`, and then what `resolveSessionAccess` decides for
 * the next launch (acceptance 3: after an unshare the former grantee is refused).
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Capability, CredentialId, UserId } from '@podium/model'
import { asMachineId, asUserId } from '@podium/model'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolvePrincipal } from '../../command-principal'
import { SessionRegistry } from '../../relay'
import { RepoRegistry } from '../../repo-registry'
import { appRouter } from '../../router'
import type { SessionStore } from '../../store'
import { memberFacts } from '../../store/fixtures/test-support'
import { SuperagentService } from '../superagent'
import { resolveSessionAccess } from './access'
import { credentialOfAccount } from './legacy-accounts'
import { mayUse } from './may-use'
import { withSecret } from './vault'

const OWNER = asUserId('user:through-owner')
const CAROL = asUserId('user:through-carol')
const ELSEWHERE = asMachineId('machine:through-elsewhere')
const FIRST = 'FAKE-sk-ant-through-first-6891'
const SECOND = 'FAKE-sk-ant-through-second-6891'
const THIRD = 'FAKE-sk-ant-through-third-6891'

const member = (userId: UserId): Capability => ({
  role: 'worker',
  scope: { kind: 'owned', userId },
  actorUser: userId,
  onBehalfOf: userId,
})

const priorStateDir = process.env.PODIUM_STATE_DIR
let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'podium-cred-through-'))
  process.env.PODIUM_STATE_DIR = dir
})
afterEach(() => {
  process.env.PODIUM_STATE_DIR = priorStateDir
  rmSync(dir, { recursive: true, force: true })
})

async function harness() {
  const registry = await SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
  const repos = new RepoRegistry(registry, registry.sessionStore)
  const superagent = await SuperagentService.create(registry.modules, repos, registry.sessionStore)
  const store = registry.sessionStore
  for (const id of [OWNER, CAROL]) {
    await memberFacts(store).create(
      {
        id,
        displayName: id,
        role: 'member',
        createdAt: new Date().toISOString(),
        disabledAt: null,
      },
      'not-a-real-hash',
    )
  }
  // A machine someone else looks after, which the owner uses.
  await store.machines.upsertMachine({
    id: ELSEWHERE,
    name: 'elsewhere',
    hostname: 'elsewhere.local',
    tokenHash: 'hash-elsewhere',
    ownerUserId: CAROL,
  })
  await store.grants.upsert({
    resourceKind: 'machine',
    resourceId: ELSEWHERE,
    grantee: OWNER,
    verb: 'use',
    owner: CAROL,
    visibility: 'owned-compute',
    createdAt: new Date().toISOString(),
    actorKind: 'user',
    actorId: CAROL,
    onBehalfOf: CAROL,
  })
  const caller = appRouter.createCaller({
    registry,
    repos,
    superagent,
    users: store.users,
    loginRequired: async () => true,
    capability: member(OWNER),
    principal: resolvePrincipal(member(OWNER), { parentSessionOf: () => undefined }),
  })
  return { store, caller }
}

const current = async (store: SessionStore) => {
  const credential = await credentialOfAccount(store, OWNER, 'managed:anthropic')
  return credential
}

const secretOf = (store: SessionStore, id: CredentialId) => withSecret(store, id, async (s) => s)

describe('accounts.* write through to the credential, in a running server', () => {
  it('connect, send, share, unsend, reconnect and disconnect each change what the next launch reads', async () => {
    const { store, caller } = await harness()

    await caller.accounts.connect({ provider: 'anthropic', kind: 'api-key', credential: FIRST })
    const made = await current(store)
    if (!made) throw new Error('connect made no credential')
    expect(made).toMatchObject({ ownerUserId: OWNER, type: 'anthropic.api-key', status: 'ok' })
    expect(await secretOf(store, made.id)).toBe(FIRST)
    expect(await mayUse(store, OWNER, made)).toBe('owner')

    await caller.accounts.send({
      id: 'managed:anthropic',
      machineId: ELSEWHERE,
      acknowledgeSharedMachine: true,
    })
    expect(await store.credentials.isMachineAllowed(made.id, ELSEWHERE)).toBe(true)

    await caller.accounts.share({ id: 'managed:anthropic', everyone: true, users: [] })
    expect(await mayUse(store, CAROL, made)).toBe('use')
    await caller.accounts.share({ id: 'managed:anthropic', everyone: false, users: [CAROL] })
    expect(await mayUse(store, CAROL, made)).toBe('use')
    await caller.accounts.share({ id: 'managed:anthropic', everyone: false, users: [] })
    expect(await mayUse(store, CAROL, made)).toBeNull()

    await caller.accounts.unsend({ id: 'managed:anthropic', machineId: ELSEWHERE })
    expect(await store.credentials.isMachineAllowed(made.id, ELSEWHERE)).toBe(false)

    // A reconnect renews the same credential.
    await caller.accounts.connect({ provider: 'anthropic', kind: 'api-key', credential: SECOND })
    expect((await current(store))?.id).toBe(made.id)
    expect(await secretOf(store, made.id)).toBe(SECOND)

    await caller.accounts.disconnect({ id: 'managed:anthropic' })
    expect(await current(store)).toBeUndefined()
    expect(await store.credentials.get(made.id)).toMatchObject({ status: 'revoked' })
    await expect(secretOf(store, made.id)).rejects.toThrow()

    // Connecting again is a new credential under the old account id.
    await caller.accounts.connect({ provider: 'anthropic', kind: 'api-key', credential: THIRD })
    const again = await current(store)
    expect(again?.id).not.toBe(made.id)
    expect(await secretOf(store, again?.id as CredentialId)).toBe(THIRD)
  })

  it('credentials.add and allowMachine, then remove and disallowMachine, take effect at once', async () => {
    const { store, caller } = await harness()
    const { credentialId } = await caller.credentials.add({
      type: 'openai.api-key',
      label: 'Mine',
      secret: FIRST,
    })
    await caller.credentials.allowMachine({
      credentialId,
      machineId: ELSEWHERE,
      acknowledgeDisclosure: true,
    })
    expect(await store.credentials.isMachineAllowed(credentialId, ELSEWHERE)).toBe(true)
    expect(await secretOf(store, credentialId)).toBe(FIRST)
    await caller.credentials.disallowMachine({ credentialId, machineId: ELSEWHERE })
    expect(await store.credentials.isMachineAllowed(credentialId, ELSEWHERE)).toBe(false)
    await caller.credentials.remove({ credentialId })
    expect(await store.credentials.get(credentialId)).toMatchObject({ status: 'revoked' })
  })
})

/** What the very next launch on `machineId` for `actingUserId` decides. */
const nextLaunch = async (
  store: SessionStore,
  credentialId: CredentialId,
  actingUserId: UserId = OWNER,
  machineId = ELSEWHERE,
) => {
  const plan = await resolveSessionAccess(store, {
    harness: 'claude-code',
    credentialId,
    actingUserId,
    machineId,
  })
  return plan.ok ? `ok ${plan.delivery.kind}` : plan.refusal
}

describe('the next launch reads each change, with no restart', () => {
  it('through accounts.*: connect, send, share, unshare, unsend, disconnect', async () => {
    const { store, caller } = await harness()
    await caller.accounts.connect({ provider: 'anthropic', kind: 'api-key', credential: FIRST })
    const id = (await current(store))?.id as CredentialId
    expect(await nextLaunch(store, id)).toBe('machine-not-allowed')
    await caller.accounts.send({
      id: 'managed:anthropic',
      machineId: ELSEWHERE,
      acknowledgeSharedMachine: true,
    })
    expect(await nextLaunch(store, id)).toBe('ok env')
    await caller.accounts.share({ id: 'managed:anthropic', everyone: true, users: [] })
    expect(await nextLaunch(store, id, CAROL)).toBe('ok env')
    await caller.accounts.share({ id: 'managed:anthropic', everyone: false, users: [] })
    expect(await nextLaunch(store, id, CAROL)).toBe('not-yours')
    await caller.accounts.unsend({ id: 'managed:anthropic', machineId: ELSEWHERE })
    expect(await nextLaunch(store, id)).toBe('machine-not-allowed')
    await caller.accounts.send({
      id: 'managed:anthropic',
      machineId: ELSEWHERE,
      acknowledgeSharedMachine: true,
    })
    await caller.accounts.disconnect({ id: 'managed:anthropic' })
    expect(await nextLaunch(store, id)).toBe('revoked')
  })

  it('through credentials.*: add, allowMachine, share, unshare (acceptance 3), disallowMachine, remove', async () => {
    const { store, caller } = await harness()
    const { credentialId } = await caller.credentials.add({
      type: 'anthropic.api-key',
      label: 'Mine',
      secret: FIRST,
    })
    expect(await nextLaunch(store, credentialId)).toBe('machine-not-allowed')
    await caller.credentials.allowMachine({
      credentialId,
      machineId: ELSEWHERE,
      acknowledgeDisclosure: true,
    })
    expect(await nextLaunch(store, credentialId)).toBe('ok env')
    await caller.credentials.share({
      credentialId,
      grantee: { userId: CAROL },
      verb: 'use',
      acknowledgeDisclosure: true,
    })
    expect(await nextLaunch(store, credentialId, CAROL)).toBe('ok env')
    await caller.credentials.unshare({ credentialId, grantee: { userId: CAROL } })
    expect(await nextLaunch(store, credentialId, CAROL)).toBe('not-yours')
    await caller.credentials.share({
      credentialId,
      grantee: 'all-members',
      verb: 'use',
      acknowledgeDisclosure: true,
    })
    expect(await nextLaunch(store, credentialId, CAROL)).toBe('ok env')
    await caller.credentials.disallowMachine({ credentialId, machineId: ELSEWHERE })
    expect(await nextLaunch(store, credentialId)).toBe('machine-not-allowed')
    await caller.credentials.remove({ credentialId })
    expect(await nextLaunch(store, credentialId)).toBe('revoked')
  })
})

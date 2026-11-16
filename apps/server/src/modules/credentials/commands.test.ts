/**
 * THE CREDENTIAL COMMANDS ON THE RUNNING ROUTER (credential management Task 4).
 *
 * Acceptance 1: who may run which command. Acceptance 2: sharing needs the
 * acknowledgements and a grant to all members reaches a second member.
 * Acceptance 6: allowing a machine. Plus the edges the plan's review focus names.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CREDENTIAL_CONTRACT_NAMES, type CredentialContractName } from '@podium/commands'
import type { Capability, CredentialId, UserId } from '@podium/model'
import {
  ALL_MEMBERS_GRANTEE,
  asIssueId,
  asMachineId,
  asSessionId,
  asUserId,
  CREDENTIAL_TYPE_IDS,
  CREDENTIAL_TYPES,
  firstAdminMemberId,
} from '@podium/model'
import { TRPCError } from '@trpc/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolvePrincipal } from '../../command-principal'
import { SessionRegistry } from '../../relay'
import { RepoRegistry } from '../../repo-registry'
import { appRouter } from '../../router'
import type { SessionStore } from '../../store'
import { memberFacts } from '../../store/fixtures/test-support'
import { OPERATOR } from '../../test-support/capabilities'
import { acceptingProviderFetch } from '../../test-support/fake-provider'
import { SuperagentService } from '../superagent'
import { mayUse } from './may-use'
import { sealCredentialSecret, withSecret } from './vault'

const OWNER = asUserId('user:cred-owner')
const MANAGER = asUserId('user:cred-manager')
const USER = asUserId('user:cred-user')
const STRANGER = asUserId('user:cred-stranger')
const CAROL = asUserId('user:cred-carol')
const MACHINE = asMachineId('machine:cred-elsewhere')
const ORIGINAL = 'FAKE-sk-ant-original-6891'

const member = (userId: UserId): Capability => ({
  role: 'worker',
  scope: { kind: 'owned', userId },
  actorUser: userId,
  onBehalfOf: userId,
})

/** A relayed agent session acting for the owner, as `capabilityForSession` mints it. */
const AGENT_FOR_OWNER: Capability = {
  role: 'worker',
  scope: { kind: 'subtree', rootId: asIssueId('iss_cred_commands') },
  actorSessionId: asSessionId('ses_cred_commands'),
  onBehalfOf: OWNER,
}

interface Harness {
  store: SessionStore
  as: (capability: Capability) => ReturnType<typeof appRouter.createCaller>
  credentialId: CredentialId
}

async function harness(type: string = 'anthropic.api-key'): Promise<Harness> {
  const registry = await SessionRegistry.create(undefined, undefined, {
    instanceId: 'default',
    // Adding a key asks its provider; a test never reaches a real one (Task 13).
    credentialProviderFetch: acceptingProviderFetch,
  })
  const repos = new RepoRegistry(registry, registry.sessionStore)
  const superagent = await SuperagentService.create(registry.modules, repos, registry.sessionStore)
  const store = registry.sessionStore
  for (const id of [OWNER, MANAGER, USER, STRANGER, CAROL]) {
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
  await store.machines.upsertMachine({
    id: MACHINE,
    name: 'elsewhere',
    hostname: 'elsewhere.local',
    tokenHash: 'hash-elsewhere',
    ownerUserId: STRANGER,
  })
  const record = await store.credentials.insert({ ownerUserId: OWNER, label: 'Team key', type })
  await sealCredentialSecret(store, record, ORIGINAL, 0)
  const edge = (grantee: string, verb: 'use' | 'manage') => ({
    resourceKind: 'credential',
    resourceId: record.id,
    grantee,
    verb,
    owner: OWNER,
    visibility: 'secret',
    createdAt: new Date().toISOString(),
    actorKind: 'user',
    actorId: OWNER,
    onBehalfOf: OWNER,
  })
  await store.grants.upsert(edge(MANAGER, 'manage'))
  await store.grants.upsert(edge(USER, 'use'))
  const as = (capability: Capability) =>
    appRouter.createCaller({
      registry,
      repos,
      superagent,
      users: store.users,
      loginRequired: async () => true,
      capability,
      principal: resolvePrincipal(capability, { parentSessionOf: () => undefined }),
    })
  return { store, as, credentialId: record.id }
}

async function outcomeOf(call: Promise<unknown>): Promise<string> {
  try {
    await call
    return 'applied'
  } catch (error) {
    if (error instanceof TRPCError) return error.code
    throw error
  }
}

async function refusal(call: Promise<unknown>): Promise<TRPCError> {
  try {
    await call
  } catch (error) {
    if (error instanceof TRPCError) return error
    throw error
  }
  throw new Error('expected a refusal')
}

/** One call of each command against the shared credential. */
function invoke(
  caller: ReturnType<Harness['as']>,
  name: CredentialContractName,
  credentialId: CredentialId,
): Promise<unknown> {
  switch (name) {
    case 'add':
      return caller.credentials.add({
        type: 'openai.api-key',
        label: 'Mine',
        secret: 'FAKE-sk-table-add-6891',
      })
    case 'rename':
      return caller.credentials.rename({ credentialId, label: 'Renamed' })
    case 'renew':
      return caller.credentials.renew({ credentialId, secret: 'FAKE-sk-ant-renewed-6891' })
    case 'remove':
      return caller.credentials.remove({ credentialId })
    case 'share':
      return caller.credentials.share({
        credentialId,
        grantee: { userId: CAROL },
        verb: 'use',
        acknowledgeDisclosure: true,
      })
    case 'unshare':
      return caller.credentials.unshare({ credentialId, grantee: { userId: USER }, verb: 'use' })
    case 'allowMachine':
      return caller.credentials.allowMachine({
        credentialId,
        machineId: MACHINE,
        acknowledgeDisclosure: true,
      })
    case 'disallowMachine':
      return caller.credentials.disallowMachine({ credentialId, machineId: MACHINE })
    case 'chatgptSignInStart':
      return caller.credentials.chatgptSignInStart({ label: 'Mine' })
    case 'chatgptSignInComplete':
      return caller.credentials.chatgptSignInComplete({
        attemptId: 'chatgpt_not-an-attempt',
        pastedUrl: 'http://127.0.0.1:1455/auth/callback?code=FAKE-code&state=FAKE-state',
      })
  }
}

const priorStateDir = process.env.PODIUM_STATE_DIR
let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'podium-cred-commands-'))
  process.env.PODIUM_STATE_DIR = dir
})
afterEach(() => {
  process.env.PODIUM_STATE_DIR = priorStateDir
  rmSync(dir, { recursive: true, force: true })
})

type Who = 'owner' | 'manage' | 'use' | 'no grant' | 'admin, not owner'
const CAPABILITY: Record<Who, Capability> = {
  owner: member(OWNER),
  manage: member(MANAGER),
  use: member(USER),
  'no grant': member(STRANGER),
  'admin, not owner': OPERATOR,
}
const WRITES_ON_TARGET: Record<Who, string> = {
  owner: 'applied',
  manage: 'applied',
  use: 'FORBIDDEN',
  'no grant': 'NOT_FOUND',
  'admin, not owner': 'NOT_FOUND',
}

describe('acceptance 1: who may run which command', () => {
  const rows = (Object.keys(CAPABILITY) as Who[]).flatMap((who) =>
    CREDENTIAL_CONTRACT_NAMES.map((name) => ({
      who,
      name,
      // `add` and a ChatGPT sign-in name no credential: every person may add
      // their own. Completing an attempt nobody started is refused for all.
      expected:
        name === 'add' || name === 'chatgptSignInStart'
          ? 'applied'
          : name === 'chatgptSignInComplete'
            ? 'BAD_REQUEST'
            : WRITES_ON_TARGET[who],
    })),
  )

  it.each(rows)('$who → credentials.$name: $expected', async ({ who, name, expected }) => {
    const { as, credentialId } = await harness()
    expect(await outcomeOf(invoke(as(CAPABILITY[who]), name, credentialId))).toBe(expected)
  })

  it.each(
    CREDENTIAL_CONTRACT_NAMES,
  )('an agent acting for the owner is refused credentials.%s, and nothing changes', async (name) => {
    const { store, as, credentialId } = await harness()
    const before = await store.credentials.listVisibleTo(OWNER)
    expect(await outcomeOf(invoke(as(AGENT_FOR_OWNER), name, credentialId))).toBe('FORBIDDEN')
    expect(await store.credentials.listVisibleTo(OWNER)).toEqual(before)
    expect(await withSecret(store, credentialId, async (s) => s)).toBe(ORIGINAL)
    expect((await store.grants.listForResource('credential', credentialId)).length).toBe(2)
    expect(await store.credentials.isMachineAllowed(credentialId, MACHINE)).toBe(false)
  })

  it('credentials.list shows each person what they may see, with their access', async () => {
    const { as, credentialId } = await harness()
    const seen = async (who: Who) =>
      (await as(CAPABILITY[who]).credentials.list())
        .filter((view) => view.id === credentialId)
        .map((view) => view.access)
    expect(await seen('owner')).toEqual(['owner'])
    expect(await seen('manage')).toEqual(['manage'])
    expect(await seen('use')).toEqual(['use'])
    expect(await seen('no grant')).toEqual([])
    expect(await seen('admin, not owner')).toEqual([])
  })

  it('credentials.list tells the owner and a manager whom it is shared with, never a use holder', async () => {
    const { as, credentialId } = await harness()
    await as(member(OWNER)).credentials.share({
      credentialId,
      grantee: 'all-members',
      verb: 'use',
      acknowledgeDisclosure: true,
    })
    const sharedWith = async (who: Who) =>
      (await as(CAPABILITY[who]).credentials.list()).find((view) => view.id === credentialId)
        ?.sharedWith
    const expected = expect.arrayContaining([
      { grantee: { userId: MANAGER }, verb: 'manage' },
      { grantee: { userId: USER }, verb: 'use' },
      { grantee: 'all-members', verb: 'use' },
    ])
    expect(await sharedWith('owner')).toEqual(expected)
    expect(await sharedWith('owner')).toHaveLength(3)
    expect(await sharedWith('manage')).toEqual(expected)
    // The use holder sees the row (canary) and no sharing on it.
    const seenByUse = (await as(CAPABILITY.use).credentials.list()).find(
      (view) => view.id === credentialId,
    )
    expect(seenByUse?.access).toBe('use')
    expect(seenByUse).not.toHaveProperty('sharedWith')
  })

  it('the owner can do everything in turn, and the credential ends removed', async () => {
    const { store, as, credentialId } = await harness()
    const owner = as(member(OWNER))
    // Every write on this credential; a ChatGPT sign-in names none (its own tests).
    const onTarget = CREDENTIAL_CONTRACT_NAMES.filter(
      (n) => n !== 'remove' && n !== 'chatgptSignInStart' && n !== 'chatgptSignInComplete',
    )
    for (const name of onTarget) {
      await invoke(owner, name, credentialId)
    }
    expect(await store.credentials.get(credentialId)).toMatchObject({ label: 'Renamed' })
    expect(await withSecret(store, credentialId, async (s) => s)).toBe('FAKE-sk-ant-renewed-6891')
    expect(await mayUse(store, CAROL, { id: credentialId, ownerUserId: OWNER })).toBe('use')
    expect(await mayUse(store, USER, { id: credentialId, ownerUserId: OWNER })).toBeNull()
    await owner.credentials.remove({ credentialId })
    expect(await store.credentials.get(credentialId)).toMatchObject({ status: 'revoked' })
    expect(await store.grants.listForResource('credential', credentialId)).toEqual([])
    expect(await owner.credentials.list()).not.toContainEqual(
      expect.objectContaining({ id: credentialId }),
    )
    const events = (await store.settingsAudit.list(1000)).map((row) => row.command)
    for (const kind of ['add', 'rename', 'renew', 'remove', 'share', 'unshare']) {
      expect(events).toContain(`credentials.${kind}`)
    }
  })
})

describe('acceptance 2: sharing needs the acknowledgements', () => {
  it.each(CREDENTIAL_TYPE_IDS)('%s', async (type) => {
    const { as, credentialId } = await harness(type)
    const owner = as(member(OWNER))
    const share = (ack: { acknowledgeDisclosure: boolean; acknowledgeWarning?: boolean }) =>
      owner.credentials.share({ credentialId, grantee: { userId: CAROL }, verb: 'use', ...ack })
    expect((await refusal(share({ acknowledgeDisclosure: false }))).code).toBe('BAD_REQUEST')
    if (CREDENTIAL_TYPES[type].sharing === 'warn') {
      const refused = await refusal(share({ acknowledgeDisclosure: true }))
      expect(refused.code).toBe('BAD_REQUEST')
      expect(refused.message).toMatch(/provider/)
      await share({ acknowledgeDisclosure: true, acknowledgeWarning: true })
    } else {
      await share({ acknowledgeDisclosure: true })
    }
    expect(await outcomeOf(share({ acknowledgeDisclosure: true, acknowledgeWarning: true }))).toBe(
      'applied',
    )
  })

  it('a grant to all members makes the credential usable by a second member', async () => {
    const { store, as, credentialId } = await harness()
    const credential = { id: credentialId, ownerUserId: OWNER }
    expect(await mayUse(store, CAROL, credential)).toBeNull()
    await as(member(OWNER)).credentials.share({
      credentialId,
      grantee: 'all-members',
      verb: 'use',
      acknowledgeDisclosure: true,
    })
    expect(await mayUse(store, CAROL, credential)).toBe('use')
    const edges = await store.grants.listForResource('credential', credentialId)
    expect(edges.map((e) => e.grantee)).toContain(ALL_MEMBERS_GRANTEE)
    expect((await as(member(CAROL)).credentials.list()).map((v) => v.id)).toContain(credentialId)
  })
})

describe('acceptance 6: allowing a machine', () => {
  it('needs the acknowledgement', async () => {
    const { store, as, credentialId } = await harness()
    const refused = await refusal(
      as(member(OWNER)).credentials.allowMachine({
        credentialId,
        machineId: MACHINE,
        acknowledgeDisclosure: false,
      }),
    )
    expect(refused.code).toBe('BAD_REQUEST')
    expect(await store.credentials.isMachineAllowed(credentialId, MACHINE)).toBe(false)
  })

  it.each([
    ['owner', member(OWNER), 'applied'],
    ['manage', member(MANAGER), 'applied'],
    ['use', member(USER), 'FORBIDDEN'],
    ['no grant', member(STRANGER), 'NOT_FOUND'],
  ] as const)('%s: %s', async (_who, capability, expected) => {
    const { store, as, credentialId } = await harness()
    expect(await outcomeOf(invoke(as(capability), 'allowMachine', credentialId))).toBe(expected)
    expect(await store.credentials.isMachineAllowed(credentialId, MACHINE)).toBe(
      expected === 'applied',
    )
  })

  it('needs an enrolled machine: unknown and revoked machines are refused', async () => {
    const { store, as, credentialId } = await harness()
    const owner = as(member(OWNER))
    const allow = (machineId: string) =>
      owner.credentials.allowMachine({
        credentialId,
        machineId: asMachineId(machineId),
        acknowledgeDisclosure: true,
      })
    expect((await refusal(allow('machine:nowhere'))).code).toBe('NOT_FOUND')
    await store.machines.revokeMachine(MACHINE)
    expect((await refusal(allow(MACHINE))).code).toBe('NOT_FOUND')
    expect(await store.credentials.isMachineAllowed(credentialId, MACHINE)).toBe(false)
  })
})

describe('review focus', () => {
  it('manage cannot go to all members', async () => {
    const { store, as, credentialId } = await harness()
    const refused = await refusal(
      as(member(OWNER)).credentials.share({
        credentialId,
        grantee: 'all-members',
        verb: 'manage',
        acknowledgeDisclosure: true,
      }),
    )
    expect(refused.code).toBe('BAD_REQUEST')
    expect(await mayUse(store, CAROL, { id: credentialId, ownerUserId: OWNER })).toBeNull()
  })

  it.each([
    ['the owner', OWNER],
    ['an unknown person', asUserId('user:nobody-6891')],
  ])('sharing with %s is refused', async (_who, userId) => {
    const { as, credentialId } = await harness()
    const refused = await refusal(
      as(member(OWNER)).credentials.share({
        credentialId,
        grantee: { userId },
        verb: 'use',
        acknowledgeDisclosure: true,
      }),
    )
    expect(refused.code).toBe('BAD_REQUEST')
  })

  it('sharing with a disabled member is refused', async () => {
    const { store, as, credentialId } = await harness()
    await memberFacts(store).disable(CAROL, new Date().toISOString())
    expect((await refusal(invoke(as(member(OWNER)), 'share', credentialId))).code).toBe(
      'BAD_REQUEST',
    )
  })

  it('a removed credential is not found, and cannot be renewed', async () => {
    const { store, as, credentialId } = await harness()
    const owner = as(member(OWNER))
    await owner.credentials.remove({ credentialId })
    expect((await refusal(invoke(owner, 'renew', credentialId))).code).toBe('NOT_FOUND')
    expect(await store.credentials.latestSecret(credentialId)).toBeNull()
  })

  it.each([
    'openai.chatgpt-plan',
    'anthropic.claude-login',
  ])('a %s is not pasted: add and renew are refused', async (type) => {
    const { store, as, credentialId } = await harness(type)
    const owner = as(member(OWNER))
    const added = await refusal(
      owner.credentials.add({ type: type as never, label: 'x', secret: 'FAKE-x-6891' }),
    )
    expect(added.code).toBe('BAD_REQUEST')
    expect((await refusal(invoke(owner, 'renew', credentialId))).code).toBe('BAD_REQUEST')
    expect(await withSecret(store, credentialId, async (s) => s)).toBe(ORIGINAL)
  })

  it('adding the same key twice is refused and names the first', async () => {
    const { as } = await harness()
    const owner = as(member(OWNER))
    const input = { type: 'openai.api-key' as const, label: 'First', secret: 'FAKE-sk-dup-6891' }
    await owner.credentials.add(input)
    const refused = await refusal(owner.credentials.add({ ...input, label: 'Second' }))
    expect(refused.code).toBe('CONFLICT')
    expect(refused.message).toContain('First')
    // Another person may hold the same key as their own.
    expect(await outcomeOf(as(member(CAROL)).credentials.add(input))).toBe('applied')
  })
})

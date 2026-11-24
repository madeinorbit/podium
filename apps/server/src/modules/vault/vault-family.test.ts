/**
 * `vault.status` and `vault.reset` on the running router (POD-6889): admin people
 * only. A member is refused, and so is an agent session acting for an admin.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Capability } from '@podium/model'
import { asIssueId, asSessionId, asUserId, firstAdminMemberId } from '@podium/model'
import { hashPassword } from '@podium/runtime/auth-store'
import { TRPCError } from '@trpc/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolvePrincipal } from '../../command-principal'
import { SessionRegistry } from '../../relay'
import { RepoRegistry } from '../../repo-registry'
import { appRouter } from '../../router'
import { SELF_HOSTED_WORKSPACE_ID } from '../../self-hosted-workspace'
import { memberFacts } from '../../store/fixtures/test-support'
import { OPERATOR } from '../../test-support/capabilities'
import { sealCredentialSecret, withSecret } from '../credentials/vault'
import { SuperagentService } from '../superagent'

const MEMBER = asUserId('user:vault-family-member')
const MEMBER_CAPABILITY: Capability = {
  role: 'worker',
  scope: { kind: 'owned', userId: MEMBER },
  actorUser: MEMBER,
  onBehalfOf: MEMBER,
}

/** A relayed agent acting for the first admin, as `capabilityForSession` mints it. */
const AGENT_FOR_ADMIN: Capability = {
  role: 'worker',
  scope: { kind: 'subtree', rootId: asIssueId('iss_vault_family') },
  actorSessionId: asSessionId('ses_vault_family'),
  onBehalfOf: firstAdminMemberId(),
}

async function harness(capability: Capability) {
  const registry = await SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
  const repos = new RepoRegistry(registry, registry.sessionStore)
  const superagent = await SuperagentService.create(registry.modules, repos, registry.sessionStore)
  const users = registry.sessionStore.users
  await memberFacts(registry.sessionStore).create(
    {
      id: MEMBER,
      displayName: 'Member',
      role: 'member',
      createdAt: new Date().toISOString(),
      disabledAt: null,
    },
    await hashPassword('member-password'),
  )
  const caller = appRouter.createCaller({
    registry,
    repos,
    superagent,
    users,
    loginRequired: async () => true,
    capability,
    principal: resolvePrincipal(SELF_HOSTED_WORKSPACE_ID, capability, {
      parentSessionOf: () => undefined,
    }),
  })
  return { store: registry.sessionStore, caller }
}

async function refusalOf(call: Promise<unknown>): Promise<TRPCError> {
  try {
    await call
  } catch (error) {
    if (error instanceof TRPCError) return error
    throw error
  }
  throw new Error('expected a refusal')
}

const priorStateDir = process.env.PODIUM_STATE_DIR!
let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'podium-vault-family-'))
  process.env.PODIUM_STATE_DIR = dir
})
afterEach(() => {
  process.env.PODIUM_STATE_DIR = priorStateDir
  rmSync(dir, { recursive: true, force: true })
})

describe('vault.status and vault.reset', () => {
  it('an admin reads the status and resets the vault; old credentials need attention, new ones work', async () => {
    const { store, caller } = await harness(OPERATOR)
    const old = await store.credentials.insert({
      ownerUserId: firstAdminMemberId(),
      label: 'Old',
      type: 'anthropic.api-key',
    })
    await sealCredentialSecret(store, old, 'FAKE-sk-old-0001', 0)
    expect(await caller.vault.status()).toMatchObject({ state: 'ready', problem: null })

    expect(await caller.vault.reset({ confirm: true })).toEqual({
      needsAttention: 1,
      state: 'empty',
    })
    expect(await store.credentials.get(old.id)).toMatchObject({ status: 'attention' })
    await expect(withSecret(store, old.id, async (s) => s)).rejects.toThrow(/no stored secret/)

    const fresh = await store.credentials.insert({
      ownerUserId: firstAdminMemberId(),
      label: 'Fresh',
      type: 'openai.api-key',
    })
    expect(await sealCredentialSecret(store, fresh, 'FAKE-sk-fresh-0002', 0)).toBe(1)
    expect(await withSecret(store, fresh.id, async (s) => s)).toBe('FAKE-sk-fresh-0002')

    const events = (await store.settingsAudit.list(1000)).filter(
      (row) => row.command === 'credentials.attention',
    )
    expect(events).toHaveLength(1)
    expect(events[0]?.onBehalfOf).toBe(firstAdminMemberId())
  })

  it('refuses a reset without the confirmation', async () => {
    const { caller } = await harness(OPERATOR)
    expect((await refusalOf(caller.vault.reset({} as never))).code).toBe('BAD_REQUEST')
  })

  it.each([
    ['a member who is not an admin', MEMBER_CAPABILITY],
    ['an agent acting for an admin', AGENT_FOR_ADMIN],
  ])('refuses %s, and nothing is reset', async (_who, capability) => {
    const { store, caller } = await harness(capability)
    const kept = await store.credentials.insert({
      ownerUserId: firstAdminMemberId(),
      label: 'Kept',
      type: 'anthropic.api-key',
    })
    await sealCredentialSecret(store, kept, 'FAKE-sk-kept-0003', 0)

    expect((await refusalOf(caller.vault.reset({ confirm: true }))).code).toBe('FORBIDDEN')
    expect((await refusalOf(caller.vault.status())).code).toBe('FORBIDDEN')
    expect(store.vault.state()).toBe('ready')
    expect(await withSecret(store, kept.id, async (s) => s)).toBe('FAKE-sk-kept-0003')
  })
})

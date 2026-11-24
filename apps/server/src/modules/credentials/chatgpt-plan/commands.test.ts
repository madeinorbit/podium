/**
 * SIGN IN WITH CHATGPT THROUGH THE COMMANDS (credential management §11; epic
 * Task 14, acceptance 9 and 10, and 3 end to end).
 *
 * The real router and composition root; OpenAI is the fake in
 * `fake-openai.ts`, passed as the server's provider fetch.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  asIssueId,
  asMachineId,
  asSessionId,
  asUserId,
  type Capability,
  type UserId,
} from '@podium/model'
import { TRPCError } from '@trpc/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolvePrincipal } from '../../../command-principal'
import { SessionRegistry } from '../../../relay'
import { RepoRegistry } from '../../../repo-registry'
import { appRouter } from '../../../router'
import { SELF_HOSTED_WORKSPACE_ID } from '../../../self-hosted-workspace'
import { memberFacts } from '../../../store/fixtures/test-support'
import { SuperagentService } from '../../superagent'
import { FAKE_ACCOUNT, FAKE_CLIENT_ID, fakeOpenAi } from './fake-openai'

const OWNER = asUserId('user:chatgpt-cmd-owner')
const STRANGER = asUserId('user:chatgpt-cmd-stranger')

const member = (userId: UserId): Capability => ({
  role: 'worker',
  scope: { kind: 'owned', userId },
  actorUser: userId,
  onBehalfOf: userId,
})

/** A relayed agent session acting for the owner. */
const AGENT_FOR_OWNER: Capability = {
  role: 'worker',
  scope: { kind: 'subtree', rootId: asIssueId('iss_chatgpt_commands') },
  actorSessionId: asSessionId('ses_chatgpt_commands'),
  onBehalfOf: OWNER,
}

const priorStateDir = process.env.PODIUM_STATE_DIR
let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'podium-chatgpt-commands-'))
  process.env.PODIUM_STATE_DIR = dir
})
afterEach(() => {
  process.env.PODIUM_STATE_DIR = priorStateDir
  rmSync(dir, { recursive: true, force: true })
})

async function harness() {
  const openai = fakeOpenAi()
  const registry = await SessionRegistry.create(undefined, undefined, {
    instanceId: 'default',
    credentialProviderFetch: openai.fetch,
  })
  const repos = new RepoRegistry(registry, registry.sessionStore)
  const superagent = await SuperagentService.create(registry.modules, repos, registry.sessionStore)
  const store = registry.sessionStore
  for (const id of [OWNER, STRANGER]) {
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
  const as = (capability: Capability) =>
    appRouter.createCaller({
      registry,
      repos,
      superagent,
      users: store.users,
      loginRequired: async () => true,
      capability,
      principal: resolvePrincipal(SELF_HOSTED_WORKSPACE_ID, capability, {
        parentSessionOf: () => undefined,
      }),
    })
  /** Sign the owner in through the paste path; returns the credential id. */
  const signIn = async () => {
    const owner = as(member(OWNER))
    const started = await owner.credentials.chatgptSignInStart({ label: 'My ChatGPT' })
    expect(started.via).toBe('paste')
    const url = new URL(started.authorizeUrl)
    openai.state.nonce = url.searchParams.get('nonce') ?? ''
    const pasted = new URL('http://127.0.0.1:1455/auth/callback')
    pasted.searchParams.set('code', 'FAKE-code-commands')
    pasted.searchParams.set('state', url.searchParams.get('state') ?? '')
    pasted.searchParams.set('client_id', FAKE_CLIENT_ID)
    const done = await owner.credentials.chatgptSignInComplete({
      attemptId: started.attemptId,
      pastedUrl: pasted.toString(),
    })
    if (done.state !== 'signed-in') throw new Error(`sign-in failed: ${JSON.stringify(done)}`)
    expect(
      await owner.credentials.chatgptSignInStatus({ attemptId: started.attemptId }),
    ).toMatchObject({ state: 'signed-in', credentialId: done.credentialId })
    return done.credentialId
  }
  return { registry, store, as, openai, signIn }
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

describe('acceptance 10: who may sign in', () => {
  it('an agent principal cannot start a sign-in, even for its own person', async () => {
    const { as } = await harness()
    const refused = await refusal(
      as(AGENT_FOR_OWNER).credentials.chatgptSignInStart({ label: 'Agent try' }),
    )
    expect(refused.code).toBe('FORBIDDEN')
  })

  it('a machine the caller does not look after cannot listen for their sign-in', async () => {
    const { as, store } = await harness()
    await store.machines.upsertMachine({
      id: asMachineId('machine:chatgpt-elsewhere'),
      name: 'elsewhere',
      hostname: 'elsewhere.local',
      tokenHash: 'hash-elsewhere',
      ownerUserId: STRANGER,
    })
    const refused = await refusal(
      as(member(OWNER)).credentials.chatgptSignInStart({
        machineId: asMachineId('machine:chatgpt-elsewhere'),
      }),
    )
    expect(refused.code).toBe('NOT_FOUND')
  })
})

describe('acceptance 3 end to end: the pasted address', () => {
  it('signs in; the list shows the account’s email and no plan, never a token', async () => {
    const { as, signIn } = await harness()
    const credentialId = await signIn()
    const views = await as(member(OWNER)).credentials.list()
    const view = views.find((v) => v.id === credentialId)
    expect(view).toMatchObject({
      type: 'openai.chatgpt-plan',
      label: 'My ChatGPT',
      status: 'ok',
      identity: { email: FAKE_ACCOUNT.email },
    })
    expect(view?.identity.plan).toBeUndefined()
    // Canary first: the fake issued this token, and it is in no view.
    expect(JSON.stringify(views)).toContain(FAKE_ACCOUNT.email)
    expect(JSON.stringify(views)).not.toContain('FAKE-access-token-1')
    expect(JSON.stringify(views)).not.toContain('FAKE-refresh-token-1')
  })
})

describe('acceptance 9: removal calls the revocation endpoint', () => {
  it('a confirmed revocation removes it and says so', async () => {
    const { as, openai, signIn } = await harness()
    const credentialId = await signIn()
    const result = await as(member(OWNER)).credentials.remove({ credentialId })
    expect(result).toEqual({ ok: true, providerRevocation: 'confirmed' })
    expect(openai.state.revokeForms.map((f) => f.get('token'))).toEqual(['FAKE-refresh-token-1'])
    expect((await as(member(OWNER)).credentials.list()).map((v) => v.id)).not.toContain(
      credentialId,
    )
  })

  it('when the revocation call fails, the credential is still removed and the person is told', async () => {
    const { as, openai, signIn, store } = await harness()
    const credentialId = await signIn()
    openai.state.revokeStatus = 503
    const result = await as(member(OWNER)).credentials.remove({ credentialId })
    expect(result).toEqual({ ok: true, providerRevocation: 'not-confirmed' })
    expect(openai.state.revokeForms).toHaveLength(1) // one short try, never a wait
    expect((await store.credentials.get(credentialId))?.status).toBe('revoked')
    expect(await store.credentials.latestSecret(credentialId)).toBeNull()
  }, 20_000)
})

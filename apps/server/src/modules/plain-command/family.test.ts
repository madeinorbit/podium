/**
 * THE NON-SYNC COMMANDS ON THE RUNNING ROUTER (ADR 12 D8, POD-6360).
 *
 * Against `appRouter` with a real registry, because the claim is about what the
 * server SERVES: each of the 27 commands is reached through the front door, so a
 * caller the coarse check refuses gets a permission error, never a validation
 * error and never the handler.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Capability } from '@podium/model'
import { asIssueId, asSessionId, asUserId } from '@podium/model'
import { TRPCError } from '@trpc/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type CommandPrincipal, systemPrincipal } from '../../command-principal'
import { SessionRegistry } from '../../relay'
import { RepoRegistry } from '../../repo-registry'
import { appRouter } from '../../router'
import { SELF_HOSTED_WORKSPACE_ID } from '../../self-hosted-workspace'
import { OPERATOR, permissiveFixturePrincipal } from '../../test-support/capabilities'
import { openTestStore } from '../../test-support/open-test-store'
import { openTestIdentity } from '../../test-support/test-identity'
import { SECRET_SURFACE_ABSENT } from '../settings/authz'
import { SuperagentService } from '../superagent'

/** The census's non-synced commands (ADR 12 D8): no synced effect, online only. */
const PLAIN_COMMANDS = [
  'credentials.login',
  'auth.setDisplayName',
  'auth.setEmail',
  'auth.setLoginRequired',
  'auth.setPassword',
  'logs.crash',
  'logs.forward',
  'logs.setDaemonLevel',
  'logs.setLevel',
  'models.refresh',
  'perf.report',
  'perf.reset',
  'settings.clearSecret',
  'settings.secretPresence',
  'settings.setSecret',
  'settings.telegramBotPresence',
  'settings.telegramDisconnect',
  'settings.telegramSetupPoll',
  'settings.telegramSetupStart',
  'setup.activate',
  'setup.complete',
  'setup.connect',
  'setup.join',
  'setup.setChannel',
  'telemetry.resetId',
  'telemetry.set',
  'vault.reset',
  'credentials.add',
  'credentials.allowMachine',
  'credentials.disallowMachine',
  'credentials.remove',
  'credentials.rename',
  'credentials.renew',
  'credentials.share',
  'credentials.unshare',
] as const

const MEMBER = asUserId('user:plain-family-member')
const MEMBER_CAPABILITY: Capability = {
  workspaceId: SELF_HOSTED_WORKSPACE_ID,
  role: 'worker',
  scope: { kind: 'owned', userId: MEMBER },
  actorUser: MEMBER,
  onBehalfOf: MEMBER,
}

/** The capability `SessionAuthz.capabilityForSession` mints for a relayed agent. */
const AGENT_CAPABILITY: Capability = {
  workspaceId: SELF_HOSTED_WORKSPACE_ID,
  role: 'worker',
  scope: { kind: 'subtree', rootId: asIssueId('iss_plain_family') },
  actorSessionId: asSessionId('ses_plain_family'),
  onBehalfOf: MEMBER,
}

async function harness(opts: { capability: Capability; principal?: CommandPrincipal }) {
  const store = await openTestStore(':memory:')
  // The member is invited and accepts, as every member is; the id is the one
  // this file's capabilities name.
  const identity = await openTestIdentity(store, { newMemberId: () => MEMBER })
  await identity.addMember({
    name: 'Member',
    email: 'member@example.test',
    password: 'member-password',
  })
  const registry = await SessionRegistry.create(store, undefined, {
    instanceId: 'default',
    memberCredentials: identity.credentials,
  })
  const repos = new RepoRegistry(registry, registry.sessionStore)
  const superagent = await SuperagentService.create(registry.modules, repos, registry.sessionStore)
  const users = registry.sessionStore.users
  const caller = appRouter.createCaller({
    registry,
    repos,
    superagent,
    users,
    loginRequired: async () => true,
    capability: opts.capability,
    principal:
      opts.principal ??
      permissiveFixturePrincipal(SELF_HOSTED_WORKSPACE_ID, opts.capability, {
        parentSessionOf: () => undefined,
      }),
  })
  return { registry, caller, users, credentials: identity.credentials }
}

type AnyProc = (input: unknown) => Promise<unknown>
const procOf = (caller: unknown, name: string): AnyProc => {
  const [family, proc] = name.split('.') as [string, string]
  const router = (caller as Record<string, Record<string, AnyProc>>)[family]
  const fn = router?.[proc]
  if (fn === undefined) throw new Error(`${name} is not served`)
  return fn
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
  dir = mkdtempSync(join(tmpdir(), 'podium-plain-family-'))
  process.env.PODIUM_STATE_DIR = dir
})
afterEach(() => {
  process.env.PODIUM_STATE_DIR = priorStateDir
  rmSync(dir, { recursive: true, force: true })
})

describe('every non-sync command goes through the front door', () => {
  it('a system principal with garbage input is refused as unauthorized by all 35', async () => {
    expect(PLAIN_COMMANDS).toHaveLength(35)
    const { caller } = await harness({
      capability: OPERATOR,
      principal: systemPrincipal(SELF_HOSTED_WORKSPACE_ID, 'test'),
    })
    const codes: Record<string, string> = {}
    for (const name of PLAIN_COMMANDS) {
      codes[name] = (await refusalOf(procOf(caller, name)({ garbage: true }))).code
    }
    // FORBIDDEN, or NOT_FOUND for the presence read: a permission answer, never
    // BAD_REQUEST (the parse ran first) and never a handler's error.
    const expected = Object.fromEntries(
      PLAIN_COMMANDS.map((name) => [
        name,
        name === 'settings.secretPresence' || name === 'settings.telegramBotPresence'
          ? 'NOT_FOUND'
          : 'FORBIDDEN',
      ]),
    )
    expect(codes).toEqual(expected)
  })
})

describe('role floors on the plain path', () => {
  it('a member below the admin floor is refused before the input is parsed, and nothing runs', async () => {
    const { caller } = await harness({ capability: MEMBER_CAPABILITY })
    const refusal = await refusalOf(caller.telemetry.set({ usage: 'nope' } as never))
    expect(refusal.code).toBe('FORBIDDEN')
    const refusedValid = await refusalOf(caller.telemetry.set({ usage: 'off' }))
    expect(refusedValid.code).toBe('FORBIDDEN')
  })

  it('a member may still change their own password (member floor, write action)', async () => {
    const { caller, credentials } = await harness({ capability: MEMBER_CAPABILITY })
    await caller.auth.setPassword({ current: 'member-password', next: 'member-password-2' })
    expect(await credentials.verifyPassword(MEMBER, 'member-password-2')).toBe(true)
    expect(await credentials.verifyPassword(MEMBER, 'member-password')).toBe(false)
  })

  it('a member asking for secret presence is told there is no secret surface', async () => {
    const { caller } = await harness({ capability: MEMBER_CAPABILITY })
    const refusal = await refusalOf(caller.settings.secretPresence({}))
    expect(refusal.code).toBe('NOT_FOUND')
    expect(refusal.message).toBe(SECRET_SURFACE_ABSENT)
  })

  it("a member's harness sign-in reaches the login service, as that member", async () => {
    const { caller, registry } = await harness({ capability: MEMBER_CAPABILITY })
    const start = vi.spyOn(registry.modules.nativeLogin, 'start').mockResolvedValue({} as never)
    await caller.credentials.login({ harness: 'codex' })
    expect(start).toHaveBeenCalledWith({ harness: 'codex', ownerUserId: MEMBER })
  })

  it('an agent may not start a sign-in for its human', async () => {
    const { caller, registry } = await harness({ capability: AGENT_CAPABILITY })
    const start = vi.spyOn(registry.modules.nativeLogin, 'start')
    const refusal = await refusalOf(caller.credentials.login({ harness: 'codex' }))
    expect(refusal.code).toBe('FORBIDDEN')
    expect(start).not.toHaveBeenCalled()
  })

  it('an admin with invalid input gets the validation error', async () => {
    const { caller } = await harness({ capability: OPERATOR })
    const refusal = await refusalOf(caller.credentials.login({ harness: 'nope' } as never))
    expect(refusal.code).toBe('BAD_REQUEST')
  })
})

describe('the plain path keeps its validation answer', () => {
  it('an admin with invalid input gets the validation error (useOnMyMachines)', async () => {
    const { caller } = await harness({ capability: OPERATOR })
    const refusal = await refusalOf(
      caller.credentials.useOnMyMachines({ harness: 'codex' } as never),
    )
    expect(refusal.code).toBe('BAD_REQUEST')
  })
})

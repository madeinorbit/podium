/**
 * THE NON-SYNC COMMANDS ON THE RUNNING ROUTER (ADR 12 D8, POD-6360).
 *
 * Against `appRouter` with a real registry, because the claim is about what the
 * server SERVES: each of the 25 commands is reached through the front door, so a
 * caller the coarse check refuses gets a permission error, never a validation
 * error and never the handler.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Capability } from '@podium/model'
import { asUserId } from '@podium/model'
import { hashPassword } from '@podium/runtime/auth-store'
import { TRPCError } from '@trpc/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type CommandPrincipal, resolvePrincipal, systemPrincipal } from '../../command-principal'
import { SessionRegistry } from '../../relay'
import { RepoRegistry } from '../../repo-registry'
import { appRouter } from '../../router'
import { OPERATOR } from '../../test-support/capabilities'
import { SECRET_SURFACE_ABSENT } from '../settings/authz'
import { SuperagentService } from '../superagent'

/** The census's non-synced commands (ADR 12 D8): no synced effect, online only. */
const PLAIN_COMMANDS = [
  'accounts.connect',
  'accounts.disconnect',
  'accounts.login',
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
  'settings.telegramSetupPoll',
  'settings.telegramSetupStart',
  'setup.activate',
  'setup.complete',
  'setup.connect',
  'setup.join',
  'setup.setChannel',
  'telemetry.resetId',
  'telemetry.set',
] as const

const MEMBER = asUserId('user:plain-family-member')
const MEMBER_CAPABILITY: Capability = {
  role: 'worker',
  scope: { kind: 'owned', userId: MEMBER },
  actorUser: MEMBER,
  onBehalfOf: MEMBER,
}

async function harness(opts: { capability: Capability; principal?: CommandPrincipal }) {
  const registry = await SessionRegistry.create(undefined, undefined, { instanceId: 'default' })
  const repos = new RepoRegistry(registry, registry.sessionStore)
  const superagent = await SuperagentService.create(registry.modules, repos, registry.sessionStore)
  const users = registry.sessionStore.users
  await users.create(
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
    capability: opts.capability,
    principal:
      opts.principal ?? resolvePrincipal(opts.capability, { parentSessionOf: () => undefined }),
  })
  return { registry, caller, users }
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
  it('a system principal with garbage input is refused as unauthorized by all 25', async () => {
    expect(PLAIN_COMMANDS).toHaveLength(25)
    const { caller } = await harness({ capability: OPERATOR, principal: systemPrincipal('test') })
    const codes: Record<string, string> = {}
    for (const name of PLAIN_COMMANDS) {
      codes[name] = (await refusalOf(procOf(caller, name)({ garbage: true }))).code
    }
    // FORBIDDEN, or NOT_FOUND for the presence read: a permission answer, never
    // BAD_REQUEST (the parse ran first) and never a handler's error.
    const expected = Object.fromEntries(
      PLAIN_COMMANDS.map((name) => [
        name,
        name === 'settings.secretPresence' ? 'NOT_FOUND' : 'FORBIDDEN',
      ]),
    )
    expect(codes).toEqual(expected)
  })
})

describe('role floors on the plain path', () => {
  it('a member below the admin floor is refused before the input is parsed, and nothing is stored', async () => {
    const { caller, registry } = await harness({ capability: MEMBER_CAPABILITY })
    const refusal = await refusalOf(caller.accounts.connect({ provider: 'nope' } as never))
    expect(refusal.code).toBe('FORBIDDEN')
    const refusedValid = await refusalOf(
      caller.accounts.connect({ provider: 'anthropic', kind: 'api-key', credential: 'sk-x' }),
    )
    expect(refusedValid.code).toBe('FORBIDDEN')
    expect(await registry.sessionStore.accounts.list()).toEqual([])
  })

  it('a member may still change their own password (member floor, write action)', async () => {
    const { caller, users } = await harness({ capability: MEMBER_CAPABILITY })
    const before = (await users.credentialFor(MEMBER))?.passwordHash
    await caller.auth.setPassword({ current: 'member-password', next: 'member-password-2' })
    expect((await users.credentialFor(MEMBER))?.passwordHash).not.toBe(before)
  })

  it('a member asking for secret presence is told there is no secret surface', async () => {
    const { caller } = await harness({ capability: MEMBER_CAPABILITY })
    const refusal = await refusalOf(caller.settings.secretPresence({}))
    expect(refusal.code).toBe('NOT_FOUND')
    expect(refusal.message).toBe(SECRET_SURFACE_ABSENT)
  })

  it('an admin with invalid input gets the validation error', async () => {
    const { caller } = await harness({ capability: OPERATOR })
    const refusal = await refusalOf(caller.accounts.connect({ provider: 'nope' } as never))
    expect(refusal.code).toBe('BAD_REQUEST')
  })
})

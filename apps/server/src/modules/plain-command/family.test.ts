/**
 * THE NON-SYNC COMMANDS ON THE RUNNING ROUTER (ADR 12 D8, POD-6360).
 *
 * Against `appRouter` with a real registry, because the claim is about what the
 * server SERVES: each of the 26 commands is reached through the front door, so a
 * caller the coarse check refuses gets a permission error, never a validation
 * error and never the handler.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Capability } from '@podium/model'
import { asAccountId, asIssueId, asSessionId, asUserId } from '@podium/model'
import { hashPassword } from '@podium/runtime/auth-store'
import { TRPCError } from '@trpc/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
  'accounts.share',
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

/** The capability `SessionAuthz.capabilityForSession` mints for a relayed agent. */
const AGENT_CAPABILITY: Capability = {
  role: 'worker',
  scope: { kind: 'subtree', rootId: asIssueId('iss_plain_family') },
  actorSessionId: asSessionId('ses_plain_family'),
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
  it('a system principal with garbage input is refused as unauthorized by all 26', async () => {
    expect(PLAIN_COMMANDS).toHaveLength(26)
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
  it('a member below the admin floor is refused before the input is parsed, and nothing runs', async () => {
    const { caller } = await harness({ capability: MEMBER_CAPABILITY })
    const refusal = await refusalOf(caller.telemetry.set({ usage: 'nope' } as never))
    expect(refusal.code).toBe('FORBIDDEN')
    const refusedValid = await refusalOf(caller.telemetry.set({ usage: 'off' }))
    expect(refusedValid.code).toBe('FORBIDDEN')
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

  it("a member's harness sign-in reaches the login service, as that member", async () => {
    const { caller, registry } = await harness({ capability: MEMBER_CAPABILITY })
    const start = vi.spyOn(registry.modules.nativeLogin, 'start').mockResolvedValue({} as never)
    await caller.accounts.login({ harness: 'codex' })
    expect(start).toHaveBeenCalledWith({ harness: 'codex', ownerUserId: MEMBER })
  })

  it('an agent may not start a sign-in for its human', async () => {
    const { caller, registry } = await harness({ capability: AGENT_CAPABILITY })
    const start = vi.spyOn(registry.modules.nativeLogin, 'start')
    const refusal = await refusalOf(caller.accounts.login({ harness: 'codex' }))
    expect(refusal.code).toBe('FORBIDDEN')
    expect(start).not.toHaveBeenCalled()
  })

  it('an admin with invalid input gets the validation error', async () => {
    const { caller } = await harness({ capability: OPERATOR })
    const refusal = await refusalOf(caller.accounts.connect({ provider: 'nope' } as never))
    expect(refusal.code).toBe('BAD_REQUEST')
  })
})

describe('every user manages their own harness accounts, and only their own (POD-6360)', () => {
  const OTHER = asUserId('user:plain-family-other')
  const ANTHROPIC = asAccountId('managed:anthropic')
  const othersKey = {
    ownerUserId: OTHER,
    accountKey: ANTHROPIC,
    provider: 'anthropic',
    kind: 'api-key',
    credential: 'sk-others',
    identity: 'x',
    scope: 'role',
    createdAt: 1,
  } as const

  it('a member connects their own key: owned by them, private', async () => {
    const { caller, registry } = await harness({ capability: MEMBER_CAPABILITY })
    await caller.accounts.connect({ provider: 'anthropic', kind: 'api-key', credential: 'sk-mine' })
    const rows = await registry.sessionStore.accounts.list()
    expect(rows).toMatchObject([
      { ownerUserId: MEMBER, accountKey: ANTHROPIC, credential: 'sk-mine' },
    ])
    expect(rows[0]?.sharedWith).toEqual([])
  })

  it("a member's disconnect removes only their own key", async () => {
    const { caller, registry } = await harness({ capability: MEMBER_CAPABILITY })
    const accounts = registry.sessionStore.accounts
    await accounts.connect(othersKey)
    await accounts.share(OTHER, ANTHROPIC, ['*'])
    await caller.accounts.connect({ provider: 'anthropic', kind: 'api-key', credential: 'sk-mine' })
    await caller.accounts.disconnect({ id: ANTHROPIC })
    await caller.accounts.disconnect({ id: ANTHROPIC })
    expect((await accounts.list()).map((row) => row.credential)).toEqual(['sk-others'])
  })

  it("a member shares their own key, and may not touch another user's", async () => {
    const { caller, registry } = await harness({ capability: MEMBER_CAPABILITY })
    const accounts = registry.sessionStore.accounts
    await accounts.connect(othersKey)
    await caller.accounts.connect({ provider: 'anthropic', kind: 'api-key', credential: 'sk-mine' })
    await caller.accounts.share({ id: ANTHROPIC, everyone: false, users: [OTHER] })
    expect((await accounts.own(MEMBER, ANTHROPIC))?.sharedWith).toEqual([OTHER])

    const refusal = await refusalOf(
      caller.accounts.share({ id: ANTHROPIC, owner: OTHER, everyone: true, users: [] }),
    )
    expect(refusal.code).toBe('FORBIDDEN')
    expect((await accounts.own(OTHER, ANTHROPIC))?.sharedWith).toEqual([])
  })

  it("an admin may change the sharing of another user's key; a missing key is not found", async () => {
    const { caller, registry } = await harness({ capability: OPERATOR })
    const accounts = registry.sessionStore.accounts
    await accounts.connect(othersKey)
    await caller.accounts.share({ id: ANTHROPIC, owner: OTHER, everyone: true, users: [] })
    expect((await accounts.own(OTHER, ANTHROPIC))?.sharedWith).toEqual(['*'])
    await caller.accounts.share({ id: ANTHROPIC, owner: OTHER, everyone: false, users: [] })
    expect((await accounts.own(OTHER, ANTHROPIC))?.sharedWith).toEqual([])
    const missing = await refusalOf(
      caller.accounts.share({
        id: asAccountId('managed:openai'),
        owner: OTHER,
        everyone: true,
        users: [],
      }),
    )
    expect(missing.code).toBe('NOT_FOUND')
  })

  it('an agent may not connect, disconnect or share a key for its human', async () => {
    const { caller, registry } = await harness({ capability: AGENT_CAPABILITY })
    const accounts = registry.sessionStore.accounts
    await accounts.connect({ ...othersKey, ownerUserId: MEMBER, credential: 'sk-humans' })
    const refusals = [
      await refusalOf(
        caller.accounts.connect({ provider: 'anthropic', kind: 'api-key', credential: 'sk-agent' }),
      ),
      await refusalOf(caller.accounts.disconnect({ id: ANTHROPIC })),
      await refusalOf(caller.accounts.share({ id: ANTHROPIC, everyone: true, users: [] })),
    ]
    expect(refusals.map((refusal) => refusal.code)).toEqual(['FORBIDDEN', 'FORBIDDEN', 'FORBIDDEN'])
    expect(await accounts.list()).toMatchObject([{ credential: 'sk-humans', sharedWith: [] }])
  })
})

describe("an admin lists every user's keys, never their credentials (POD-6390)", () => {
  it('serves accounts.keys as a query', () => {
    expect(appRouter._def.record.accounts.keys._def.type).toBe('query')
  })

  const OTHER = asUserId('user:plain-family-other')
  const ANTHROPIC = asAccountId('managed:anthropic')
  const OAUTH = asAccountId('managed:claude-oauth')
  const SECRETS = ['sk-ant-SECRET-member-0001', 'sk-ant-oat01-SECRET-other-0002']
  const key = (ownerUserId: typeof MEMBER, accountKey: typeof ANTHROPIC, credential: string) =>
    ({
      ownerUserId,
      accountKey,
      provider: 'anthropic',
      kind: accountKey === OAUTH ? 'oauth' : 'api-key',
      credential,
      identity: `${credential.slice(0, 4)}…`,
      scope: 'role',
      createdAt: accountKey === OAUTH ? 2 : 1,
    }) as const

  it('answers owner, account id, masked identity and sharing; no secret leaves the server', async () => {
    const { caller, registry } = await harness({ capability: OPERATOR })
    const accounts = registry.sessionStore.accounts
    await accounts.connect(key(MEMBER, ANTHROPIC, SECRETS[0] as string))
    await accounts.connect(key(OTHER, OAUTH, SECRETS[1] as string))
    await accounts.share(MEMBER, ANTHROPIC, ['*', OTHER])

    const keys = await caller.accounts.keys({})
    expect(keys).toEqual([
      {
        owner: MEMBER,
        id: ANTHROPIC,
        provider: 'anthropic',
        kind: 'api-key',
        identity: 'sk-a…',
        sharing: { everyone: true, users: [OTHER] },
      },
      {
        owner: OTHER,
        id: OAUTH,
        provider: 'anthropic',
        kind: 'oauth',
        identity: 'sk-a…',
        sharing: { everyone: false, users: [] },
      },
    ])
    // The whole answer, serialized as the transport would: no credential, and
    // no field that could carry one.
    const wire = JSON.stringify(keys)
    for (const secret of SECRETS) expect(wire).not.toContain(secret)
    for (const row of keys) {
      expect(Object.keys(row).sort()).toEqual([
        'id',
        'identity',
        'kind',
        'owner',
        'provider',
        'sharing',
      ])
    }
  })

  it('a member and an agent are refused, and nothing is read', async () => {
    for (const capability of [
      MEMBER_CAPABILITY,
      AGENT_CAPABILITY,
      { ...OPERATOR, actorSessionId: asSessionId('ses_admin_keys') },
    ]) {
      const { caller, registry } = await harness({ capability })
      const summaries = vi.spyOn(registry.sessionStore.accounts, 'summaries')
      await registry.sessionStore.accounts.connect(key(OTHER, ANTHROPIC, SECRETS[0] as string))
      const refusal = await refusalOf(caller.accounts.keys({}))
      expect(refusal.code).toBe('FORBIDDEN')
      expect(summaries).not.toHaveBeenCalled()
    }
    const { caller, registry } = await harness({
      capability: OPERATOR,
      principal: systemPrincipal('keys-test'),
    })
    const summaries = vi.spyOn(registry.sessionStore.accounts, 'summaries')
    await expect(caller.accounts.keys({})).rejects.toThrow()
    expect(summaries).not.toHaveBeenCalled()
  })
})

describe('the plain path keeps its validation answer', () => {
  it('an admin with invalid input gets the validation error (share)', async () => {
    const { caller } = await harness({ capability: OPERATOR })
    const refusal = await refusalOf(caller.accounts.share({ id: 'managed:anthropic' } as never))
    expect(refusal.code).toBe('BAD_REQUEST')
  })

  it('an admin with invalid input gets the validation error', async () => {
    const { caller } = await harness({ capability: OPERATOR })
    const refusal = await refusalOf(caller.accounts.connect({ provider: 'nope' } as never))
    expect(refusal.code).toBe('BAD_REQUEST')
  })
})

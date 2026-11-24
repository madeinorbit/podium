/**
 * EVERY WAY OF STARTING A SESSION NAMES ITS CREDENTIAL (credential management
 * §9 "Choosing for a session", epic plan Task 10).
 *
 * The four launch paths, each through its production entry: `sessions.create`
 * and `issues.start` / `issues.addSession` through the tRPC router as a person,
 * and `mail.spawnAgent` through the message gate as an agent. Each test reads
 * the stored session row and the spawn frame the fake daemon received, so a
 * path that dropped the choice, or started something before refusing it,
 * shows up here. Planted secrets are obviously fake.
 */

import {
  asUserId,
  type CredentialId,
  firstAdminMemberId,
  type IssueId,
  type SessionId,
  type UserId,
} from '@podium/model'
import type { ControlMessage } from '@podium/protocol/daemon'
import { TRPCError } from '@trpc/server'
import { afterEach, describe, expect, it } from 'vitest'
import { ACCESS_REFUSAL_MESSAGES } from './modules/credentials/access'
import { sealCredentialSecret } from './modules/credentials/vault'
import { SessionRegistry } from './relay'
import { appRouter } from './router'
import { SELF_HOSTED_WORKSPACE_ID } from './self-hosted-workspace'
import type { SessionStore } from './store'
import { memberFacts } from './store/fixtures/test-support'
import { OPERATOR, permissiveFixturePrincipal } from './test-support/capabilities'
import { attachHostDaemon } from './test-support/host-daemon'
import { openTestStore } from './test-support/open-test-store'
import { seedRows } from './test-support/seed-rows'
import { errorShapeWithCause } from './trpc'

const AT = '2026-11-13T00:00:00.000Z'
const FAKE_WORK = 'sk-FAKE-work-key-0001'
const FAKE_HOME = 'sk-FAKE-home-key-0002'
const BOB = asUserId('user:choice-bob')

const registries: SessionRegistry[] = []
afterEach(async () => {
  for (const r of registries.splice(0)) await r.dispose()
})

type SpawnFrame = Extract<ControlMessage, { type: 'spawn' }>

interface Fixture {
  reg: SessionRegistry
  store: SessionStore
  daemon: ControlMessage[]
  admin: UserId
  spawns(): SpawnFrame[]
  worktreeAdds(): number
  caller(): ReturnType<typeof appRouter.createCaller>
  credential(label: string, secret: string, owner?: UserId): Promise<CredentialId>
  issue(title: string): Promise<IssueId>
  sessionsOf(issueId: IssueId): Promise<{ sessionId: SessionId; credentialId?: CredentialId }[]>
}

async function fixture(): Promise<Fixture> {
  const store = await openTestStore(':memory:')
  const reg = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
  registries.push(reg)
  const admin = await firstAdminMemberId(store)
  await memberFacts(store).create(
    { id: BOB, displayName: 'Bob', role: 'member', createdAt: AT, disabledAt: null },
    'not-a-real-hash',
  )
  const daemon: ControlMessage[] = []
  const machineId = store.hostMachine!.id
  // A daemon that answers git as a healthy checkout does: every op succeeds.
  await attachHostDaemon(
    reg,
    (message) => {
      daemon.push(message)
      if (message.type === 'repoOpRequest') {
        void reg.gateway.routeDaemonFrame(machineId, {
          type: 'repoOpResult',
          requestId: message.requestId,
          ok: true,
          output: message.op === 'revParseVerify' ? 'deadbeef' : '',
        })
      }
    },
    { repos: ['/r'] },
  )
  await reg.modules.machines.recordInventory(machineId, {
    os: 'linux',
    arch: 'x64',
    tools: [],
    agents: [{ kind: 'claude-code', installed: true, login: { state: 'in' } }],
    runtimeDrivers: [{ harness: 'claude-code', id: 'claude-pty', family: 'terminal' }],
  })
  const spawns = () => daemon.filter((m): m is SpawnFrame => m.type === 'spawn')
  return {
    reg,
    store,
    daemon,
    admin,
    spawns,
    worktreeAdds: () =>
      daemon.filter((m) => m.type === 'repoOpRequest' && m.op === 'worktreeAdd').length,
    caller: () =>
      appRouter.createCaller({
        registry: reg,
        repos: {} as never,
        superagent: {} as never,
        capability: OPERATOR,
        principal: permissiveFixturePrincipal(SELF_HOSTED_WORKSPACE_ID, OPERATOR, {
          parentSessionOf: () => undefined,
        }),
      }),
    credential: async (label, secret, owner = admin) => {
      const record = await store.credentials.insert({
        ownerUserId: owner,
        label,
        type: 'anthropic.api-key',
      })
      expect(await sealCredentialSecret(store, record, secret, 0)).toBe(1)
      return record.id
    },
    issue: async (title) =>
      (
        await reg.issues.crud.create(reg.issues.reports.store.serverWriter, {
          repoPath: '/r',
          title,
          startNow: false,
          defaultAgent: 'claude-code',
        })
      ).id as IssueId,
    sessionsOf: async (issueId) =>
      (await store.sessions.loadSessions())
        .filter((row) => row.issueId === issueId)
        .map((row) => ({
          sessionId: row.id as SessionId,
          ...(row.credentialId ? { credentialId: row.credentialId } : {}),
        })),
  }
}

/** The secret a spawn frame delivers, `{ variable: secret }`, or none. */
const delivered = (frame: SpawnFrame | undefined) => {
  const delivery = frame?.access?.delivery
  return delivery?.kind === 'env' ? { [delivery.variable]: delivery.secret } : undefined
}

async function setDefault(f: Fixture, id: CredentialId): Promise<void> {
  const current = (await f.store.settings.getSettingsFor(f.admin)).credentialDefaults
  // A setting the test sets up, not a write path under test: below the change
  // log, which the registry attaches (POD-6920).
  await seedRows(f.store, async () => {
    await f.store.settings.userPreferences.set(
      f.admin,
      'credentialDefaults',
      { ...current, 'claude-code': id },
      AT,
    )
  })
}

/** The agent capability production mints for a session (the relay path). */
async function agentOf(f: Fixture, issueId: IssueId) {
  const parent = await f.reg.modules.sessions.createSession({
    agentKind: 'claude-code',
    cwd: '/r',
    issueId,
    ownerUserId: f.admin,
    credentialId: null,
  })
  return await f.reg.modules.sessions.capabilityForSession(parent.sessionId)
}

const spawnAs = async (f: Fixture, capability: unknown, input: Record<string, unknown>) =>
  (await f.reg.modules.messageGate.dispatch(
    capability as never,
    undefined,
    'spawnAgent',
    input as never,
  )) as { sessionId: SessionId }

describe('acceptance 1: each launch path stores the chosen credential', () => {
  it('sessions.create', async () => {
    const f = await fixture()
    const work = await f.credential('Work key', FAKE_WORK)
    const created = (await f.caller().sessions.create({
      agentKind: 'claude-code',
      cwd: '/r',
      credentialId: work,
    })) as { sessionId: SessionId }
    expect((await f.store.sessions.getSession(created.sessionId))?.credentialId).toBe(work)
    expect(delivered(f.spawns().at(-1))).toEqual({ ANTHROPIC_API_KEY: FAKE_WORK })
  })

  it('issues.start', async () => {
    const f = await fixture()
    const work = await f.credential('Work key', FAKE_WORK)
    const issueId = await f.issue('Started on a key')
    await f.caller().issues.start({ id: issueId, credential: 'work KEY' })
    expect(await f.sessionsOf(issueId)).toEqual([expect.objectContaining({ credentialId: work })])
    expect(delivered(f.spawns().at(-1))).toEqual({ ANTHROPIC_API_KEY: FAKE_WORK })
  })

  it('issues.addSession', async () => {
    const f = await fixture()
    const work = await f.credential('Work key', FAKE_WORK)
    const issueId = await f.issue('Second session on a key')
    await f.caller().issues.start({ id: issueId, credential: 'none' })
    await f.caller().issues.addSession({ id: issueId, credential: work })
    const ids = (await f.sessionsOf(issueId)).map((s) => s.credentialId)
    expect(ids.sort()).toEqual([undefined, work].sort())
    expect(delivered(f.spawns().at(-1))).toEqual({ ANTHROPIC_API_KEY: FAKE_WORK })
  })

  it('mail.spawnAgent', async () => {
    const f = await fixture()
    const work = await f.credential('Work key', FAKE_WORK)
    const issueId = await f.issue('Child on a key')
    const spawned = await spawnAs(f, await agentOf(f, issueId), {
      issue: issueId,
      harness: 'claude-code',
      prompt: 'go',
      credential: 'Work key',
    })
    expect((await f.store.sessions.getSession(spawned.sessionId))?.credentialId).toBe(work)
    expect(delivered(f.spawns().at(-1))).toEqual({ ANTHROPIC_API_KEY: FAKE_WORK })
  })
})

describe('acceptance 2: a reference that names nothing creates nothing', () => {
  it('an unknown label on issues.start: no worktree, no session, no spawn', async () => {
    const f = await fixture()
    await f.credential('Work key', FAKE_WORK)
    const issueId = await f.issue('Never started')
    await expect(f.caller().issues.start({ id: issueId, credential: 'Nope' })).rejects.toThrow(
      'No credential you can use is labelled "Nope".',
    )
    expect(f.worktreeAdds()).toBe(0)
    expect(await f.sessionsOf(issueId)).toEqual([])
    expect(f.spawns()).toEqual([])
    expect((await f.reg.issues.reports.getMeta(issueId))?.worktreePath ?? null).toBeNull()
  })

  it('an unknown id on sessions.create: no session row, no spawn', async () => {
    const f = await fixture()
    const before = (await f.store.sessions.loadSessions()).length
    await expect(
      f.caller().sessions.create({
        agentKind: 'claude-code',
        cwd: '/r',
        credentialId: 'cred_00000000-0000-4000-8000-000000000000' as CredentialId,
      }),
    ).rejects.toThrow('This credential no longer exists.')
    expect((await f.store.sessions.loadSessions()).length).toBe(before)
    expect(f.spawns()).toEqual([])
  })

  it('an unknown label on issues.addSession: no session, no spawn', async () => {
    const f = await fixture()
    const issueId = await f.issue('One session only')
    await f.caller().issues.start({ id: issueId, credential: 'none' })
    const spawned = f.spawns().length
    await expect(f.caller().issues.addSession({ id: issueId, credential: 'Nope' })).rejects.toThrow(
      'No credential you can use is labelled "Nope".',
    )
    expect(await f.sessionsOf(issueId)).toHaveLength(1)
    expect(f.spawns()).toHaveLength(spawned)
  })

  it('a label that matches two credentials is refused and names both', async () => {
    const f = await fixture()
    const one = await f.credential('Claude', FAKE_WORK)
    const two = await f.credential('claude', FAKE_HOME)
    const issueId = await f.issue('Ambiguous')
    const capability = await agentOf(f, issueId)
    const spawned = f.spawns().length
    const refusal = spawnAs(f, capability, {
      issue: issueId,
      harness: 'claude-code',
      prompt: 'go',
      credential: 'CLAUDE',
    })
    await expect(refusal).rejects.toThrow(`"Claude" (${one})`)
    await expect(refusal).rejects.toThrow(`"claude" (${two})`)
    expect(f.spawns()).toHaveLength(spawned)
  })
})

/** What a refused call answers: the tRPC error, and the code its shape carries. */
async function refusalOf(call: Promise<unknown>) {
  const error = await call.then(
    () => undefined,
    (thrown: unknown) => thrown,
  )
  expect(error).toBeInstanceOf(TRPCError)
  const trpc = error as TRPCError
  const shape = errorShapeWithCause({ message: trpc.message, data: {} }, trpc)
  return { code: trpc.code, message: trpc.message, data: shape.data }
}

describe('a credential refusal answers as a refusal, not a 500 (POD-7066)', () => {
  it('a named credential the vault cannot hand over: PRECONDITION_FAILED with its code', async () => {
    const f = await fixture()
    // Healthy by its record, but no secret was ever stored: the start refuses
    // it (`CredentialRefusal`) after the reference resolved.
    const record = await f.store.credentials.insert({
      ownerUserId: f.admin,
      label: 'Empty key',
      type: 'anthropic.api-key',
    })
    const before = (await f.store.sessions.loadSessions()).length
    const refused = await refusalOf(
      f.caller().sessions.create({ agentKind: 'claude-code', cwd: '/r', credentialId: record.id }),
    )
    expect(refused).toEqual({
      code: 'PRECONDITION_FAILED',
      message: ACCESS_REFUSAL_MESSAGES['needs-attention'],
      data: { refusalCode: 'credential:needs-attention' },
    })
    expect((await f.store.sessions.loadSessions()).length).toBe(before)
    expect(f.spawns()).toEqual([])
  })

  it('an id that names nothing: PRECONDITION_FAILED with not-found', async () => {
    const f = await fixture()
    // Refused while the reference resolves (`CredentialRefError`).
    const refused = await refusalOf(
      f.caller().sessions.create({
        agentKind: 'claude-code',
        cwd: '/r',
        credentialId: 'cred_00000000-0000-4000-8000-000000000000' as CredentialId,
      }),
    )
    expect(refused).toEqual({
      code: 'PRECONDITION_FAILED',
      message: ACCESS_REFUSAL_MESSAGES['not-found'],
      data: { refusalCode: 'credential:not-found' },
    })
  })
})

describe('acceptance 3: an agent names what its person can use', () => {
  it("an agent spawns on its person's credential by label", async () => {
    const f = await fixture()
    const work = await f.credential('Work key', FAKE_WORK)
    const issueId = await f.issue('Agent choice')
    const spawned = await spawnAs(f, await agentOf(f, issueId), {
      issue: issueId,
      harness: 'claude-code',
      prompt: 'go',
      credential: 'work key',
    })
    expect((await f.store.sessions.getSession(spawned.sessionId))?.credentialId).toBe(work)
  })

  it('a credential its person cannot use is refused, by label and by id', async () => {
    const f = await fixture()
    const bobs = await f.credential('Bob key', FAKE_HOME, BOB)
    const issueId = await f.issue('Not yours')
    const capability = await agentOf(f, issueId)
    const spawned = f.spawns().length
    await expect(
      spawnAs(f, capability, {
        issue: issueId,
        harness: 'claude-code',
        prompt: 'go',
        credential: 'Bob key',
      }),
    ).rejects.toThrow('No credential you can use is labelled "Bob key".')
    await expect(
      spawnAs(f, capability, {
        issue: issueId,
        harness: 'claude-code',
        prompt: 'go',
        credential: bobs,
      }),
    ).rejects.toThrow('You do not have use of this credential.')
    expect(f.spawns()).toHaveLength(spawned)
    expect(JSON.stringify(f.daemon)).not.toContain(FAKE_HOME)
  })
})

describe('acceptance 4: nothing named takes the default; `none` takes the harness login', () => {
  it('issues.start without a credential runs on the default for the harness', async () => {
    const f = await fixture()
    const home = await f.credential('Home key', FAKE_HOME)
    await setDefault(f, home)
    const issueId = await f.issue('Default')
    await f.caller().issues.start({ id: issueId })
    expect(await f.sessionsOf(issueId)).toEqual([expect.objectContaining({ credentialId: home })])
    expect(delivered(f.spawns().at(-1))).toEqual({ ANTHROPIC_API_KEY: FAKE_HOME })
  })

  it('`none` starts on the harness login even with a default set', async () => {
    const f = await fixture()
    const home = await f.credential('Home key', FAKE_HOME)
    await setDefault(f, home)
    const issueId = await f.issue('None')
    await f.caller().issues.start({ id: issueId, credential: 'none' })
    const [session] = await f.sessionsOf(issueId)
    expect(session).toBeDefined()
    expect(session?.credentialId).toBeUndefined()
    const frame = f.spawns().at(-1)
    expect(frame).toBeDefined()
    expect(Object.hasOwn(frame ?? {}, 'access')).toBe(false)
    expect(JSON.stringify(f.daemon)).not.toContain(FAKE_HOME)
  })
})

describe('acceptance 5 and 7: the session records what the harness said', () => {
  /** A session on a key whose record holds the fingerprint `fp-work`. */
  async function onKey(f: Fixture) {
    const record = await f.store.credentials.insert({
      ownerUserId: f.admin,
      label: 'Work key',
      type: 'anthropic.api-key',
      identity: { fingerprint: 'fp-work' },
    })
    expect(await sealCredentialSecret(f.store, record, FAKE_WORK, 0)).toBe(1)
    const created = await f.reg.modules.sessions.createSession({
      agentKind: 'claude-code',
      cwd: '/r',
      ownerUserId: f.admin,
      credentialId: record.id,
    })
    await f.reg.gateway.routeDaemonFrame(f.store.hostMachine!.id, {
      type: 'bind',
      sessionId: created.sessionId,
      cmd: 'claude',
      cwd: '/r',
      agentKind: 'claude-code',
      geometry: { cols: 80, rows: 24 },
    })
    // A conversation it can be woken back into, so a restart is a resume.
    await f.reg.gateway.routeDaemonFrame(f.store.hostMachine!.id, {
      type: 'sessionResumeRef',
      sessionId: created.sessionId,
      resume: { kind: 'claude-session', value: 'conv-choice-1' },
      confidence: 'exact',
    })
    return { sessionId: created.sessionId, credentialId: record.id }
  }

  const report = async (
    f: Fixture,
    sessionId: SessionId,
    frame: Record<string, unknown>,
    machineId: string = f.store.hostMachine!.id,
  ) => {
    await f.reg.gateway.routeDaemonFrame(
      machineId as never,
      {
        type: 'sessionAuth',
        sessionId,
        ...frame,
      } as never,
    )
    // Routing is delivered, not answered: let the projection's write land.
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 5))
    return await f.store.sessions.getSession(sessionId)
  }

  it('records the method and the chosen fingerprint for a key read as delivered', async () => {
    const f = await fixture()
    const { sessionId } = await onKey(f)
    const row = await report(f, sessionId, {
      method: 'api-key',
      source: 'ANTHROPIC_API_KEY',
      delivered: true,
    })
    expect(row?.effectiveAuth).toEqual({ method: 'api-key', fingerprint: 'fp-work' })
    expect(row?.credentialMismatch ?? undefined).toBeUndefined()
  })

  it('carries a mismatch with both identities, and loses it after a restart that matches', async () => {
    const f = await fixture()
    const { sessionId, credentialId } = await onKey(f)
    const flagged = await report(f, sessionId, {
      method: 'subscription',
      identity: { email: 'someone@example.invalid', fingerprint: 'fp-someone' },
    })
    expect(flagged?.credentialMismatch).toEqual({
      chosen: { credentialId, method: 'api-key', fingerprint: 'fp-work' },
      reported: {
        method: 'subscription',
        fingerprint: 'fp-someone',
        email: 'someone@example.invalid',
      },
    })
    // The flag is on the client's view of the session too.
    const meta = await f.reg.modules.sessions.sessionById(sessionId)
    expect(meta?.credentialMismatch?.chosen.credentialId).toBe(credentialId)

    // A restart: parked, woken, and this time the harness answers as chosen.
    expect(await f.reg.modules.sessions.hibernateSession({ sessionId })).toEqual({ ok: true })
    await f.reg.modules.issueSessionLifecycle.resurrectSession({ sessionId })
    const cleared = await report(f, sessionId, {
      method: 'api-key',
      source: 'ANTHROPIC_API_KEY',
      delivered: true,
    })
    expect(cleared?.credentialMismatch ?? undefined).toBeUndefined()
    expect(cleared?.effectiveAuth).toEqual({ method: 'api-key', fingerprint: 'fp-work' })
  })

  it('ignores a report from a machine the session does not run on', async () => {
    const f = await fixture()
    const { sessionId } = await onKey(f)
    const row = await report(
      f,
      sessionId,
      { method: 'subscription', identity: { fingerprint: 'fp-forged' } },
      'machine-elsewhere',
    )
    expect(row?.effectiveAuth ?? undefined).toBeUndefined()
  })
})

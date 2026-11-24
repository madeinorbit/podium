/**
 * SWITCHING A SESSION TO ANOTHER CREDENTIAL (credential management §9; epic
 * plan Task 11).
 *
 * `sessions.switchCredential` through the tRPC router, against a fake daemon
 * that answers spawns, kills and conversation placements. Each test reads what
 * the daemon was sent: the placement of the conversation (its resume id, the
 * target home, the accounts) BEFORE the revived spawn, and the spawn's resume
 * and credential. Planted secrets are obviously fake.
 */

import {
  type AgentKind,
  type AgentRuntimeState,
  asUserId,
  type CredentialId,
  firstAdminMemberId,
  type SessionId,
  type UserId,
} from '@podium/model'
import {
  CAP_CONVERSATION_PREPARE,
  CAP_HARNESS_HOMES,
  CAP_SESSION_ACCESS,
  homeIdFor,
} from '@podium/protocol'
import type { ControlMessage } from '@podium/protocol/daemon'
import { afterEach, describe, expect, it } from 'vitest'
import { resolvePrincipal } from './command-principal'
import { ACCESS_REFUSAL_MESSAGES } from './modules/credentials/access'
import { sealCredentialSecret } from './modules/credentials/vault'
import { SessionRegistry } from './relay'
import { appRouter } from './router'
import { SELF_HOSTED_WORKSPACE_ID } from './self-hosted-workspace'
import type { SessionStore } from './store'
import { OPERATOR } from './test-support/capabilities'
import { attachHostDaemon } from './test-support/host-daemon'
import { openTestStore } from './test-support/open-test-store'

const FAKE_KEY = 'sk-FAKE-switch-key-0001'
const registries: SessionRegistry[] = []
afterEach(async () => {
  for (const r of registries.splice(0)) await r.dispose()
})

type Frame<T extends ControlMessage['type']> = Extract<ControlMessage, { type: T }>

interface DaemonScript {
  /** The daemon's answer to a placement; default: copied. */
  prepare?: (request: Frame<'conversationPrepareRequest'>) => {
    ok: boolean
    placed?: 'in-place' | 'copied' | 'rewritten'
    error?: string
  }
  /** Spawns after which the harness exits at once (a resume that failed). */
  exitOnSpawn?: (frame: Frame<'spawn'>) => boolean
}

interface Fixture {
  reg: SessionRegistry
  store: SessionStore
  admin: UserId
  daemon: ControlMessage[]
  script: DaemonScript
  caller(): ReturnType<typeof appRouter.createCaller>
  key(
    type: 'anthropic.api-key' | 'openai.api-key' | 'openai.chatgpt-plan',
    label: string,
  ): Promise<CredentialId>
  login(
    type: 'anthropic.claude-login' | 'openai.chatgpt-login',
    label: string,
    fingerprint: string,
  ): Promise<CredentialId>
  /** A running session on `credentialId`, idle, with a resume ref. */
  running(
    agentKind: AgentKind,
    credentialId: CredentialId | null,
    opts?: { driver?: string; resume?: string },
  ): Promise<SessionId>
  state(sessionId: SessionId, phase: AgentRuntimeState['phase']): Promise<void>
  frames<T extends ControlMessage['type']>(type: T): Frame<T>[]
  row(sessionId: SessionId): Promise<{ credentialId?: string | null; status?: string } | undefined>
}

const RESUME_KIND: Record<string, string> = {
  'claude-code': 'claude-session',
  codex: 'codex-thread',
}

let clock = 0
const runtime = (phase: AgentRuntimeState['phase']): AgentRuntimeState => ({
  phase,
  since: new Date(Date.UTC(2026, 10, 17, 0, 0, ++clock)).toISOString(),
  workingMsTotal: 0,
  nativeSubagentCount: 0,
})

async function fixture(
  logins: { claude?: string; codex?: string; homes?: Record<string, string> } = {},
): Promise<Fixture> {
  const store = await openTestStore(':memory:')
  const reg = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
  registries.push(reg)
  const admin = await firstAdminMemberId(store)
  const machineId = store.hostMachine!.id
  const daemon: ControlMessage[] = []
  const script: DaemonScript = {}
  const route = (frame: Parameters<typeof reg.gateway.routeDaemonFrame>[1]) =>
    void reg.gateway.routeDaemonFrame(machineId, frame)
  await attachHostDaemon(
    reg,
    (message) => {
      daemon.push(message)
      if (message.type === 'repoOpRequest') {
        route({
          type: 'repoOpResult',
          requestId: message.requestId,
          ok: true,
          output: message.op === 'revParseVerify' ? 'deadbeef' : '',
        })
      }
      if (message.type === 'conversationPrepareRequest') {
        const answer = script.prepare?.(message) ?? { ok: true, placed: 'copied' }
        route({ type: 'conversationPrepareResult', requestId: message.requestId, ...answer })
      }
      if (message.type === 'spawn') {
        const frame = message
        queueMicrotask(() => {
          if (script.exitOnSpawn?.(frame)) {
            route({ type: 'agentExit', sessionId: frame.sessionId, code: 1 })
            return
          }
          route({
            type: 'bind',
            sessionId: frame.sessionId,
            cmd: frame.agentKind,
            cwd: frame.cwd,
            agentKind: frame.agentKind,
            geometry: { cols: 80, rows: 24 },
          })
        })
      }
    },
    { repos: ['/r'], caps: [CAP_SESSION_ACCESS, CAP_HARNESS_HOMES, CAP_CONVERSATION_PREPARE] },
  )
  const homeLogins = (harness: 'claude-code' | 'codex') =>
    Object.entries(logins.homes ?? {})
      .filter(([homeId]) => homeId.endsWith(`:${harness}`))
      .map(([homeId, fingerprint]) => ({ homeId, state: 'in' as const, identity: { fingerprint } }))
  await reg.modules.machines.recordInventory(machineId, {
    os: 'linux',
    arch: 'x64',
    tools: [],
    agents: [
      {
        kind: 'claude-code',
        installed: true,
        login: {
          state: 'in',
          ...(logins.claude ? { identity: { fingerprint: logins.claude } } : {}),
        },
        logins: homeLogins('claude-code'),
      },
      {
        kind: 'codex',
        installed: true,
        login: {
          state: 'in',
          ...(logins.codex ? { identity: { fingerprint: logins.codex } } : {}),
        },
        logins: homeLogins('codex'),
      },
    ],
    runtimeDrivers: [
      { harness: 'claude-code', id: 'claude-pty', family: 'terminal' },
      { harness: 'codex', id: 'codex-pty', family: 'terminal' },
      { harness: 'codex', id: 'codex-app-server', family: 'server' },
    ],
  } as never)
  const f: Fixture = {
    reg,
    store,
    admin,
    daemon,
    script,
    caller: () =>
      appRouter.createCaller({
        registry: reg,
        repos: {} as never,
        superagent: {} as never,
        capability: OPERATOR,
        principal: resolvePrincipal(SELF_HOSTED_WORKSPACE_ID, OPERATOR, {
          parentSessionOf: () => undefined,
        }),
      }),
    key: async (type, label) => {
      const record = await store.credentials.insert({ ownerUserId: admin, label, type })
      expect(await sealCredentialSecret(store, record, FAKE_KEY, 0)).toBe(1)
      return record.id
    },
    login: async (type, label, fingerprint) =>
      (
        await store.credentials.insert({
          ownerUserId: admin,
          label,
          type,
          identity: { fingerprint },
        })
      ).id,
    running: async (agentKind, credentialId, opts = {}) => {
      const { sessionId } = await reg.modules.sessions.createSession({
        agentKind,
        cwd: '/r',
        ownerUserId: admin,
        credentialId,
        ...(opts.driver ? { requestedDriverId: opts.driver } : {}),
      })
      await reg.gateway.routeDaemonFrame(machineId, {
        type: 'bind',
        sessionId,
        cmd: agentKind,
        cwd: '/r',
        agentKind,
        geometry: { cols: 80, rows: 24 },
      })
      await reg.gateway.routeDaemonFrame(machineId, {
        type: 'sessionResumeRef',
        sessionId,
        resume: {
          kind: RESUME_KIND[agentKind] as never,
          value: opts.resume ?? `conv-${sessionId.slice(0, 8)}`,
        },
      })
      await f.state(sessionId, 'idle')
      return sessionId
    },
    state: async (sessionId, phase) => {
      await reg.gateway.routeDaemonFrame(machineId, {
        type: 'agentState',
        sessionId,
        state: runtime(phase),
      })
    },
    frames: (type) => daemon.filter((m) => m.type === type) as never,
    row: async (sessionId) => {
      const row = (await store.sessions.loadSessions()).find((r) => r.id === sessionId)
      return row ? { credentialId: row.credentialId, status: row.status } : undefined
    },
  }
  return f
}

/** Frames after index `from`, by type, in order. */
/** What the daemon was asked, in order: `park` is the harness stopped (the
 *  driver's measured stop, or the kill frame), `prepare` a placement. */
const sequence = (f: Fixture, from: number) =>
  f.daemon.slice(from).flatMap((m) => {
    if (m.type === 'kill') return ['park']
    if (m.type === 'runtimeLifecycleRequest' && m.verb === 'stop') return ['park']
    if (m.type === 'conversationPrepareRequest') return ['prepare']
    if (m.type === 'spawn') return ['spawn']
    return []
  })

const lastSpawn = (f: Fixture) => f.frames('spawn').at(-1)
const lastPrepare = (f: Fixture) => f.frames('conversationPrepareRequest').at(-1)

const until = async (check: () => boolean | Promise<boolean>, what: string) => {
  const deadline = Date.now() + 5_000
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

describe('acceptance 1 and 5: an idle session revives with resume on the new credential', () => {
  it('Claude terminal: a key → a subscription in its own home; placed there before the resume', async () => {
    const subB = 'cred_00000000-0000-4000-8000-00000000c1ab' as CredentialId
    const homeB = homeIdFor(subB, 'claude-code')
    // The machine reports Sub B signed in in its own home (§10).
    const f = await fixture({ homes: { [homeB]: 'fp-claude-b' } })
    const keyA = await f.key('anthropic.api-key', 'Key A')
    await f.store.credentials.insert({
      id: subB,
      ownerUserId: f.admin,
      label: 'Sub B',
      type: 'anthropic.claude-login',
      identity: { fingerprint: 'fp-claude-b' },
    })
    const sessionId = await f.running('claude-code', keyA, { resume: 'claude-conv-1' })
    const before = f.daemon.length

    const result = await f.caller().sessions.switchCredential({
      sessionId,
      credentialId: subB,
      whenBusy: 'wait',
    })

    expect(result).toEqual({ continuedAs: 'resume' })
    // Parked, placed (the switch's own placement, then the revival's), resumed.
    expect(sequence(f, before)).toEqual(['park', 'prepare', 'prepare', 'spawn'])
    expect(f.frames('conversationPrepareRequest').at(-2)).toMatchObject({
      sessionId,
      agentKind: 'claude-code',
      resume: { kind: 'claude-session', value: 'claude-conv-1' },
      toHomeId: homeB,
      account: subB,
      fromAccount: keyA,
    })
    expect(lastPrepare(f)).toMatchObject({ toHomeId: homeB, account: subB })
    const spawn = lastSpawn(f)
    expect(spawn?.resume).toEqual({ kind: 'claude-session', value: 'claude-conv-1' })
    expect(spawn?.access).toEqual({ credentialId: subB, delivery: { kind: 'home', homeId: homeB } })
    expect((await f.row(sessionId))?.credentialId).toBe(subB)
  })

  it('Codex terminal: subscription A in its home → subscription B in another home', async () => {
    const credA = 'cred_00000000-0000-4000-8000-00000000c0da' as CredentialId
    const credB = 'cred_00000000-0000-4000-8000-00000000c0db' as CredentialId
    const homeA = homeIdFor(credA, 'codex')
    const homeB = homeIdFor(credB, 'codex')
    const f = await fixture({ homes: { [homeA]: 'fp-codex-a', [homeB]: 'fp-codex-b' } })
    for (const [id, fp, label] of [
      [credA, 'fp-codex-a', 'Plan A'],
      [credB, 'fp-codex-b', 'Plan B'],
    ] as const) {
      await f.store.credentials.insert({
        id,
        ownerUserId: f.admin,
        label,
        type: 'openai.chatgpt-login',
        identity: { fingerprint: fp },
      })
    }
    const sessionId = await f.running('codex', credA, {
      driver: 'codex-pty',
      resume: 'thread-term',
    })
    const before = f.daemon.length

    const result = await f
      .caller()
      .sessions.switchCredential({ sessionId, credentialId: credB, whenBusy: 'wait' })

    expect(result).toEqual({ continuedAs: 'resume' })
    expect(sequence(f, before)[0]).toBe('park')
    expect(sequence(f, before).at(-1)).toBe('spawn')
    expect(
      f.frames('conversationPrepareRequest').find((p) => p.fromAccount !== undefined),
    ).toMatchObject({
      resume: { kind: 'codex-thread', value: 'thread-term' },
      toHomeId: homeB,
      account: credB,
      fromAccount: credA,
    })
    const spawn = lastSpawn(f)
    expect(spawn?.resume).toEqual({ kind: 'codex-thread', value: 'thread-term' })
    expect(spawn?.access).toEqual({
      credentialId: credB,
      delivery: { kind: 'home', homeId: homeB },
    })
    expect(spawn?.requestedDriverId).toBe('codex-pty')
  })

  it('Codex server: an API key → subscription in its home, on the app-server driver', async () => {
    const credB = 'cred_00000000-0000-4000-8000-00000000c0eb' as CredentialId
    const homeB = homeIdFor(credB, 'codex')
    const f = await fixture({ homes: { [homeB]: 'fp-codex-srv' } })
    const key = await f.key('openai.api-key', 'Key')
    await f.store.credentials.insert({
      id: credB,
      ownerUserId: f.admin,
      label: 'Plan',
      type: 'openai.chatgpt-login',
      identity: { fingerprint: 'fp-codex-srv' },
    })
    const sessionId = await f.running('codex', key, {
      driver: 'codex-app-server',
      resume: 'thread-srv',
    })
    const before = f.daemon.length

    expect(
      await f
        .caller()
        .sessions.switchCredential({ sessionId, credentialId: credB, whenBusy: 'wait' }),
    ).toEqual({ continuedAs: 'resume' })

    expect(sequence(f, before).at(-1)).toBe('spawn')
    expect(
      f.frames('conversationPrepareRequest').find((p) => p.fromAccount !== undefined),
    ).toMatchObject({
      resume: { kind: 'codex-thread', value: 'thread-srv' },
      toHomeId: homeB,
      account: credB,
      fromAccount: key,
    })
    const spawn = lastSpawn(f)
    expect(spawn?.resume).toEqual({ kind: 'codex-thread', value: 'thread-srv' })
    expect(spawn?.access).toEqual({
      credentialId: credB,
      delivery: { kind: 'home', homeId: homeB },
    })
    expect(spawn?.requestedDriverId).toBe('codex-app-server')
  })
})

describe('acceptance 2: a session in a turn', () => {
  it("whenBusy 'wait' switches at the next turn boundary and the turn is left to finish", async () => {
    const f = await fixture()
    const a = await f.key('anthropic.api-key', 'A')
    const b = await f.key('anthropic.api-key', 'B')
    const sessionId = await f.running('claude-code', a)
    await f.state(sessionId, 'working')
    const before = f.daemon.length

    expect(
      await f.caller().sessions.switchCredential({ sessionId, credentialId: b, whenBusy: 'wait' }),
    ).toEqual({
      continuedAs: 'resume',
      waitingForTurnEnd: true,
    })
    expect(sequence(f, before)).toEqual([])
    expect(
      f.daemon
        .slice(before)
        .some((m) => m.type === 'input' || m.type === 'runtimeLifecycleRequest'),
    ).toBe(false)

    await f.state(sessionId, 'idle')
    await until(() => sequence(f, before).includes('spawn'), 'the revived spawn')
    expect(sequence(f, before)[0]).toBe('park')
    expect(lastSpawn(f)?.access?.credentialId).toBe(b)
  })

  it("whenBusy 'interrupt' stops the turn, then switches at its end", async () => {
    const f = await fixture()
    const a = await f.key('anthropic.api-key', 'A')
    const b = await f.key('anthropic.api-key', 'B')
    const sessionId = await f.running('claude-code', a)
    await f.state(sessionId, 'working')
    const before = f.daemon.length

    expect(
      await f
        .caller()
        .sessions.switchCredential({ sessionId, credentialId: b, whenBusy: 'interrupt' }),
    ).toEqual({ continuedAs: 'resume', waitingForTurnEnd: true })
    // The stop went to the daemon (the terminal's interrupt key, or the driver).
    await until(
      () =>
        f.daemon
          .slice(before)
          .some(
            (m) =>
              m.type === 'input' ||
              m.type === 'runtimeLifecycleRequest' ||
              m.type === 'runtimeInterruptRequest',
          ),
      'the interrupt',
    )
    expect(sequence(f, before)).toEqual([])
    await f.state(sessionId, 'idle')
    await until(() => sequence(f, before).includes('spawn'), 'the revived spawn')
    expect(lastSpawn(f)?.access?.credentialId).toBe(b)
  })
})

describe('acceptance 3: a stopped session changes only its record', () => {
  it('next-wake; the next wake runs on the new credential', async () => {
    const f = await fixture()
    const a = await f.key('anthropic.api-key', 'A')
    const b = await f.key('anthropic.api-key', 'B')
    const sessionId = await f.running('claude-code', a)
    expect(await f.reg.modules.sessions.hibernateSession({ sessionId })).toEqual({ ok: true })
    const before = f.daemon.length

    expect(
      await f.caller().sessions.switchCredential({ sessionId, credentialId: b, whenBusy: 'wait' }),
    ).toEqual({
      continuedAs: 'next-wake',
    })
    expect(f.frames('spawn').length).toBe(
      f.daemon.slice(0, before).filter((m) => m.type === 'spawn').length,
    )
    expect((await f.row(sessionId))?.credentialId).toBe(b)
    expect((await f.row(sessionId))?.status).toBe('hibernated')

    const woke = await f.reg.modules.sessions.resurrectSession({ sessionId }, {
      onSessionResurrected: () => {},
    } as never)
    expect(woke.ok).toBe(true)
    expect(lastSpawn(f)?.access).toMatchObject({ credentialId: b, delivery: { kind: 'env' } })
  })
})

describe('acceptance 4: refusals change nothing', () => {
  it('not-on-this-machine and wrong-type, and the session still runs on its old credential', async () => {
    const f = await fixture({ claude: 'fp-here' })
    const a = await f.key('anthropic.api-key', 'A')
    const away = await f.login('anthropic.claude-login', 'Elsewhere', 'fp-not-here')
    const openai = await f.key('openai.api-key', 'OpenAI')
    const sessionId = await f.running('claude-code', a)
    const before = f.daemon.length

    await expect(
      f.caller().sessions.switchCredential({ sessionId, credentialId: away, whenBusy: 'wait' }),
    ).rejects.toThrow(ACCESS_REFUSAL_MESSAGES['not-on-this-machine'])
    await expect(
      f.caller().sessions.switchCredential({ sessionId, credentialId: openai, whenBusy: 'wait' }),
    ).rejects.toThrow(ACCESS_REFUSAL_MESSAGES['wrong-type'])

    expect(await f.row(sessionId)).toMatchObject({ credentialId: a, status: 'live' })
    expect(sequence(f, before)).toEqual([])
    const events = await f.store.settingsAudit.list(50)
    expect(events.filter((e) => e.command === 'credentials.switch')).toEqual([])
  })
})

describe('acceptance 7: a resume that cannot happen becomes a handoff', () => {
  it('the conversation is found nowhere: a new session opens with a summary, the old one stops', async () => {
    const f = await fixture()
    const a = await f.key('anthropic.api-key', 'A')
    const b = await f.key('anthropic.api-key', 'B')
    const sessionId = await f.running('claude-code', a)
    f.script.prepare = (request) =>
      request.fromAccount ? { ok: false, error: 'not-found' } : { ok: true, placed: 'in-place' }

    const result = await f
      .caller()
      .sessions.switchCredential({ sessionId, credentialId: b, whenBusy: 'wait' })

    expect(result.continuedAs).toBe('handoff')
    const next = result.handoffSessionId as SessionId
    expect(next).toBeDefined()
    expect(next).not.toBe(sessionId)
    const spawn = f.frames('spawn').find((frame) => frame.sessionId === next)
    expect(spawn?.resume).toBeUndefined()
    expect(spawn?.access?.credentialId).toBe(b)
    expect(JSON.stringify(spawn)).toContain(`continue the work of session ${sessionId}`)
    expect((await f.row(next))?.credentialId).toBe(b)
    await until(async () => (await f.row(sessionId))?.status !== 'live', 'the old session to stop')
  })

  it('the resumed harness exits at once: handoff', async () => {
    const f = await fixture()
    const a = await f.key('anthropic.api-key', 'A')
    const b = await f.key('anthropic.api-key', 'B')
    const sessionId = await f.running('claude-code', a)
    f.script.exitOnSpawn = (frame) => frame.sessionId === sessionId && frame.resume !== undefined

    const result = await f
      .caller()
      .sessions.switchCredential({ sessionId, credentialId: b, whenBusy: 'wait' })

    expect(result.continuedAs).toBe('handoff')
    expect(result.handoffSessionId).toBeDefined()
  })
})

describe('acceptance 8: switching to no credential', () => {
  it("runs on the harness's own login in its own directory", async () => {
    const f = await fixture()
    const a = await f.key('anthropic.api-key', 'A')
    const sessionId = await f.running('claude-code', a, { resume: 'to-none' })

    expect(
      await f
        .caller()
        .sessions.switchCredential({ sessionId, credentialId: null, whenBusy: 'wait' }),
    ).toEqual({
      continuedAs: 'resume',
    })
    expect(
      f.frames('conversationPrepareRequest').find((p) => p.fromAccount !== undefined),
    ).toMatchObject({
      toHomeId: 'default',
      account: 'none',
      fromAccount: a,
    })
    expect(lastSpawn(f)?.access).toBeUndefined()
    expect(lastSpawn(f)?.resume?.value).toBe('to-none')
    expect((await f.row(sessionId))?.credentialId ?? null).toBeNull()
  })
})

describe('what a switch leaves alone', () => {
  it('the credential it already runs on: nothing recorded, nothing restarted', async () => {
    const f = await fixture()
    const a = await f.key('anthropic.api-key', 'A')
    const sessionId = await f.running('claude-code', a)
    const before = f.daemon.length

    expect(
      await f.caller().sessions.switchCredential({ sessionId, credentialId: a, whenBusy: 'wait' }),
    ).toEqual({ continuedAs: 'resume' })
    expect(sequence(f, before)).toEqual([])
    const events = await f.store.settingsAudit.list(50)
    expect(events.filter((e) => e.command === 'credentials.switch')).toEqual([])
  })

  it('Codex to a ChatGPT plan: the placed copy records the plan’s model provider', async () => {
    const f = await fixture()
    const key = await f.key('openai.api-key', 'Key')
    const plan = await f.key('openai.chatgpt-plan', 'Plan')
    const sessionId = await f.running('codex', key, { driver: 'codex-app-server' })

    await f.caller().sessions.switchCredential({ sessionId, credentialId: plan, whenBusy: 'wait' })

    expect(
      f.frames('conversationPrepareRequest').find((p) => p.fromAccount !== undefined),
    ).toMatchObject({ account: plan, fromAccount: key, modelProvider: 'podium_chatgpt_plan' })
  })
})

describe('acceptance 9: the switch event', () => {
  it('names who switched, from which credential and to which', async () => {
    const f = await fixture()
    const a = await f.key('anthropic.api-key', 'A')
    const b = await f.key('anthropic.api-key', 'B')
    const sessionId = await f.running('claude-code', a)

    await f.caller().sessions.switchCredential({ sessionId, credentialId: b, whenBusy: 'wait' })

    const events = (await f.store.settingsAudit.list(50)).filter(
      (e) => e.command === 'credentials.switch',
    )
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ actorId: f.admin })
    expect(JSON.stringify(events[0])).toContain(`from ${a} to ${b}`)
    expect(JSON.stringify(events)).not.toContain(FAKE_KEY)
    void asUserId
  })
})

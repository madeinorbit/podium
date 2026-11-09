import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  asAccountId,
  asAgentIdentityId,
  asMachineId,
  asRepoId,
  asSessionId,
  asUserId,
  firstAdminMemberId,
  type UserId,
} from '@podium/model'
import type { ServerMessage } from '@podium/protocol'
import type { ControlMessage } from '@podium/protocol/daemon'
import { describe, expect, it, vi } from 'vitest'
import { userCommandPrincipal } from './command-principal'
import { HandoffRefusalError } from './modules/sessions/handoff/refusal'
import { handoffThroughEffect } from './modules/sessions/session-handoff-effect'
import { SuperagentService } from './modules/superagent'
import { SessionRegistry } from './relay'
import { RepoRegistry } from './repo-registry'
import { appRouter } from './router'
import { withReadScope } from './store/executor/read-scope'
import { captureLogs } from './test-support/capture-logs'
import { attachTestClient } from './test-support/client-transport'
import { attachDaemonWithInventory, fixtureInventory } from './test-support/daemon-inventory'
import { openTestStore } from './test-support/open-test-store'
import { clientSessionViews } from './test-support/session-views'

const TEST_PRINCIPAL = userCommandPrincipal(firstAdminMemberId(), 'admin')
const TEST_CAPABILITY = TEST_PRINCIPAL.capability
const TEST_CALLER = { capability: TEST_CAPABILITY, principal: TEST_PRINCIPAL }

async function regWithTwoDaemons() {
  const store = await openTestStore(':memory:')
  await store.machines.upsertMachine({
    id: 'm1',
    name: 'one',
    hostname: 'one',
    tokenHash: 'x',
    ownerUserId: firstAdminMemberId(),
    assignment: { server: false, agentExecution: true },
  })
  await store.machines.upsertMachine({
    id: 'm2',
    name: 'two',
    hostname: 'two',
    tokenHash: 'y',
    ownerUserId: firstAdminMemberId(),
    assignment: { server: false, agentExecution: true },
  })
  const inventory = fixtureInventory({
    agents: [{ kind: 'codex', installed: true, login: { state: 'in' } }],
  })
  await store.machines.setMachineInventory('m1', JSON.stringify(inventory))
  await store.machines.setMachineInventory('m2', JSON.stringify(inventory))
  const reg = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
  const m1: ControlMessage[] = []
  const m2: ControlMessage[] = []
  await attachDaemonWithInventory(reg, 'm1', (msg) => m1.push(msg), inventory)
  await attachDaemonWithInventory(reg, 'm2', (msg) => m2.push(msg), inventory)
  return { reg, m1, m2 }
}

const SHARED_MACHINE = asMachineId('shared-auth-machine')
const COLLEAGUE = asUserId('user:colleague')

async function regWithRevocableMachineGrant() {
  const store = await openTestStore(':memory:')
  await store.machines.upsertMachine({
    id: SHARED_MACHINE,
    name: 'shared',
    hostname: 'shared',
    tokenHash: 'shared-token',
    ownerUserId: COLLEAGUE,
    assignment: { server: false, agentExecution: true },
  })
  await store.machines.setMachineInventory(
    SHARED_MACHINE,
    JSON.stringify({
      os: 'linux',
      arch: 'x64',
      agents: [
        { kind: 'codex', installed: true, login: { state: 'out' } },
        { kind: 'claude-code', installed: true, login: { state: 'out' } },
      ],
      tools: [],
    }),
  )
  await store.grants.upsert({
    resourceKind: 'machine',
    resourceId: SHARED_MACHINE,
    grantee: firstAdminMemberId(),
    verb: 'use',
    owner: COLLEAGUE,
    visibility: 'owned-compute',
    createdAt: '2026-09-05T00:00:00.000Z',
    actorKind: 'user',
    actorId: COLLEAGUE,
    onBehalfOf: COLLEAGUE,
  })
  await store.grants.upsert({
    resourceKind: 'machine',
    resourceId: SHARED_MACHINE,
    grantee: firstAdminMemberId(),
    verb: 'see',
    owner: COLLEAGUE,
    visibility: 'owned-compute',
    createdAt: '2026-09-05T00:00:00.001Z',
    actorKind: 'user',
    actorId: COLLEAGUE,
    onBehalfOf: COLLEAGUE,
  })
  const reg = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
  await reg.gateway.attachDaemon(SHARED_MACHINE, () => {})
  await reg.gateway.routeDaemonFrame(SHARED_MACHINE, {
    type: 'inventoryReport',
    machineId: SHARED_MACHINE,
    inventory: {
      os: 'linux',
      arch: 'x64',
      agents: [
        { kind: 'codex', installed: true, login: { state: 'out' } },
        { kind: 'claude-code', installed: true, login: { state: 'out' } },
      ],
      tools: [],
    },
  })

  let grantReads = 0
  const liveGrants = reg.modules.machines.grantsForMachine.bind(reg.modules.machines)
  const liveFleetGrants = reg.modules.machines.grantsForMachines.bind(reg.modules.machines)
  // One read of this machine's edges, by either the single or the fleet read;
  // the first one is followed by a revocation.
  const counted = async () => {
    grantReads += 1
    if (grantReads === 1) {
      await store.grants.remove('machine', SHARED_MACHINE, firstAdminMemberId(), 'use')
    }
  }
  const revokeAfterFirstGrantRead = () => {
    vi.spyOn(reg.modules.machines, 'grantsForMachine').mockImplementation(async (machineId) => {
      const snapshot = await liveGrants(machineId)
      // The ownership snapshot also reads the host machine; count this resource only.
      if (machineId === SHARED_MACHINE) await counted()
      return snapshot
    })
    vi.spyOn(reg.modules.machines, 'grantsForMachines').mockImplementation(async (machineIds) => {
      const snapshot = await liveFleetGrants(machineIds)
      if (machineIds.includes(SHARED_MACHINE)) await counted()
      return snapshot
    })
  }

  return { reg, store, grantReads: () => grantReads, revokeAfterFirstGrantRead }
}

describe('rule 46 grant snapshots at relay composition', () => {
  it('holds the mail machine grant for one pass and re-reads it for the next pass', async () => {
    const { reg, grantReads, revokeAfterFirstGrantRead } = await regWithRevocableMachineGrant()
    // The revocation also rewrites the machine's access records (POD-6644),
    // which read the grants on their own account; only the login's reads count.
    vi.spyOn(reg.modules.machines, 'publishMachines').mockResolvedValue()
    revokeAfterFirstGrantRead()
    const gate = reg.modules.messageGate as unknown as {
      policyFor?: (principal: typeof TEST_PRINCIPAL) => Promise<{
        machines: { mayUse(machineId: typeof SHARED_MACHINE): boolean }
      }>
    }
    const policyFor = gate.policyFor
    expect(policyFor).toBeTypeOf('function')
    if (!policyFor) throw new Error('dynamic relay policy is not wired')

    await withReadScope(async () => {
      const access = (await policyFor(TEST_PRINCIPAL)).machines
      expect(access.mayUse(SHARED_MACHINE)).toBe(true)
      expect(access.mayUse(SHARED_MACHINE)).toBe(true)
    })
    expect(grantReads()).toBe(1)

    await withReadScope(async () => {
      expect((await policyFor(TEST_PRINCIPAL)).machines.mayUse(SHARED_MACHINE)).toBe(false)
    })
    expect(grantReads()).toBe(2)
  })

  it('holds the native-login grant through selection and re-reads it for the next login', async () => {
    const { reg, grantReads, revokeAfterFirstGrantRead } = await regWithRevocableMachineGrant()
    revokeAfterFirstGrantRead()

    // A member logs in only on a machine in their own custody (design §2.4,
    // §2.5; POD-6300 26568b8f5f): a `use` grant on the colleague's machine
    // never selects it, since logging in there would replace the colleague's
    // login. The pass still reads the grants once.
    await expect(
      reg.modules.nativeLogin.start({
        harness: 'codex',
        ownerUserId: firstAdminMemberId(),
      }),
    ).rejects.toThrow('no online machine of yours can run codex login')
    expect(grantReads()).toBe(1)

    await expect(
      reg.modules.nativeLogin.start({
        harness: 'claude-code',
        machineId: SHARED_MACHINE,
        ownerUserId: firstAdminMemberId(),
      }),
    ).rejects.toThrow('you do not have access to start login on this machine')
    expect(grantReads()).toBe(2)
  })
})

describe('multi-daemon routing', () => {
  it('routes a spawn to the chosen machine only', async () => {
    const { reg, m1, m2 } = await regWithTwoDaemons()
    await reg.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/x',
      machineId: asMachineId('m2'),
    })
    expect(m1.filter((m) => m.type === 'spawn')).toHaveLength(0)
    expect(m2.filter((m) => m.type === 'spawn')).toHaveLength(1)
  })

  it('a session carries its machineId in meta', async () => {
    const { reg } = await regWithTwoDaemons()
    const { sessionId } = await reg.modules.sessions.createSession({
      agentKind: 'shell',
      cwd: '/x',
      machineId: asMachineId('m2'),
    })
    const meta = (await clientSessionViews(reg)).find((s) => s.sessionId === sessionId)
    expect(meta).toBeDefined()
    expect(meta?.machineId).toBe('m2')
    expect(meta?.machineName).toBe('two')
  })

  it.each([
    ['/repo', '/repo'],
    [String.raw`c:\repo`, 'C:/REPO'],
  ])('machine paths: remote worktree adoption under %s', async (root, reportedRoot) => {
    const { reg } = await regWithTwoDaemons()
    try {
      await reg.sessionStore.repos.addRepo(root, asMachineId('m2'))
      const issue = await reg.modules.issues.crud.create(reg.modules.issues.reports.store.serverWriter, {
        repoPath: root,
        title: 'Remote adoption',
        startNow: false,
      })
      const { sessionId } = await reg.modules.sessions.createSession({
        agentKind: 'codex',
        cwd: root,
        issueId: issue.id,
        machineId: asMachineId('m2'),
      })

      await reg.gateway.routeDaemonFrame('m2', {
        type: 'sessionCwd',
        sessionId,
        cwd: reportedRoot + '/.worktrees/remote-adoption',
        kind: 'worktree',
        branch: 'issue/remote-adoption',
        repoRoot: reportedRoot,
      })

      await expect
        .poll(() => reg.modules.issues.reports.get(issue.id))
        .toMatchObject({
          worktreePath: reportedRoot + '/.worktrees/remote-adoption',
          branch: 'issue/remote-adoption',
          machineId: 'm2',
        })
    } finally {
      await reg.dispose()
    }
  })

  it('acknowledges an exact native binding back to its owner after storing it', async () => {
    const { reg, m1, m2 } = await regWithTwoDaemons()
    const { sessionId } = await reg.modules.sessions.createSession({
      agentKind: 'codex',
      cwd: '/x',
      machineId: asMachineId('m1'),
    })
    m1.length = 0

    await reg.gateway.routeDaemonFrame('m1', {
      type: 'sessionResumeRef',
      sessionId,
      resume: { kind: 'codex-thread', value: 'thread-a' },
      confidence: 'exact',
      ackRequested: true,
    })

    expect(
      (await clientSessionViews(reg)).find((session) => session.sessionId === sessionId)?.resume,
    ).toEqual({ kind: 'codex-thread', value: 'thread-a' })
    expect(m1).toContainEqual({
      type: 'sessionResumeRefAck',
      sessionId,
      resume: { kind: 'codex-thread', value: 'thread-a' },
      ownerId: firstAdminMemberId(),
    })
    expect(m2).not.toContainEqual(expect.objectContaining({ type: 'sessionResumeRefAck' }))
  })

  it('rejects a native binding and acknowledgement from a non-owner daemon', async () => {
    const { reg, m1, m2 } = await regWithTwoDaemons()
    const { sessionId } = await reg.modules.sessions.createSession({
      agentKind: 'codex',
      cwd: '/x',
      machineId: asMachineId('m1'),
    })
    m1.length = 0
    m2.length = 0

    await reg.gateway.routeDaemonFrame('m2', {
      type: 'sessionResumeRef',
      sessionId,
      resume: { kind: 'codex-thread', value: 'foreign-thread' },
      confidence: 'exact',
      ackRequested: true,
    })

    expect(
      (await clientSessionViews(reg)).find((session) => session.sessionId === sessionId)?.resume,
    ).toBeUndefined()
    expect(m1).not.toContainEqual(expect.objectContaining({ type: 'sessionResumeRefAck' }))
    expect(m2).not.toContainEqual(expect.objectContaining({ type: 'sessionResumeRefAck' }))
  })

  it('refuses an RPC reply from a machine the request was never sent to (POD-1175)', async () => {
    // THE TEST THAT COULD NOT BE WRITTEN BEFORE POD-318. The pending maps were
    // keyed by requestId ALONE, so this listing — m2's disk, answered under m1's
    // correlation id — settled the browse the operator asked m1 for. The whole
    // path is exercised: real gateway, real mux principal, real correlator.
    const { reg, m1, m2 } = await regWithTwoDaemons()
    const logs = captureLogs()

    const browse = reg.modules.rpc.browseDirs('/home/one', {}, asMachineId('m1'))
    await expect.poll(() => m1.some((msg) => msg.type === 'browseDirsRequest')).toBe(true)
    const request = m1.find((msg) => msg.type === 'browseDirsRequest')
    expect(request, 'the browse must have been sent to m1').toBeDefined()
    expect(m2.filter((msg) => msg.type === 'browseDirsRequest')).toHaveLength(0)
    const requestId = (request as { requestId: string }).requestId

    // m2 answers a request it was never sent, quoting m1's id.
    await reg.gateway.routeDaemonFrame('m2', {
      type: 'browseDirsResult',
      requestId,
      listing: {
        path: '/home/two',
        homePath: '/home/two',
        parentPath: null,
        entries: [{ name: 'secrets', path: '/home/two/secrets' }],
      },
    })
    // The two machine ids are FIELDS now, so this pins which was which rather
    // than their adjacency in a sentence.
    expect(logs.at('error')).toContainEqual(
      expect.objectContaining({ answeredBy: 'm2', sentTo: 'm1' }),
    )

    // …and the caller is still waiting: m1's own answer is what settles it, so
    // the drop neither leaked m2's listing nor consumed the request.
    await reg.gateway.routeDaemonFrame('m1', {
      type: 'browseDirsResult',
      requestId,
      listing: {
        path: '/home/one',
        homePath: '/home/one',
        parentPath: null,
        entries: [{ name: 'src', path: '/home/one/src' }],
      },
    })
    await expect(browse).resolves.toEqual({
      listing: {
        path: '/home/one',
        homePath: '/home/one',
        parentPath: null,
        entries: [{ name: 'src', path: '/home/one/src' }],
      },
    })
    logs.restore()
  })

  it('detaching m1 only marks m1 sessions reconnecting', async () => {
    const { reg } = await regWithTwoDaemons()
    const a = (
      await reg.modules.sessions.createSession({
        agentKind: 'shell',
        cwd: '/a',
        machineId: asMachineId('m1'),
      })
    ).sessionId
    const b = (
      await reg.modules.sessions.createSession({
        agentKind: 'shell',
        cwd: '/b',
        machineId: asMachineId('m2'),
      })
    ).sessionId
    // mark both live as a bind would
    await reg.gateway.routeDaemonFrame('m1', {
      type: 'bind',
      sessionId: a,
      cmd: 'x',
      cwd: '/a',
      agentKind: 'shell',
      geometry: { cols: 80, rows: 24 },
    })
    await reg.gateway.routeDaemonFrame('m2', {
      type: 'bind',
      sessionId: b,
      cmd: 'x',
      cwd: '/b',
      agentKind: 'shell',
      geometry: { cols: 80, rows: 24 },
    })
    reg.gateway.detachDaemon('m1')
    const meta = async (id: string) =>
      (await clientSessionViews(reg)).find((s) => s.sessionId === id)
    // Neither row changes: m1's session reads as reconnecting from m1's link
    // (ADR 12 D1), which the server now reports as down.
    expect((await meta(a))?.status).toBe('live')
    expect((await meta(b))?.status).toBe('live')
    expect(reg.modules.machines.hasDaemon('m1' as never)).toBe(false)
    expect(reg.modules.machines.hasDaemon('m2' as never)).toBe(true)
  })

  it('lists machines with their online status from the registry', async () => {
    vi.useFakeTimers()
    try {
      const { reg } = await regWithTwoDaemons()
      const machines = await reg.modules.machines.listMachines()
      expect(machines.find((m) => m.id === 'm1')?.online).toBe(true)
      expect(machines.find((m) => m.id === 'm2')?.online).toBe(true)
      reg.gateway.detachDaemon('m1')
      expect((await reg.modules.machines.listMachines()).find((m) => m.id === 'm1')?.online).toBe(
        true,
      )

      await vi.advanceTimersByTimeAsync(30_001)
      const after = await reg.modules.machines.listMachines()
      expect(after.find((m) => m.id === 'm1')?.online).toBe(false)
      expect(after.find((m) => m.id === 'm2')?.online).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('routes an unresolved spawn (no machineId, unregistered cwd) to an online machine, not __local__', async () => {
    const { reg, m1, m2 } = await regWithTwoDaemons()
    // No machineId provided, cwd matches no registered repo — must NOT dead-queue under __local__.
    await reg.modules.sessions.createSession({ agentKind: 'shell', cwd: '/no/repo/here' })
    const spawns = [...m1, ...m2].filter((m) => m.type === 'spawn')
    // The spawn must have reached one of the online daemons, not vanished into __local__.
    expect(spawns).toHaveLength(1)
    // Confirm the session's machineId is one of the two online machines.
    const sessions = await clientSessionViews(reg)
    expect(sessions).toHaveLength(1)
    expect(['m1', 'm2']).toContain(sessions[0]?.machineId)
  })

  it('host metrics are scoped per machine', async () => {
    const { reg } = await regWithTwoDaemons()
    const sent: import('@podium/protocol').ServerMessage[] = []
    attachTestClient(reg.clientGateway, (m) => sent.push(m))
    await reg.gateway.routeDaemonFrame('m1', {
      type: 'hostMetrics',
      hostname: 'one',
      sampledAt: '2026-06-11T00:00:00.000Z',
      memory: { totalBytes: 32, availableBytes: 16, swapTotalBytes: 0, swapFreeBytes: 0 },
    })
    await reg.gateway.routeDaemonFrame('m2', {
      type: 'hostMetrics',
      hostname: 'two',
      sampledAt: '2026-06-11T00:00:00.000Z',
      memory: { totalBytes: 32, availableBytes: 8, swapTotalBytes: 0, swapFreeBytes: 0 },
    })
    const last = sent
      .filter(
        (
          m,
        ): m is Extract<import('@podium/protocol').ServerMessage, { type: 'hostMetricsChanged' }> =>
          m.type === 'hostMetricsChanged',
      )
      .at(-1)
    const ids = last?.hosts.map((h) => h.machineId).sort()
    expect(ids).toEqual(['m1', 'm2'])
    // detaching m1 drops only its sample
    reg.gateway.detachDaemon('m1')
    const afterDetach = sent
      .filter(
        (
          m,
        ): m is Extract<import('@podium/protocol').ServerMessage, { type: 'hostMetricsChanged' }> =>
          m.type === 'hostMetricsChanged',
      )
      .at(-1)
    expect(afterDetach?.hosts.map((h) => h.machineId)).toEqual(['m2'])
  })
})

async function handoffRegistry(
  opts: {
    failExport?: boolean
    landInSubdir?: boolean
    oldDaemon?: boolean
    targetHasRepo?: boolean
    withIssue?: boolean
    /** A second member who holds custody of the SOURCE machine, starts the
     *  session, and holds only `use` on the target, which stays the admin's. */
    secondMember?: UserId
  } = {},
) {
  const store = await openTestStore(':memory:')
  if (opts.secondMember) {
    await store.users.create(
      {
        id: opts.secondMember,
        displayName: 'Bob',
        role: 'member',
        createdAt: new Date().toISOString(),
        disabledAt: null,
      },
      'unused-password-hash',
    )
  }
  await store.machines.upsertMachine({
    id: 'm1',
    name: 'source',
    hostname: 'source',
    tokenHash: 'x',
    ownerUserId: opts.secondMember ?? firstAdminMemberId(),
    assignment: { server: false, agentExecution: true },
  })
  await store.machines.upsertMachine({
    id: 'm2',
    name: 'target',
    hostname: 'target',
    tokenHash: 'y',
    ownerUserId: firstAdminMemberId(),
    assignment: { server: false, agentExecution: true },
  })
  const inventory = fixtureInventory({
    agents: [{ kind: 'claude-code', installed: true, login: { state: 'in' } }],
  })
  await store.machines.setMachineInventory('m1', JSON.stringify(inventory))
  await store.machines.setMachineInventory('m2', JSON.stringify(inventory))
  await store.repos.addRepo('/source/repo', asMachineId('m1'), 'git@github.com:example/repo.git')
  const sourceRepoId = (await store.repos.listRepos(asMachineId('m1')))[0]?.repoId
  if (!sourceRepoId) throw new Error('source repo id not minted')
  let targetRepoPath = '/target/repo'
  if (opts.targetHasRepo !== false)
    await store.repos.addRepo(targetRepoPath, asMachineId('m2'), 'git@github.com:example/repo.git')
  if (opts.secondMember) {
    await store.grants.upsert({
      resourceKind: 'machine',
      resourceId: 'm2',
      grantee: opts.secondMember,
      verb: 'use',
      owner: firstAdminMemberId(),
      visibility: 'owned-compute',
      createdAt: new Date().toISOString(),
      actorKind: 'user',
      actorId: firstAdminMemberId(),
      onBehalfOf: firstAdminMemberId(),
    })
    // On the admin's machine Bob's run uses only Bob's own connection, which he
    // sent there; the admin's native login is never used for him (design §2.4,
    // §2.5; 26568b8f5f). Selected on Bob's coding role and sent to both machines.
    const accountId = asAccountId('managed:anthropic')
    await store.accounts.upsert({
      id: accountId,
      ownerUserId: opts.secondMember,
      provider: 'anthropic',
      kind: 'api-key',
      credential: 'sk-ant-bob',
      identity: 'bob@example.com',
      scope: 'role',
      createdAt: 1,
    })
    for (const machineId of ['m1', 'm2'] as const) {
      await store.accounts.markSent(
        opts.secondMember,
        accountId,
        asMachineId(machineId),
        '2026-11-04T00:00:00.000Z',
      )
    }
    const settings = await store.settings.getSettingsFor(opts.secondMember)
    await store.settings.setSettingsFor(
      opts.secondMember,
      { ...settings, roles: { ...settings.roles, coding: { ...settings.roles.coding, accountId } } },
      '2026-11-04T00:00:00.000Z',
    )
  }
  const reg = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
  const source: ControlMessage[] = []
  const target: ControlMessage[] = []
  const sha = 'a'.repeat(40)
  await attachDaemonWithInventory(reg, 'm1', (msg) => {
    source.push(msg)
    if (msg.type === 'repoOpRequest') {
      const exists = msg.args?.ref === 'main'
      reg.gateway.routeDaemonFrame('m1', {
        type: 'repoOpResult',
        requestId: msg.requestId,
        ok: exists,
        output: exists ? sha : 'missing',
      })
    }
    if (msg.type === 'handoffExportRequest') {
      const manifest = {
        format: 1 as const,
        sessionId: msg.sessionId,
        agentKind: 'claude-code' as const,
        resume: { kind: 'claude-session' as const, value: 'native-id' },
        transcriptFilename: 'native-id.jsonl',
        repoId: asRepoId(sourceRepoId),
        branch: 'x',
        headSha: sha,
        snapshotSha: null,
        snapshotFlattened: true as const,
        worktreeName: 'x',
        worktreeRelativePath: '.worktrees/x',
        bundleBase: [sha],
        sourceMachineId: asMachineId('m1'),
        exportedAt: new Date().toISOString(),
      }
      reg.gateway.routeDaemonFrame(
        'm1',
        opts.failExport
          ? {
              type: 'handoffExportResult',
              requestId: msg.requestId,
              ok: false,
              error: 'export exploded',
            }
          : {
              type: 'handoffExportResult',
              requestId: msg.requestId,
              ok: true,
              manifest,
              stagePath: '/home/source/.podium/handoff/package.tgz',
              sizeBytes: 3,
              binding: {
                transferId: msg.binding?.transferId ?? 'missing-transfer',
                sessionId: msg.sessionId,
                agentKind: 'claude-code',
                fromMachineId: asMachineId('m1'),
                toMachineId: asMachineId('m2'),
                observationGeneration: 2,
                delegation: {
                  actor: asAgentIdentityId(msg.sessionId),
                  onBehalfOf: firstAdminMemberId(),
                  grantedScope: { kind: 'all' },
                  parentBindingId: null,
                },
              },
            },
      )
    }
    if (msg.type === 'handoffChunkReadRequest')
      reg.gateway.routeDaemonFrame('m1', {
        type: 'handoffChunkReadResult',
        requestId: msg.requestId,
        ok: true,
        data: Buffer.from('pkg').toString('base64'),
        sizeBytes: 3,
        eof: true,
      })
    if (msg.type === 'handoffBindingFinalizeRequest')
      reg.gateway.routeDaemonFrame('m1', {
        type: 'handoffBindingFinalizeResult',
        requestId: msg.requestId,
        ok: true,
        observationGeneration: 2,
      })
  })
  await attachDaemonWithInventory(reg, 'm2', (msg) => {
    target.push(msg)
    if (msg.type === 'browseDirsRequest')
      reg.gateway.routeDaemonFrame('m2', {
        type: 'browseDirsResult',
        requestId: msg.requestId,
        listing: {
          path: '/home/target',
          homePath: '/home/target',
          parentPath: '/home',
          entries: [],
        },
      })
    if (msg.type === 'repoOpRequest' && msg.op === 'clone') {
      targetRepoPath = msg.args?.path ?? targetRepoPath
      reg.gateway.routeDaemonFrame('m2', {
        type: 'repoOpResult',
        requestId: msg.requestId,
        ok: true,
        output: '',
      })
    } else if (msg.type === 'repoOpRequest') {
      const exists = msg.args?.ref === sha
      reg.gateway.routeDaemonFrame('m2', {
        type: 'repoOpResult',
        requestId: msg.requestId,
        ok: exists,
        output: exists ? sha : 'missing',
      })
    }
    if (msg.type === 'handoffImportChunk')
      reg.gateway.routeDaemonFrame('m2', {
        type: 'handoffImportChunkResult',
        requestId: msg.requestId,
        ok: true,
        sizeBytes: msg.offset + Buffer.from(msg.data, 'base64').length,
      })
    if (msg.type === 'handoffImportRequest')
      reg.gateway.routeDaemonFrame('m2', {
        type: 'handoffImportResult',
        requestId: msg.requestId,
        ok: true,
        // `newCwd` is where the AGENT lands — the worktree root, or a subdir when the
        // session carried a cwdSubpath. `worktreeRoot` is the worktree itself; the
        // issue's home is always the root (POD-824). An older daemon omits it.
        newCwd: opts.landInSubdir
          ? `${targetRepoPath}/.worktrees/x/apps/web`
          : `${targetRepoPath}/.worktrees/x`,
        ...(opts.oldDaemon ? {} : { worktreeRoot: `${targetRepoPath}/.worktrees/x` }),
        observationGeneration: 2,
      })
    if (msg.type === 'handoffBindingFinalizeRequest')
      reg.gateway.routeDaemonFrame('m2', {
        type: 'handoffBindingFinalizeResult',
        requestId: msg.requestId,
        ok: true,
        observationGeneration: 2,
      })
  })
  // An issue homed on the SOURCE machine, as `issue start` would leave it.
  const issue = opts.withIssue
    ? await reg.modules.issues.crud.create(reg.modules.issues.reports.store.serverWriter, { repoPath: '/source/repo', title: 'handoff me', startNow: false })
    : undefined
  if (issue) {
    await reg.modules.issues.crud.update(reg.modules.issues.reports.store.serverWriter, issue.id, {
      worktreePath: '/source/repo/.worktrees/x',
      branch: 'x',
      machineId: asMachineId('m1'),
    })
  }
  const { sessionId } = await reg.modules.issueSessionLifecycle.resumeSession({
    agentKind: 'claude-code',
    cwd: '/source/repo/.worktrees/x',
    resume: { kind: 'claude-session', value: 'native-id' },
    conversationId: 'native-id',
    machineId: asMachineId('m1'),
    ...(issue ? { issueId: issue.id } : {}),
    ...(opts.secondMember ? { ownerUserId: opts.secondMember } : {}),
  })
  return { reg, source, target, sessionId, issueId: issue?.id, store }
}

describe('session handoff orchestration', () => {
  it('a session handed off to a machine its owner may only use still acts for its owner (POD-6286)', async () => {
    const prior = process.env.PODIUM_STATE_DIR
    process.env.PODIUM_STATE_DIR = mkdtempSync(join(tmpdir(), 'podium-handoff-server-'))
    try {
      // Bob's session on Bob's machine moves to the admin's machine, where Bob
      // holds only `use`. It is still Bob's, and its agent still acts for Bob.
      const bob = asUserId('mem_handoff_bob')
      const { reg, target, sessionId, store } = await handoffRegistry({ secondMember: bob })
      const bobPrincipal = userCommandPrincipal(bob, 'member')
      await reg.modules.issueSessionLifecycle.handoffSession(
        { sessionId, machineId: asMachineId('m2') },
        { capability: bobPrincipal.capability, principal: bobPrincipal },
      )
      const row = await store.sessions.getSession(sessionId)
      expect(row).toMatchObject({ machineId: 'm2', ownerUserId: bob })
      expect(row?.delegation?.onBehalfOf).toBe(bob)
      expect((await reg.modules.sessions.capabilityForSession(sessionId)).onBehalfOf).toBe(bob)
      // The target daemon is handed Bob's delegation, not its custodian's.
      const imported = target.find((m) => m.type === 'handoffImportRequest')
      expect(JSON.stringify(imported)).toContain(`"onBehalfOf":"${bob}"`)
      expect(JSON.stringify(imported)).not.toContain(`"onBehalfOf":"${firstAdminMemberId()}"`)
    } finally {
      if (prior === undefined) delete process.env.PODIUM_STATE_DIR
      else process.env.PODIUM_STATE_DIR = prior
    }
  })

  it('re-homes the canonical row and resumes it on the target', async () => {
    const prior = process.env.PODIUM_STATE_DIR
    process.env.PODIUM_STATE_DIR = mkdtempSync(join(tmpdir(), 'podium-handoff-server-'))
    try {
      const { reg, source, target, sessionId } = await handoffRegistry()
      await reg.modules.issueSessionLifecycle.handoffSession(
        { sessionId, machineId: asMachineId('m2') },
        TEST_CALLER,
      )
      expect(await clientSessionViews(reg)).toMatchObject([
        { sessionId, machineId: 'm2', cwd: '/target/repo/.worktrees/x', status: 'starting' },
      ])
      // The source process is retired through the driver lifecycle BEFORE the
      // export (722704624, POD-4302) — it used to be a raw `kill` frame followed
      // by a fixed 500ms release sleep. The source daemon here confirms the
      // retirement like a real one (attachDaemonWithInventory), so the legacy
      // `kill` escalation for an unconfirmed retirement must not be sent.
      const retire = source.findIndex(
        (m) => m.type === 'runtimeLifecycleRequest' && m.sessionId === sessionId,
      )
      expect(source[retire]).toMatchObject({
        type: 'runtimeLifecycleRequest',
        sessionId,
        verb: 'stop',
      })
      expect(retire).toBeLessThan(source.findIndex((m) => m.type === 'handoffExportRequest'))
      expect(source.filter((m) => m.type === 'kill')).toEqual([])
      expect(target).toContainEqual(
        expect.objectContaining({ type: 'spawn', sessionId, cwd: '/target/repo/.worktrees/x' }),
      )
    } finally {
      if (prior === undefined) delete process.env.PODIUM_STATE_DIR
      else process.env.PODIUM_STATE_DIR = prior
    }
  })

  it('ignores a stale source cwd frame after handoff', async () => {
    const { reg, sessionId } = await handoffRegistry()
    await reg.modules.issueSessionLifecycle.handoffSession(
      { sessionId, machineId: asMachineId('m2') },
      TEST_CALLER,
    )

    await reg.gateway.routeDaemonFrame('m1', {
      type: 'sessionCwd',
      sessionId,
      cwd: '/source/repo/.worktrees/stale',
      kind: 'worktree',
      repoRoot: '/source/repo',
    })
    expect(await clientSessionViews(reg)).toMatchObject([
      { sessionId, machineId: 'm2', cwd: '/target/repo/.worktrees/x' },
    ])

    await reg.gateway.routeDaemonFrame('m2', {
      type: 'sessionCwd',
      sessionId,
      cwd: '/target/repo/.worktrees/x/apps/web',
      kind: 'worktree',
      repoRoot: '/target/repo',
    })
    expect(await clientSessionViews(reg)).toMatchObject([
      { sessionId, machineId: 'm2', cwd: '/target/repo/.worktrees/x/apps/web' },
    ])
  })

  it('clones and registers the repository before handing off to a fresh target', async () => {
    const { reg, target, sessionId, store } = await handoffRegistry({ targetHasRepo: false })
    await reg.modules.issueSessionLifecycle.handoffSession(
      { sessionId, machineId: asMachineId('m2') },
      TEST_CALLER,
    )
    const targetRepo = (await store.repos.listRepos(asMachineId('m2')))[0]
    expect(targetRepo).toMatchObject({
      machineId: 'm2',
      originUrl: 'git@github.com:example/repo.git',
    })
    expect(targetRepo?.path).toMatch(/^\/home\/target\/podium-repos\/repo-/u)
    expect(target).toContainEqual(expect.objectContaining({ type: 'browseDirsRequest' }))
    expect(target).toContainEqual(
      expect.objectContaining({
        type: 'repoOpRequest',
        op: 'clone',
        args: expect.objectContaining({
          originUrl: 'git@github.com:example/repo.git',
          path: targetRepo?.path,
        }),
      }),
    )
    expect(await clientSessionViews(reg)).toMatchObject([
      {
        sessionId,
        machineId: 'm2',
        cwd: `${targetRepo?.path}/.worktrees/x`,
        status: 'starting',
      },
    ])
  })

  it('clones and remaps the cwd before creating a new session on a fresh target', async () => {
    const { reg, target, store } = await handoffRegistry({ targetHasRepo: false })
    const prepared = await reg.modules.sessions.workspace.prepareTarget({
      agentKind: 'claude-code',
      cwd: '/source/repo',
      machineId: asMachineId('m2'),
      owner: firstAdminMemberId(),
    })
    const targetRepo = (await store.repos.listRepos(asMachineId('m2')))[0]
    expect(prepared).toEqual({ cwd: targetRepo?.path, machineId: 'm2' })
    const { sessionId } = await reg.modules.sessions.createSession({
      agentKind: 'claude-code',
      ...prepared,
    })
    expect(target).toContainEqual(
      expect.objectContaining({
        type: 'spawn',
        sessionId,
        cwd: targetRepo?.path,
      }),
    )
  })

  it('resolves the source repo from the issue worktree when rollback restored a stale cwd', async () => {
    const { reg, source, sessionId, issueId } = await handoffRegistry({ withIssue: true })
    // The old daemon restamped only the session after rollback; kind=none does not
    // adopt the stale location onto the issue, so its real worktree survives.
    await reg.gateway.routeDaemonFrame('m1', {
      type: 'sessionCwd',
      sessionId,
      cwd: '/old-machine/repo',
      kind: 'none',
    })
    expect(await reg.modules.issues.reports.getMeta(issueId!)).toMatchObject({
      worktreePath: '/source/repo/.worktrees/x',
      machineId: asMachineId('m1'),
    })
    await reg.modules.issueSessionLifecycle.handoffSession(
      { sessionId, machineId: asMachineId('m2') },
      TEST_CALLER,
    )
    expect(source).toContainEqual(
      expect.objectContaining({
        type: 'handoffExportRequest',
        cwd: '/old-machine/repo',
        fallbackCwd: '/source/repo/.worktrees/x',
      }),
    )
  })

  it('protects worktrees owned by another target session during import', async () => {
    const { reg, target, sessionId } = await handoffRegistry()
    await reg.modules.issueSessionLifecycle.resumeSession({
      agentKind: 'claude-code',
      cwd: '/target/repo/.claude/worktrees/shared',
      resume: { kind: 'claude-session', value: 'other-native-id' },
      conversationId: 'other-native-id',
      machineId: asMachineId('m2'),
    })
    await reg.modules.issueSessionLifecycle.handoffSession(
      { sessionId, machineId: asMachineId('m2') },
      TEST_CALLER,
    )
    expect(target).toContainEqual(
      expect.objectContaining({
        type: 'handoffImportRequest',
        occupiedWorktreePaths: ['/target/repo/.claude/worktrees/shared'],
      }),
    )
  })

  it('invalidates the repo lists on both machines so the moved session stays handoff-eligible', async () => {
    // POD-821: the import runs `git worktree add` on the target, so the moved
    // session's new cwd is a worktree NO client has scanned. Clients re-fetch repos
    // only on boot / a machine coming online / this invalidation, and the handoff
    // gate resolves a session's cwd against that list — without it the session that
    // just arrived cannot be handed back until a reload.
    const prior = process.env.PODIUM_STATE_DIR
    process.env.PODIUM_STATE_DIR = mkdtempSync(join(tmpdir(), 'podium-handoff-server-'))
    try {
      const { reg, sessionId } = await handoffRegistry()
      // Both machines' checkouts moved: each is scanned (POD-6644), and what
      // changed reaches every device as `checkout` records.
      const rescans = vi.spyOn(reg.modules.checkouts, 'rescanSoon').mockImplementation(() => {})
      await reg.modules.issueSessionLifecycle.handoffSession(
        { sessionId, machineId: asMachineId('m2') },
        TEST_CALLER,
      )
      await expect.poll(() => rescans.mock.calls.map(([machine]) => machine)).toEqual(['m2', 'm1'])
    } finally {
      if (prior === undefined) delete process.env.PODIUM_STATE_DIR
      else process.env.PODIUM_STATE_DIR = prior
    }
  })

  it("moves the issue's home to the target worktree, not the agent's subdir (POD-824)", async () => {
    // The issue's home drives the file-browser root, the sidebar's worktree, and the
    // cwd a NEW agent on this issue spawns into. Left on the source it points at a
    // machine the work is no longer on. repoPath must travel with machineId, or the
    // issue cannot start: requireMachineForRepo rejects a path m2 never registered.
    const prior = process.env.PODIUM_STATE_DIR
    process.env.PODIUM_STATE_DIR = mkdtempSync(join(tmpdir(), 'podium-handoff-server-'))
    try {
      const { reg, sessionId, issueId } = await handoffRegistry({
        withIssue: true,
        landInSubdir: true,
      })
      const before = await reg.modules.issues.reports.get(issueId!)
      expect(before).toMatchObject({ repoPath: '/source/repo', machineId: 'm1' })
      await reg.modules.issueSessionLifecycle.handoffSession(
        { sessionId, machineId: asMachineId('m2') },
        TEST_CALLER,
      )
      expect(await reg.modules.issues.reports.get(issueId!)).toMatchObject({
        // The ROOT, even though the agent resumed in .../x/apps/web.
        worktreePath: '/target/repo/.worktrees/x',
        repoPath: '/target/repo',
        machineId: 'm2',
      })
      // Identity survives the move: the nice-id prefix and repo scoping resolve
      // through repoId, which is origin-derived and the same on both machines.
      expect((await reg.modules.issues.reports.get(issueId!))?.seq).toBe(before?.seq)
    } finally {
      if (prior === undefined) delete process.env.PODIUM_STATE_DIR
      else process.env.PODIUM_STATE_DIR = prior
    }
  })

  it("leaves the issue's home alone when the daemon is too old to report the worktree", async () => {
    // Rather than guess the root by stripping cwdSubpath off newCwd — the daemon
    // owns that layout — an absent worktreeRoot means no re-home at all.
    const prior = process.env.PODIUM_STATE_DIR
    process.env.PODIUM_STATE_DIR = mkdtempSync(join(tmpdir(), 'podium-handoff-server-'))
    try {
      const { reg, sessionId, issueId } = await handoffRegistry({
        withIssue: true,
        oldDaemon: true,
      })
      await reg.modules.issueSessionLifecycle.handoffSession(
        { sessionId, machineId: asMachineId('m2') },
        TEST_CALLER,
      )
      expect(await reg.modules.issues.reports.get(issueId!)).toMatchObject({
        worktreePath: '/source/repo/.worktrees/x',
        repoPath: '/source/repo',
        machineId: asMachineId('m1'),
      })
    } finally {
      if (prior === undefined) delete process.env.PODIUM_STATE_DIR
      else process.env.PODIUM_STATE_DIR = prior
    }
  })

  it('resumes the unchanged source row when export fails', async () => {
    const { reg, source, sessionId } = await handoffRegistry({ failExport: true })
    await expect(
      reg.modules.issueSessionLifecycle.handoffSession(
        { sessionId, machineId: asMachineId('m2') },
        TEST_CALLER,
      ),
    ).rejects.toThrow('export exploded')
    expect(await clientSessionViews(reg)).toMatchObject([
      { sessionId, machineId: 'm1', cwd: '/source/repo/.worktrees/x', status: 'starting' },
    ])
    expect(source.filter((message) => message.type === 'spawn')).toHaveLength(2)
  })
})

// POD-6422: the route creates a `session.handoff` effect record and waits for
// it; the move itself runs after commit, through the unchanged coordinator.
describe('session handoff as an effect record (POD-6422)', () => {
  /** Every `effects.create` the entry point applied, with who sent it. */
  const effectCreates = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls
      .map(([envelope, principal, transport]) => ({
        envelope: envelope as { command: string; input: { id: string; kind: string } },
        principal: principal as { kind: string },
        transport,
      }))
      .filter((call) => call.envelope.command === 'effects.create')

  const callerFor = async (reg: SessionRegistry) => {
    const repos = new RepoRegistry(reg, reg.sessionStore)
    const superagent = await SuperagentService.create(reg.modules, repos, reg.sessionStore)
    return appRouter.createCaller({
      registry: reg,
      repos,
      superagent,
      capability: TEST_CAPABILITY,
      principal: TEST_PRINCIPAL,
    })
  }

  it('the tRPC route answers as it did, from a record that ran the coordinator once', async () => {
    const { reg, source, target, sessionId } = await handoffRegistry()
    const submit = vi.spyOn(reg.modules.syncWrite, 'submitDetailed')
    const coordinator = vi.spyOn(reg.modules.issueSessionLifecycle, 'handoffSession')
    const call = await callerFor(reg)

    await expect(
      call.sessions.handoff({ sessionId, machineId: asMachineId('m2') }),
    ).resolves.toEqual({ ok: true, newCwd: '/target/repo/.worktrees/x' })

    const [created] = effectCreates(submit)
    expect(created?.envelope.input).toMatchObject({
      kind: 'session.handoff',
      target: { kind: 'session', id: sessionId },
      input: { machineId: 'm2' },
    })
    expect(created?.transport).toBe('trpc')
    const row = await reg.sessionStore.effects.get(created?.envelope.input.id ?? '')
    expect(row).toMatchObject({
      status: 'succeeded',
      result: { ok: true, newCwd: '/target/repo/.worktrees/x' },
      createdBy: firstAdminMemberId(),
    })
    expect(coordinator).toHaveBeenCalledTimes(1)
    expect(source.filter((m) => m.type === 'handoffExportRequest')).toHaveLength(1)
    expect(target.filter((m) => m.type === 'spawn')).toHaveLength(1)
  })

  it('a refusal is the record’s failure, and the route rethrows it unchanged', async () => {
    const { reg, sessionId } = await handoffRegistry()
    const submit = vi.spyOn(reg.modules.syncWrite, 'submitDetailed')
    const call = await callerFor(reg)

    // A plain refusal keeps its words.
    await expect(
      call.sessions.handoff({ sessionId, machineId: asMachineId('m1') }),
    ).rejects.toThrow('session is already on that machine')
    // A classified one keeps its class: an unknown machine fails as one.
    const unknown = await handoffThroughEffect(reg.modules, TEST_PRINCIPAL, {
      sessionId,
      machineId: asMachineId('no-such-machine'),
    }).catch((error: unknown) => error)
    expect(unknown).toBeInstanceOf(HandoffRefusalError)
    expect((unknown as HandoffRefusalError).refusal).toBe('unknown-target')

    const rows = await Promise.all(
      effectCreates(submit).map((c) => reg.sessionStore.effects.get(c.envelope.input.id)),
    )
    expect(rows.map((r) => [r?.status, r?.error?.code])).toEqual([
      ['failed', 'refused'],
      ['failed', 'unknown-target'],
    ])
    expect(rows[0]?.error?.message).toBe('session is already on that machine')
    expect(await meta(reg, sessionId)).toMatchObject({ machineId: 'm1' })
  })

  it('an unknown session is the route’s pinned throw, and no record is made', async () => {
    const { reg } = await handoffRegistry()
    const submit = vi.spyOn(reg.modules.syncWrite, 'submitDetailed')
    await expect(
      handoffThroughEffect(reg.modules, TEST_PRINCIPAL, {
        sessionId: asSessionId('00000000-0000-4000-8000-000000000000'),
        machineId: asMachineId('m2'),
      }),
    ).rejects.toThrow(/^unknown session$/)
    const [created] = effectCreates(submit)
    expect(created).toBeDefined()
    expect(await reg.sessionStore.effects.get(created?.envelope.input.id ?? '')).toBeUndefined()
  })

  it('an agent’s relay handoff is a record written as that agent', async () => {
    const { reg, sessionId } = await handoffRegistry()
    const submit = vi.spyOn(reg.modules.syncWrite, 'submitDetailed')
    const reply = new Promise<Extract<ControlMessage, { type: 'agentRelayResult' }>>((resolve) => {
      void attachDaemonWithInventory(
        reg,
        'm1',
        (msg) => {
          if (msg.type === 'agentRelayResult') resolve(msg)
        },
        fixtureInventory({
          agents: [{ kind: 'claude-code', installed: true, login: { state: 'in' } }],
        }),
      )
    })
    await reg.gateway.routeDaemonFrame('m1', {
      type: 'agentRelayRequest',
      requestId: 'agent-handoff',
      sessionId,
      router: 'sessions',
      proc: 'handoff',
      // Itself, onto a machine that does not exist: refused by the run, as the agent.
      input: { sessionId, machineId: 'no-such-machine' },
    })
    const answer = await reply
    expect(answer.ok).toBe(false)
    const [created] = effectCreates(submit)
    expect(created?.principal).toMatchObject({ kind: 'agent', agentSessionId: sessionId })
    expect(created?.transport).toBe('relay')
    const row = await reg.sessionStore.effects.get(created?.envelope.input.id ?? '')
    expect(row).toMatchObject({
      kind: 'session.handoff',
      actor: `session:${sessionId}`,
      status: 'failed',
    })
    // The relay names the error's class, as it did when the arm threw it itself.
    expect(answer.error).toBe(`HandoffRefusalError: ${row?.error?.message}`)
  })

  it('recovers from the session row: arrived, untouched on the source, or unknown', async () => {
    const { reg, sessionId } = await handoffRegistry()
    const executor = reg.modules.effects?.executors.get('session.handoff')
    if (executor?.recover === undefined) throw new Error('no session.handoff executor')
    const recoverWith = async (row: Record<string, unknown> | undefined) => {
      vi.spyOn(reg.modules.sessions, 'sessionById').mockResolvedValueOnce(row as never)
      return await executor.recover?.({
        record: { target: { kind: 'session', id: sessionId } } as never,
        input: { machineId: asMachineId('m2') },
        stage: async () => {},
        cancelRequested: async () => false,
        signal: new AbortController().signal,
        stopped: new AbortController().signal,
      })
    }
    expect(await recoverWith({ machineId: 'm2', cwd: '/t/x', status: 'starting' })).toEqual({
      status: 'succeeded',
      result: { ok: true, newCwd: '/t/x' },
    })
    expect(await recoverWith({ machineId: 'm1', cwd: '/s/x', status: 'live' })).toMatchObject({
      status: 'failed',
      error: { code: 'interrupted' },
    })
    expect(
      await recoverWith({
        machineId: 'm1',
        cwd: '/s/x',
        status: 'hibernated',
        handoffTargetMachineId: 'm2',
      }),
    ).toMatchObject({ status: 'unknown' })
  })
})

async function meta(reg: SessionRegistry, sessionId: string) {
  return await reg.modules.sessions.sessionById(asSessionId(sessionId))
}

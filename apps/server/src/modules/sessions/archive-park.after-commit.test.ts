/**
 * ARCHIVE STOPS THE AGENT AFTER THE COMMIT, NEVER INSIDE IT (POD-6349).
 *
 * `sessions.setArchived` parks a running session: the row flips to hibernated
 * (or exited) and the daemon is asked to retire the process. The row is a
 * database write; the stop is a round trip to the agent's machine. Once the
 * command runs inside one unit of work (POD-6241 Task 10), a stop issued from
 * inside it would kill an agent for an archive the unit of work can still roll
 * back, and would hold the write connection for a network round trip.
 *
 * So the stop is an after-commit effect. These tests open the unit of work
 * themselves, the way the sync entry point will:
 *
 *  - a rollback sends no stop and leaves the agent running;
 *  - a commit sends exactly one stop, after the commit;
 *  - a crash between the commit and the stop leaves an archived, parked row over
 *    a live process, and the machine's durable census retires it.
 */

import { firstAdminMemberId, type SessionId } from '@podium/model'
import type { ControlMessage } from '@podium/protocol/daemon'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionRegistry } from '../../relay'
import { attachHostDaemon } from '../../test-support/host-daemon'
import { openTestStore } from '../../test-support/open-test-store'
import { clientSessionViews } from '../../test-support/session-views'

const registries: SessionRegistry[] = []

afterEach(async () => {
  for (const r of registries.splice(0)) await r.dispose()
})

async function makeRegistry(): Promise<{ reg: SessionRegistry; daemon: ControlMessage[] }> {
  const store = await openTestStore(':memory:')
  await store.machines.upsertMachine({
    id: store.hostMachineId,
    name: 'test-host',
    hostname: 'test-host',
    tokenHash: 'test',
    ownerUserId: await firstAdminMemberId(store),
    assignment: { server: true, agentExecution: true },
  })
  const reg = await SessionRegistry.create(store, undefined, { instanceId: 'default' })
  registries.push(reg)
  const daemon: ControlMessage[] = []
  await attachHostDaemon(reg, (m) => {
    daemon.push(m)
    if (m.type === 'runtimeLifecycleRequest')
      void reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
        type: 'runtimeLifecycleResult',
        requestId: m.requestId,
        sessionId: m.sessionId,
        result: { ok: true, retirement: 'confirmed' },
      })
  })
  return { reg, daemon }
}

async function liveResumable(reg: SessionRegistry): Promise<SessionId> {
  const { sessionId } = await reg.modules.sessions.createSession({
    agentKind: 'claude-code',
    cwd: '/r',
  })
  const machine = reg.sessionStore.hostMachineId
  await reg.gateway.routeDaemonFrame(machine, {
    type: 'bind',
    sessionId,
    cmd: 'claude',
    cwd: '/r',
    agentKind: 'claude-code',
    geometry: { cols: 80, rows: 24 },
  })
  await reg.gateway.routeDaemonFrame(machine, {
    type: 'sessionResumeRef',
    sessionId,
    resume: { kind: 'claude-session', value: 'native-1' },
  })
  return sessionId
}

const stopsFor = (daemon: ControlMessage[], sessionId: SessionId) =>
  daemon.filter((m) => m.type === 'runtimeLifecycleRequest' && m.sessionId === sessionId)

async function meta(reg: SessionRegistry, sessionId: SessionId) {
  return (await clientSessionViews(reg)).find((s) => s.sessionId === sessionId)
}

describe('archive park runs its stop after the commit (POD-6349)', () => {
  it('a rolled-back archive sends no stop and leaves the agent running', async () => {
    const { reg, daemon } = await makeRegistry()
    const sessionId = await liveResumable(reg)

    await expect(
      reg.sessionStore.transact(async () => {
        await reg.modules.sessions.setArchived({ sessionId, archived: true })
        throw new Error('forced rollback')
      }),
    ).rejects.toThrow('forced rollback')
    // Give a stray effect every chance to fire before asserting it did not.
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(stopsFor(daemon, sessionId)).toHaveLength(0)
    expect(daemon.some((m) => m.type === 'kill' && m.sessionId === sessionId)).toBe(false)
    expect(await meta(reg, sessionId)).toMatchObject({ archived: false, status: 'live' })
  })

  it('a committed archive sends exactly one stop, and only once the commit is done', async () => {
    const { reg, daemon } = await makeRegistry()
    const sessionId = await liveResumable(reg)

    let stopsInsideTheUnitOfWork = -1
    await reg.sessionStore.transact(async () => {
      await reg.modules.sessions.setArchived({ sessionId, archived: true })
      stopsInsideTheUnitOfWork = stopsFor(daemon, sessionId).length
    })

    expect(stopsInsideTheUnitOfWork).toBe(0)
    await vi.waitFor(() => expect(stopsFor(daemon, sessionId)).toHaveLength(1))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(stopsFor(daemon, sessionId)).toHaveLength(1)
    expect(await meta(reg, sessionId)).toMatchObject({ archived: true, status: 'hibernated' })
  })

  it('an issue archive inside a unit of work stops its member sessions after the commit', async () => {
    const { reg, daemon } = await makeRegistry()
    await reg.sessionStore.repos.addRepo('/r', reg.sessionStore.hostMachineId)
    const issue = await reg.modules.issues.crud.create({
      repoPath: '/r',
      title: 'archived',
      startNow: false,
    })
    const sessionId = await liveResumable(reg)
    await reg.modules.sessions.setSessionIssueId(sessionId, issue.id)

    let stopsInsideTheUnitOfWork = -1
    await reg.sessionStore.transact(async () => {
      await reg.modules.issues.attention.archive(issue.id)
      stopsInsideTheUnitOfWork = stopsFor(daemon, sessionId).length
    })

    expect(stopsInsideTheUnitOfWork).toBe(0)
    await vi.waitFor(() => expect(stopsFor(daemon, sessionId)).toHaveLength(1))
    expect(await meta(reg, sessionId)).toMatchObject({ archived: true, status: 'hibernated' })
  })

  it('the durable census retires an archived parked row whose process still runs', async () => {
    const { reg, daemon } = await makeRegistry()
    const sessionId = await liveResumable(reg)
    // The state a crash between the park commit and its stop leaves behind:
    // the row reads parked and archived, the machine still runs the agent.
    expect(await reg.modules.sessions.hibernateSession({ sessionId })).toEqual({ ok: true })
    await reg.modules.sessions.setArchived({ sessionId, archived: true })
    daemon.length = 0

    await reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
      type: 'durableSessionCensus',
      labels: [`podium-${sessionId}`],
    })

    await vi.waitFor(() => expect(stopsFor(daemon, sessionId)).toHaveLength(1))
    // Archive means stopped: the row is not revived and nothing reattaches it.
    expect(daemon.some((m) => m.type === 'reattach' && m.sessionId === sessionId)).toBe(false)
    expect(await meta(reg, sessionId)).toMatchObject({ archived: true, status: 'hibernated' })
  })

  it('the census leaves an archived parked row alone when its process is gone', async () => {
    const { reg, daemon } = await makeRegistry()
    const sessionId = await liveResumable(reg)
    expect(await reg.modules.sessions.hibernateSession({ sessionId })).toEqual({ ok: true })
    await reg.modules.sessions.setArchived({ sessionId, archived: true })
    daemon.length = 0

    await reg.gateway.routeDaemonFrame(reg.sessionStore.hostMachineId, {
      type: 'durableSessionCensus',
      labels: [],
    })
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(stopsFor(daemon, sessionId)).toHaveLength(0)
  })
})

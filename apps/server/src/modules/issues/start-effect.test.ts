/**
 * FILING A TASK AND STARTING ITS FIRST AGENT AS AN `issue.start` EFFECT (POD-6410).
 *
 * Through the composed server (`makeOracle`) over `sync.submit`: `effects.create`
 * of kind `issue.start`, its target the device-minted issue id, its input the
 * create's fields plus the device-minted session id. Every assertion reads back
 * the record, the issue and session rows, and the spawn frames the daemon got.
 */

import {
  asUserId,
  BUILTIN_HARNESS_KINDS,
  firstAdminMemberId,
  type IssueId,
  mintDeviceId,
  type SessionId,
} from '@podium/model'
import type { ControlMessage } from '@podium/protocol/daemon'
import { afterEach, describe, expect, it } from 'vitest'
import { userCommandPrincipal } from '../../command-principal'
import { confirmingRetirement } from '../../test-support/host-daemon'
import { disposeOracles, makeOracle, type Oracle, waitFor } from '../sessions/oracle-support'
import { appliedReply, changeRows, envelope, submit } from '../sync-write/outbox-test-support'
import { ISSUE_START_DEADLINE_MS, ISSUE_START_KIND } from './start-effect'

afterEach(() => disposeOracles())

const newSessionId = () => crypto.randomUUID() as SessionId
const newIssueId = () => mintDeviceId('iss_') as IssueId

async function oracle(opts?: Parameters<typeof makeOracle>[0]): Promise<Oracle> {
  const o = await makeOracle(opts)
  await o.store.repos.addRepo('/p', o.store.hostMachineId)
  await reportInventory(o)
  return o
}

/** What the daemon can run: every built-in harness, installed and logged in. */
async function reportInventory(o: Oracle): Promise<void> {
  const machineId = o.reg.sessionStore.hostMachineId
  await o.reg.gateway.routeDaemonFrame(machineId, {
    type: 'inventoryReport',
    machineId,
    inventory: {
      os: 'linux',
      arch: 'x64',
      agents: BUILTIN_HARNESS_KINDS.map((kind) => ({
        kind,
        installed: true,
        login: { state: 'in' as const },
      })),
      tools: [],
      // Issue start asks for a headed driver; a real daemon advertises it.
      runtimeDrivers: [{ harness: 'claude-code', id: 'claude-pty', family: 'terminal' }],
    },
  })
}

const startEnvelope = (
  effectId: string,
  issueId: string,
  input: Record<string, unknown>,
  m: string,
) =>
  envelope(
    'effects.create',
    { id: effectId, kind: ISSUE_START_KIND, target: { kind: 'issue', id: issueId }, input },
    m,
  )

const task = (sessionId: SessionId, extra: Record<string, unknown> = {}) => ({
  repoPath: '/p',
  title: 'Fix the login',
  description: 'a private description',
  sessionId,
  defaultAgent: 'claude-code',
  ...extra,
})

const spawns = (o: Oracle, id: SessionId) =>
  o.daemon.filter((m) => m.type === 'spawn' && (m as { sessionId?: string }).sessionId === id)

const issueRow = async (o: Oracle, id: string) => await o.reg.modules.issues.reports.getMeta(id)

async function settled(o: Oracle, id: string) {
  await waitFor(async () => {
    const status = (await o.store.effects.get(id))?.status
    return status !== undefined && status !== 'pending' && status !== 'running'
  }, `effect ${id} to settle`)
  return await o.store.effects.get(id)
}

/** The oracle's own daemon detached and back, as a fresh attach with its inventory. */
async function reattach(o: Oracle): Promise<void> {
  const machineId = o.reg.sessionStore.hostMachineId
  o.reg.gateway.detachDaemon(machineId)
  await o.reg.gateway.attachDaemon(
    machineId,
    confirmingRetirement(o.reg, machineId, (msg: ControlMessage) => {
      o.daemon.push(msg)
      if (msg.type === 'repoOpRequest') {
        void o.reg.gateway.routeDaemonFrame(machineId, {
          type: 'repoOpResult',
          requestId: msg.requestId,
          ok: true,
          output: '',
        })
      }
    }),
  )
  await reportInventory(o)
}

describe('an issue.start effect', () => {
  it('files the issue and starts its agent under the device ids, once', async () => {
    const o = await oracle()
    const effectId = mintDeviceId('eff_')
    const issueId = newIssueId()
    const sessionId = newSessionId()

    appliedReply(await submit(o, startEnvelope(effectId, issueId, task(sessionId), 's-1')))
    const record = await settled(o, effectId)
    expect(record?.error).toBeUndefined()

    expect(record).toMatchObject({ status: 'succeeded', result: { issueId, sessionId } })
    expect(await issueRow(o, issueId)).toMatchObject({ id: issueId, title: 'Fix the login' })
    expect(await o.reg.modules.sessions.sessionRowExists(sessionId)).toBe(true)
    expect(spawns(o, sessionId)).toHaveLength(1)
  })

  it('a replayed create (same mutationId) files once and spawns once', async () => {
    const o = await oracle()
    const effectId = mintDeviceId('eff_')
    const issueId = newIssueId()
    const sessionId = newSessionId()
    const env = startEnvelope(effectId, issueId, task(sessionId), 's-1')
    appliedReply(await submit(o, env))
    await settled(o, effectId)

    expect(appliedReply(await submit(o, env)).replayed).toBe(true)
    await o.reg.modules.effects?.runner.sweep()
    await o.reg.modules.effects?.runner.idle()

    expect(spawns(o, sessionId)).toHaveLength(1)
    const listed = await o.call.issues.list({})
    expect(listed.filter((i: { id: string }) => i.id === issueId)).toHaveLength(1)
  })

  it('waits pending with no daemon, runs on the attach, and a second attach never runs it again', async () => {
    const o = await oracle()
    const host = o.reg.sessionStore.hostMachineId
    o.reg.gateway.detachDaemon(host)
    const effectId = mintDeviceId('eff_')
    const issueId = newIssueId()
    const sessionId = newSessionId()

    appliedReply(
      await submit(
        o,
        startEnvelope(effectId, issueId, task(sessionId, { machineId: host }), 's-1'),
      ),
    )
    await o.reg.modules.effects?.runner.sweep()
    await o.reg.modules.effects?.runner.idle()
    expect(await o.store.effects.get(effectId)).toMatchObject({ status: 'pending', attempts: 0 })
    expect(await issueRow(o, issueId)).toBeNull()

    await reattach(o)
    expect((await settled(o, effectId))?.status).toBe('succeeded')
    expect(spawns(o, sessionId)).toHaveLength(1)

    await reattach(o)
    await o.reg.modules.effects?.runner.sweep()
    await o.reg.modules.effects?.runner.idle()
    expect(spawns(o, sessionId)).toHaveLength(1)
  })

  it('a writer who lost use of the machine before the attach files nothing and starts nothing', async () => {
    const o = await oracle()
    const host = o.reg.sessionStore.hostMachineId
    o.reg.gateway.detachDaemon(host)
    const effectId = mintDeviceId('eff_')
    const issueId = newIssueId()
    const sessionId = newSessionId()
    appliedReply(
      await submit(
        o,
        startEnvelope(effectId, issueId, task(sessionId, { machineId: host }), 's-1'),
      ),
    )

    const other = asUserId('mem_start_other')
    await o.store.users.create(
      {
        id: other,
        displayName: 'Other',
        role: 'member',
        createdAt: '2026-11-05T00:00:00.000Z',
        disabledAt: null,
      },
      'test-only',
    )
    await o.reg.modules.machines.transferMachineOwnership(host, other, firstAdminMemberId())
    await reattach(o)

    expect(await settled(o, effectId)).toMatchObject({
      status: 'failed',
      error: { code: 'refused', message: 'no longer allowed to use this machine' },
    })
    expect(await issueRow(o, issueId)).toBeNull()
    expect(spawns(o, sessionId)).toHaveLength(0)
  })

  it('the create is checked at act time: a parent archived before the run files nothing', async () => {
    const o = await oracle()
    const writer = asUserId('mem_start_writer')
    await o.store.users.create(
      {
        id: writer,
        displayName: 'Writer',
        role: 'member',
        createdAt: '2026-11-05T00:00:00.000Z',
        disabledAt: null,
      },
      'test-only',
    )
    const parentId = newIssueId()
    await o.call.issues.create({ id: parentId, repoPath: '/p', title: 'parent', startNow: false })
    o.reg.gateway.detachDaemon(o.reg.sessionStore.hostMachineId)
    const effectId = mintDeviceId('eff_')
    const issueId = newIssueId()
    const sessionId = newSessionId()
    const { reply } = await o.reg.modules.syncWrite.submitDetailed(
      startEnvelope(effectId, issueId, task(sessionId, { parentId }), 's-1'),
      userCommandPrincipal(writer, 'member'),
      'trpc',
    )
    appliedReply(reply)

    await o.call.issues.archive({ id: parentId })
    await reattach(o)

    expect(await settled(o, effectId)).toMatchObject({
      status: 'failed',
      error: { code: 'refused', message: expect.stringContaining('archived') },
    })
    expect(await issueRow(o, issueId)).toBeNull()
    expect(spawns(o, sessionId)).toHaveLength(0)
  })

  it('a start that fails after filing keeps the issue, and the failure is on its record', async () => {
    const o = await oracle()
    const effectId = mintDeviceId('eff_')
    const issueId = newIssueId()
    const sessionId = newSessionId()
    const workflow = o.reg.modules.issues.gitWorkflow
    const start = workflow.start
    workflow.start = async () => {
      throw new Error('no harness on that machine')
    }
    try {
      appliedReply(await submit(o, startEnvelope(effectId, issueId, task(sessionId), 's-1')))
      expect(await settled(o, effectId)).toMatchObject({
        status: 'failed',
        target: { kind: 'issue', id: issueId },
        error: { code: 'start-failed', message: 'no harness on that machine' },
      })
    } finally {
      workflow.start = start
    }
    expect(await issueRow(o, issueId)).toMatchObject({ id: issueId })
    expect(spawns(o, sessionId)).toHaveLength(0)
  })

  it('a start whose machine stays away past its deadline expires and files nothing', async () => {
    let clock = Date.parse('2026-11-05T10:00:00.000Z')
    const o = await oracle({ now: () => clock })
    o.reg.gateway.detachDaemon(o.reg.sessionStore.hostMachineId)
    const effectId = mintDeviceId('eff_')
    const issueId = newIssueId()
    appliedReply(await submit(o, startEnvelope(effectId, issueId, task(newSessionId()), 's-1')))

    clock += ISSUE_START_DEADLINE_MS + 1
    await o.reg.modules.effects?.runner.sweep()
    await o.reg.modules.effects?.runner.idle()

    expect(await o.store.effects.get(effectId)).toMatchObject({ status: 'expired' })
    expect(await issueRow(o, issueId)).toBeNull()
  })

  it('refuses an id that is not a new D4 issue id, or one an issue already holds', async () => {
    const o = await oracle()
    const bad = await submit(
      o,
      startEnvelope(mintDeviceId('eff_'), 'POD-12', task(newSessionId()), 's-1'),
    )
    expect(bad.outcome).toBe('rejected')

    const taken = newIssueId()
    await o.call.issues.create({ id: taken, repoPath: '/p', title: 'taken', startNow: false })
    const sessionId = newSessionId()
    const effectId = mintDeviceId('eff_')
    const reply = await submit(o, startEnvelope(effectId, taken, task(sessionId), 's-2'))
    if (reply.outcome === 'applied') {
      // Allowed to read as a command on the existing issue, but never a start.
      expect((await settled(o, effectId))?.error?.code).toBe('conflict')
    }
    expect(spawns(o, sessionId)).toHaveLength(0)
    expect(await issueRow(o, taken)).toMatchObject({ title: 'taken' })
  })

  it('the feed carries the start without its description', async () => {
    const o = await oracle()
    const effectId = mintDeviceId('eff_')
    appliedReply(
      await submit(o, startEnvelope(effectId, newIssueId(), task(newSessionId()), 's-1')),
    )
    await settled(o, effectId)
    const fed = (await changeRows(o)).filter(
      (r) => r.entity === 'effect' && r.entityId === effectId,
    )
    expect(fed.length).toBeGreaterThan(0)
    for (const r of fed) expect(String(r.payload)).not.toContain('a private description')
  })
})

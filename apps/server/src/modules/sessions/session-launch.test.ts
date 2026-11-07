/**
 * STARTING A SESSION AS A `session.launch` EFFECT RECORD (POD-6398).
 *
 * Driven through the REAL composed server (`makeOracle`) over `sync.submit`:
 * `effects.create` with kind `session.launch` and the device-minted session id
 * as its target; the effects runner launches it when a daemon can take it, and
 * every assertion reads back the effect record, the session row and the frames
 * the daemon was sent.
 */

import {
  asUserId,
  BUILTIN_HARNESS_KINDS,
  firstAdminMemberId,
  mintDeviceId,
  type SessionId,
} from '@podium/model'
import type { ControlMessage } from '@podium/protocol/daemon'
import { afterEach, describe, expect, it } from 'vitest'
import { confirmingRetirement } from '../../test-support/host-daemon'
import { appliedReply, changeRows, envelope, submit } from '../sync-write/outbox-test-support'
import { disposeOracles, makeOracle, type Oracle, waitFor } from './oracle-support'
import { SESSION_LAUNCH_DEADLINE_MS, SESSION_LAUNCH_KIND } from './session-launch-effect'

afterEach(() => disposeOracles())

const newSessionId = () => crypto.randomUUID() as SessionId

const launchEnvelope = (
  effectId: string,
  sessionId: SessionId,
  input: Record<string, unknown>,
  m: string,
) =>
  envelope(
    'effects.create',
    { id: effectId, kind: SESSION_LAUNCH_KIND, target: { kind: 'session', id: sessionId }, input },
    m,
  )

const spawns = (o: Oracle, id: SessionId) =>
  o.daemon.filter((m) => m.type === 'spawn' && (m as { sessionId?: string }).sessionId === id)

const effectOf = async (o: Oracle, id: string) => await o.store.effects.get(id)

async function settled(o: Oracle, id: string) {
  await waitFor(async () => {
    const status = (await effectOf(o, id))?.status
    return status !== undefined && status !== 'pending' && status !== 'running'
  }, `effect ${id} to settle`)
  return await effectOf(o, id)
}

/** The oracle's daemon again, as it attached it, with its inventory report. */
async function reattach(o: Oracle): Promise<void> {
  const machineId = o.reg.sessionStore.hostMachineId
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
    },
  })
}

describe('a session.launch effect', () => {
  it('starts the session under the device id once a daemon can take it, and succeeds', async () => {
    const o = await makeOracle()
    const effectId = mintDeviceId('eff_')
    const sessionId = newSessionId()

    appliedReply(
      await submit(
        o,
        launchEnvelope(
          effectId,
          sessionId,
          { agentKind: 'claude-code', cwd: '/p', initialPrompt: 'secret plan' },
          'l-1',
        ),
      ),
    )
    const row = await settled(o, effectId)

    expect(row?.status).toBe('succeeded')
    expect(spawns(o, sessionId)).toHaveLength(1)
    expect(await o.reg.modules.sessions.sessionRowExists(sessionId)).toBe(true)
    // The feed carries where it starts, never the first prompt.
    const fed = (await changeRows(o)).filter(
      (r) => r.entity === 'effect' && r.entityId === effectId,
    )
    expect(fed.length).toBeGreaterThan(0)
    for (const r of fed) expect(String(r.payload)).not.toContain('secret plan')
  })

  it('a replayed create (same mutationId) spawns once', async () => {
    const o = await makeOracle()
    const effectId = mintDeviceId('eff_')
    const sessionId = newSessionId()
    const env = launchEnvelope(effectId, sessionId, { agentKind: 'claude-code', cwd: '/p' }, 'l-1')
    appliedReply(await submit(o, env))
    await settled(o, effectId)

    expect(appliedReply(await submit(o, env)).replayed).toBe(true)
    await o.reg.modules.effects?.runner.idle()

    expect(spawns(o, sessionId)).toHaveLength(1)
  })

  it('waits pending while no daemon is attached, starts on the attach, and a second attach never spawns again', async () => {
    const o = await makeOracle()
    o.reg.gateway.detachDaemon(o.reg.sessionStore.hostMachineId)
    const effectId = mintDeviceId('eff_')
    const sessionId = newSessionId()

    appliedReply(
      await submit(
        o,
        launchEnvelope(effectId, sessionId, { agentKind: 'claude-code', cwd: '/p' }, 'l-1'),
      ),
    )
    await o.reg.modules.effects?.runner.sweep()
    await o.reg.modules.effects?.runner.idle()
    expect(await effectOf(o, effectId)).toMatchObject({ status: 'pending', attempts: 0 })
    expect(spawns(o, sessionId)).toHaveLength(0)

    await reattach(o)
    expect((await settled(o, effectId))?.status).toBe('succeeded')
    expect(spawns(o, sessionId)).toHaveLength(1)

    o.reg.gateway.detachDaemon(o.reg.sessionStore.hostMachineId)
    await reattach(o)
    await o.reg.modules.effects?.runner.sweep()
    await o.reg.modules.effects?.runner.idle()
    expect(spawns(o, sessionId)).toHaveLength(1)
  })

  it('a launch whose writer lost use of its machine before the attach fails and starts nothing', async () => {
    const o = await makeOracle()
    const host = o.reg.sessionStore.hostMachineId
    o.reg.gateway.detachDaemon(host)
    const effectId = mintDeviceId('eff_')
    const sessionId = newSessionId()
    appliedReply(
      await submit(
        o,
        launchEnvelope(
          effectId,
          sessionId,
          { agentKind: 'claude-code', cwd: '/p', machineId: host },
          'l-1',
        ),
      ),
    )

    const other = asUserId('mem_launch_other')
    await o.store.users.create(
      {
        id: other,
        displayName: 'Other',
        role: 'member',
        createdAt: '2026-11-04T00:00:00.000Z',
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
    expect(spawns(o, sessionId)).toHaveLength(0)
  })

  it('a launch whose machine stays away past the deadline expires and never runs', async () => {
    let clock = Date.parse('2026-11-04T10:00:00.000Z')
    const o = await makeOracle({ now: () => clock })
    o.reg.gateway.detachDaemon(o.reg.sessionStore.hostMachineId)
    const effectId = mintDeviceId('eff_')
    const sessionId = newSessionId()
    appliedReply(
      await submit(
        o,
        launchEnvelope(effectId, sessionId, { agentKind: 'claude-code', cwd: '/p' }, 'l-1'),
      ),
    )

    clock += SESSION_LAUNCH_DEADLINE_MS + 1
    await o.reg.modules.effects?.runner.sweep()
    await o.reg.modules.effects?.runner.idle()

    expect(await effectOf(o, effectId)).toMatchObject({
      status: 'expired',
      error: { code: 'deadline' },
    })
    expect(spawns(o, sessionId)).toHaveLength(0)
  })

  it('refuses a target that is not a new session id', async () => {
    const o = await makeOracle()
    const reply = await submit(
      o,
      launchEnvelope(
        mintDeviceId('eff_'),
        'not-a-uuid' as SessionId,
        { agentKind: 'claude-code', cwd: '/p' },
        'l-1',
      ),
    )
    expect(reply.outcome).toBe('rejected')
  })
})

describe('sessions.create is an adapter onto the effect', () => {
  it('answers as before, with the session started through a session.launch record', async () => {
    const o = await makeOracle()
    const sessionId = newSessionId()

    const result = await o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p', sessionId })

    expect(result.sessionId).toBe(sessionId)
    expect(spawns(o, sessionId)).toHaveLength(1)
    const launches = (await changeRows(o)).filter(
      (r) => r.entity === 'effect' && String(r.payload).includes(sessionId),
    )
    expect(launches.length).toBeGreaterThan(0)
  })

  it("a legacy create's browser files are held, named by id in the record, and land on the draft", async () => {
    // LEGACY(remove-after: 2027-01): pre-chat-upload web clients (POD-6601).
    const o = await makeOracle()
    // The draft task is filed in a repo the host reports.
    await o.store.repos.addRepo('/p', o.store.hostMachineId)
    const sessionId = newSessionId()

    await o.call.sessions.create({
      agentKind: 'claude-code',
      cwd: '/p',
      sessionId,
      draftIssue: { repoPath: '/p' },
      draftArtifacts: [
        { id: 'att-1', filename: 'mock.png', mimeType: 'image/png', dataBase64: 'UE5H' },
      ],
    })

    expect(spawns(o, sessionId)).toHaveLength(1)
    const launch = await o.store.effects.newestOnTarget(
      SESSION_LAUNCH_KIND,
      { kind: 'session', id: sessionId },
      'succeeded',
    )
    expect(launch?.input).toMatchObject({
      draftArtifactUploads: [{ id: 'att-1', uploadId: expect.any(String) }],
    })
    // The record, and every feed change, carry the held id, never the bytes.
    expect(JSON.stringify(launch?.input)).not.toContain('UE5H')
    expect((await changeRows(o)).some((r) => String(r.payload).includes('UE5H'))).toBe(false)
    const draft = (await o.reg.issues.reports.list('/p')).find((issue) => issue.draft)
    expect(draft?.panel?.artifacts).toEqual([
      expect.objectContaining({ path: 'attachments/att-1/mock.png', title: 'mock.png' }),
    ])
    // The held copy has done its job.
    const held = (launch?.input as { draftArtifactUploads: { uploadId: string }[] })
      .draftArtifactUploads[0]?.uploadId as string
    expect(await o.reg.modules.pendingUploads.meta(held)).toBeUndefined()
  })

  it('with no daemon attached it refuses at once as before, and creates no record', async () => {
    const o = await makeOracle()
    o.reg.gateway.detachDaemon(o.reg.sessionStore.hostMachineId)
    const sessionId = newSessionId()

    await expect(
      o.call.sessions.create({ agentKind: 'claude-code', cwd: '/p', sessionId }),
    ).rejects.toThrow()
    const launches = (await changeRows(o)).filter(
      (r) => r.entity === 'effect' && String(r.payload).includes(sessionId),
    )
    expect(launches).toHaveLength(0)
  })
})

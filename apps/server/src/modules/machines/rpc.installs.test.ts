import { asMachineId } from '@podium/model'
import {
  CAP_HARNESS_INSTALL_CANCEL,
  CAP_HARNESS_INSTALLS,
  type HarnessInstallAction,
} from '@podium/protocol'
import { ControlMessage, DaemonMessage } from '@podium/protocol/daemon'
import { describe, expect, it } from 'vitest'
import { DaemonRequestBroker } from '../daemon-request'
import { DaemonRpcService } from './rpc'

const machineId = asMachineId('machine-test')
const pairs = [
  ['install', 'Install'],
  ['check', 'Check'],
  ['back', 'Back'],
  ['pause', 'Pause'],
  ['resume', 'Resume'],
  ['take-settings', 'TakeSettings'],
  ['remove-changes', 'RemoveChanges'],
  ['changes', 'Changes'],
  ['remove', 'Remove'],
  ['home-info', 'HomeInfo'],
  ['remove-home', 'HomeRemove'],
  ['cancel-install', 'CancelInstall'],
] as const
function setup(
  supports = true,
  ok = true,
  caps: readonly string[] = [CAP_HARNESS_INSTALLS, CAP_HARNESS_INSTALL_CANCEL],
) {
  const sent: unknown[] = []
  let rpc: DaemonRpcService
  const broker = new DaemonRequestBroker({
    defaultMachine: () => machineId,
    toMachine: (id, frame) => {
      const request = ControlMessage.parse(frame)
      sent.push(request)
      // The daemon test double parses the actual wire and returns that action's own result.
      if (!('requestId' in request)) throw new Error('expected a request')
      const reply = DaemonMessage.parse({
        type: request.type.replace(/Request$/, 'Result'),
        requestId: request.requestId,
        ok,
        ...(ok ? { outcome: 'confirmed' } : { error: 'vendor refused the request' }),
      })
      if (!('requestId' in reply)) throw new Error('expected an RPC reply')
      queueMicrotask(() =>
        rpc.settleDaemonReply(id, reply as Parameters<DaemonRpcService['settleDaemonReply']>[1]),
      )
    },
  })
  rpc = new DaemonRpcService({
    broker,
    memory: {
      canReadSession: async () => true,
      transcriptPathHint: async () => undefined,
      readTranscriptFromLake: async () => ({ items: [], hasMore: false }),
      transcriptHasPredecessors: async () => false,
    },
    daemonSupports: (_id, cap) => supports && caps.includes(cap),
    toMachine: () => {},
    defaultMachine: () => machineId,
    resolveMachine: () => machineId,
    hasDaemon: () => true,
    machineName: async () => 'Test machine',
    machineNames: async (ids) => new Map(ids.map((id) => [id, 'Test machine'])),
    onlineMachineIds: () => [machineId],
    getSession: async () => undefined,
  })
  return { rpc, sent }
}

describe('managed install request round trips', () => {
  it.each(pairs)('%s reaches its own daemon request/result pair', async (action, name) => {
    const { rpc, sent } = setup()
    await expect(rpc.harnessAction(action, 'codex', machineId, [])).resolves.toEqual({
      ok: true,
      outcome: 'confirmed',
    })
    expect(sent).toEqual([
      expect.objectContaining({ type: `harness${name}Request`, harness: 'codex' }),
    ])
  })
  it.each(pairs)('never sends %s without harness.installs.v1', async (action) => {
    const { rpc, sent } = setup(false)
    expect((await rpc.harnessAction(action, 'codex', machineId, [])).ok).toBe(false)
    expect(sent).toEqual([])
  })
  it('passes the daemon’s failure through without deciding on another version', async () => {
    const { rpc, sent } = setup(true, false)
    await expect(rpc.harnessAction('install', 'codex', machineId)).resolves.toEqual({
      ok: false,
      error: 'vendor refused the request',
    })
    expect(sent).toHaveLength(1)
  })
  it('never sends a cancel to a daemon that manages installs but cannot cancel one', async () => {
    const { rpc, sent } = setup(true, true, [CAP_HARNESS_INSTALLS])
    await expect(rpc.harnessAction('cancel-install', 'codex', machineId)).resolves.toEqual({
      ok: false,
      error: 'Update Podium on this machine to cancel a harness install.',
    })
    expect(sent).toEqual([])
  })
  it('never sends home deletion without conversation confirmation', async () => {
    const { rpc, sent } = setup()
    expect(
      (await rpc.harnessAction('remove-home' as HarnessInstallAction, 'codex', machineId)).ok,
    ).toBe(false)
    expect(sent).toEqual([])
  })
})

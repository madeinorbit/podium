/**
 * THE COORDINATOR IS NOT A STRAGGLER (POD-2907).
 *
 * On 2026-08-31 a publication finished at 06:14:56Z and this host's parent
 * launched a successor at 06:14:58Z. There was no `updates.start`, no converge
 * action and no operation row anywhere near that minute — the operations table's
 * last terminal transition before it was the previous evening. The restart was a
 * parent handover, and the only thing that asks the parent to hand over on this
 * shape is the coordinator's own local update participant applying a GRANT.
 *
 * This file exercises that grant deterministically, across the real seam:
 * {@link UpdatesService} + {@link UpdateReconciler} + the local participant that
 * `server.ts` attaches for the host machine. Nothing here is a fleet — the whole
 * point is that one publication and one `machine.connected` for THIS host were
 * enough, with nobody clicking anything.
 *
 * THE ARMED NEGATIVE CONTROL IS THE FIRST CASE. A guard test that has never been
 * shown to fire is a test that proves nothing about the guard, so the fleet row
 * that does NOT say which machine is the coordinator — the projection as it
 * stood on 2026-08-31, before POD-3170 put `coordinator` on it — is constructed
 * here and shown to restart the server. The production wiring is the case
 * beneath it.
 */
import { asMachineId, type MachineId } from '@podium/model'
import type { UpdateGrantMessage, UpdateTarget } from '@podium/protocol'
import type { ControlMessage } from '@podium/protocol/daemon'
import { describe, expect, it } from 'vitest'
import type { GrantRecord } from './grant-cause'
import { startLocalUpdateParticipant } from './local-participant'
import { decideReconciliation, UpdateReconciler } from './reconciler'
import { UpdatesService } from './service'
import type { WaveMachine } from './wave'

const HOST = 'dabfcbd6-ca30-422f-9189-36077c81a63d'
const LAPTOP = 'a-laptop-that-was-asleep'
const RUNNING_VERSION = '0.1.1-dev.29+09743a0'
const PUBLISHED_VERSION = '0.1.1-dev.30+f8e38a1'

/** The dev target a publication writes into the feed: packed, feed-delivered. */
function publishedTarget(version = PUBLISHED_VERSION): UpdateTarget {
  return {
    version,
    critical: false,
    artifacts: {
      headless: {
        delivery: 'feed',
        platforms: {
          'linux-x86_64': {
            url: `http://127.0.0.1:18787/dev/${version}.tar.gz`,
            size: 1,
            sha256: 'x',
          },
        },
      },
    },
  } as unknown as UpdateTarget
}

/**
 * A machine row exactly as the fleet projection carries one: `installed`,
 * feed-capable, online, and running a version a publication makes "behind".
 */
function row(id: string, name: string, coordinator = false): WaveMachine {
  return {
    id,
    name,
    // POD-3170's flag on the fleet projection, and the ONE answer to "is this
    // this server?": `decideWave` holds this machine until last for it, and
    // `decideReconciliation` refuses it outright for it.
    ...(coordinator ? { coordinator: true } : {}),
    version: RUNNING_VERSION,
    state: 'current',
    online: true,
    busy: false,
    installKind: 'installed',
    deliveryCaps: ['update.delivery.feed'],
    platform: 'linux-x86_64',
  } as unknown as WaveMachine
}

/**
 * @param knowsItsOwnIdentity false reproduces the projection as it stood on the
 *        day of the incident: one that cannot tell the coordinator from a laptop.
 */
function harness(options: { knowsItsOwnIdentity: boolean; fleet?: WaveMachine[] }) {
  const fleet: WaveMachine[] =
    options.fleet ?? [row(HOST, 'ludovico', options.knowsItsOwnIdentity)]
  /** The in-process transport `attachUpdateParticipant` installs for the host. */
  let participantSend:
    | ((message: Extract<ControlMessage, { type: 'updateGrant' }>) => void)
    | undefined
  let grants = 0
  const recorded: GrantRecord[] = []
  const sentTo: string[] = []

  const updates = new UpdatesService({
    machines: () => fleet,
    send: (machineId: MachineId, message: UpdateGrantMessage) => {
      sentTo.push(String(machineId))
      if (machineId !== HOST) return
      participantSend?.(message as never)
    },
    now: () => 1_000,
    nextGrantId: () => `g${++grants}`,
    concurrency: 3,
    fleetChannel: () => 'dev',
    recordGrant: (record) => recorded.push(record),
  })

  const installed: UpdateTarget[] = []
  const restarts: string[] = []

  const participant = startLocalUpdateParticipant({
    machineId: asMachineId(HOST),
    appVersion: RUNNING_VERSION,
    runtimeDir: '/tmp/podium-test-runtime-unused',
    machines: {
      setMachineBuild: () => {},
      attachUpdateParticipant: (_id, send) => {
        participantSend = send
      },
      detachUpdateParticipant: () => true,
    },
    updates: { onStatus: (machineId, status) => updates.onStatus(machineId, status) },
    // The parent's two asks, observed rather than performed.
    installTarget: async (target) => {
      installed.push(target)
      return {}
    },
    writePending: () => {},
    restart: (expectedVersion) => {
      restarts.push(expectedVersion)
    },
  })

  const reconciler = new UpdateReconciler({
    updates,
    // NO OPERATION. This is the whole premise of the incident.
    operationActive: () => false,
    schedule: () => {},
  })

  /** Let the participant's async `apply` reach `restart`. */
  const settle = async () => {
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
  }

  return { updates, reconciler, installed, restarts, recorded, sentTo, participant, settle }
}

describe('the coordinator and the standing reconciliation (POD-2907)', () => {
  it('ARMED CONTROL: a reconciler blind to its own identity restarts this server', async () => {
    const h = harness({ knowsItsOwnIdentity: false })

    // The only human act in the scenario, and its subject is a proposal.
    h.updates.setTarget('dev', publishedTarget())
    // The local daemon's websocket reconnects under this host's own machine id.
    h.reconciler.onMachineConnected(HOST)
    await h.settle()

    expect(h.restarts).toEqual([PUBLISHED_VERSION])
    expect(h.installed).toHaveLength(1)
  })

  it('does not restart the coordinator when a publication alone lands', async () => {
    const h = harness({ knowsItsOwnIdentity: true })

    h.updates.setTarget('dev', publishedTarget())
    h.reconciler.onMachineConnected(HOST)
    await h.settle()

    expect(h.restarts, 'the coordinator asked its parent to hand over').toEqual([])
    expect(h.installed, 'the coordinator swapped its own bundle').toEqual([])
    expect(h.sentTo, 'a grant left the server at all').toEqual([])
  })

  it('still converges an ORDINARY machine that reconnects behind the target', async () => {
    const h = harness({
      knowsItsOwnIdentity: true,
      fleet: [row(HOST, 'ludovico', true), row(LAPTOP, 'laptop')],
    })

    h.updates.setTarget('dev', publishedTarget())
    h.reconciler.onMachineConnected(LAPTOP)
    await h.settle()

    expect(h.sentTo).toEqual([LAPTOP])
    expect(h.restarts, 'somebody else’s update restarted this server').toEqual([])
  })

  it('names the coordinator refusal rather than a fact about the target', () => {
    // ORDER MATTERS. The refusal must hold whatever is published and whatever
    // the row's state is, so a reader of the log sees the real reason.
    expect(
      decideReconciliation({
        machine: row(HOST, 'ludovico', true),
        target: undefined,
        operationActive: false,
        attempts: 0,
      }),
    ).toEqual({ converge: false, because: 'coordinator' })
  })

  it('writes down who authorized a grant, and whether it replaces this process', () => {
    const h = harness({ knowsItsOwnIdentity: true, fleet: [row(HOST, 'ludovico', true)] })
    h.updates.setTarget('dev', publishedTarget())

    // A person pressing Apply on the coordinator's own row IS allowed — that is
    // a decision somebody made, and the record says so and says what it costs.
    h.updates.authorizeMachine(asMachineId(HOST), {
      initiator: { kind: 'operator-apply' },
      eligibility: 'a person pressed Apply on this fleet row',
    })

    expect(h.recorded).toEqual([
      {
        at: 1_000,
        grantId: 'g1',
        machineId: HOST,
        machineName: 'ludovico',
        channel: 'dev',
        targetVersion: PUBLISHED_VERSION,
        fromVersion: RUNNING_VERSION,
        initiator: { kind: 'operator-apply' },
        eligibility: 'a person pressed Apply on this fleet row',
        handover: true,
      },
    ])
  })
})

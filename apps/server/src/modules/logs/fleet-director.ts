/**
 * `logs.setDaemonLevel` — THE OPERATOR REACHING A RUNNING DAEMON (POD-3156).
 *
 * The sibling of `./level-director.ts`, one plane over. That one turns "raise
 * this one user's client" into frames on `/client` sockets; this one turns
 * "raise Flatblock" into a frame on Flatblock's daemon socket. The two are
 * deliberately the same shape, because an operator holding one investigation
 * should not have to hold two mental models of what a raise is.
 *
 * ---------------------------------------------------------------------------
 * ONLINE MACHINES ONLY, AND IT DOES NOT QUEUE
 * ---------------------------------------------------------------------------
 * `MachinesService.toMachine` queues a control frame for a briefly-offline
 * machine and flushes it on the next attach. That is right for a spawn and
 * WRONG for a raise, for the reason the client contract already gives: a raise
 * held through an offline period arrives after the incident it was issued for,
 * and turns up a daemon nobody is investigating — on a host that has meanwhile
 * been rebooted, at a level nobody remembers asking for.
 *
 * So this sends only to machines with a live socket RIGHT NOW, and the reply
 * says which those were. An operator whose machine was offline sees it missing
 * from the list and re-issues, which is one keystroke and always the right
 * answer.
 *
 * ---------------------------------------------------------------------------
 * NO STATE, ON PURPOSE — AND THE STAKES ARE HIGHER THAN FOR A CLIENT
 * ---------------------------------------------------------------------------
 * Nothing is remembered here. A raise is delivered and is then the DAEMON's,
 * held under the daemon's own TTL, and a daemon that reconnects is at its
 * default again. A server-side "machines that should be at debug" table would
 * give a raise that survives a reconnect, and with it the failure this whole
 * feature is written to avoid — except that where a stuck client is fixed by a
 * page reload, a stuck daemon forwards someone else's host contents across a
 * network until a human notices. The absence of that table is the feature.
 *
 * ---------------------------------------------------------------------------
 * THE REPLY IS THE DISCOVERY MECHANISM
 * ---------------------------------------------------------------------------
 * As next door: there is no separate "list daemons" query in this family. The
 * reply names every machine the command reached, so an operator with no idea
 * what is connected resets everything, reads who that was, and narrows on the
 * next call.
 */

import type { MachineId } from '@podium/model'
import { createLogger } from '@podium/logger'
import type { ControlMessage } from '@podium/protocol/daemon'
import type { LogsSetDaemonLevelInput } from '@podium/commands'

const log = createLogger('server:logs')

/**
 * The fleet, narrowed to what a raise needs: who has a live daemon, what it is
 * called, and how to hand one of them a frame.
 *
 * A PORT rather than `MachinesService` for `ClientConnectionsPort`'s reason —
 * this module is a feature and the machine registry is the machines module's.
 */
export interface DaemonConnectionsPort {
  /** Machines with a live daemon socket right now. */
  onlineMachineIds(): MachineId[]
  /** Display name for a machine; falls back to the id. */
  machineName(id: string): string
  /** Deliver a control frame. Only ever called for an ONLINE machine here. */
  toMachine(machineId: MachineId, msg: ControlMessage): void
}

/** One daemon a raise reached, as the operator needs to see it. */
export interface RaisedDaemon {
  machineId: MachineId
  name: string
  /** Records this machine reported dropping since the server booted — a LOSSY
   *  LINK, or a daemon louder than its socket. Surfaced in the same reply that
   *  raised it so the operator does not have to grep the file to find out. */
  dropped?: number
  /** Records THIS SERVER dropped under its own ingestion backpressure. A
   *  different fact with a different fix — the far end sent them and they were
   *  lost here — so it is a different field rather than a bigger number. */
  serverDropped?: number
}

export interface SetDaemonLevelResult {
  /** What the level now is on the daemons below; `null` means "their default". */
  level: LogsSetDaemonLevelInput['level']
  /** Every machine the command reached, in registry order. */
  daemons: RaisedDaemon[]
}

/** The two drop counters, when the store is available to ask. */
export interface FleetDropCounts {
  /** What the daemon said it lost. */
  droppedFor(machineId: MachineId): number
  /** What this server lost after accepting it. */
  serverDroppedFor(machineId: MachineId): number
}

export class FleetLogLevelDirector {
  constructor(
    private readonly fleet: DaemonConnectionsPort,
    private readonly drops?: FleetDropCounts,
  ) {}

  setLevel(input: LogsSetDaemonLevelInput): SetDaemonLevelResult {
    const message: ControlMessage = {
      type: 'setDaemonLogLevel',
      level: input.level,
      ...(input.ttlMs !== undefined ? { ttlMs: input.ttlMs } : {}),
    }
    const reached: RaisedDaemon[] = []
    for (const machineId of this.fleet.onlineMachineIds()) {
      // Absent selector does not constrain — an empty target is every online
      // daemon, matching the client family's `logLevelTarget`.
      if (input.target?.machineId !== undefined && input.target.machineId !== machineId) continue
      this.fleet.toMachine(machineId, message)
      const dropped = this.drops?.droppedFor(machineId) ?? 0
      const serverDropped = this.drops?.serverDroppedFor(machineId) ?? 0
      reached.push({
        machineId,
        name: this.fleet.machineName(machineId),
        ...(dropped > 0 ? { dropped } : {}),
        ...(serverDropped > 0 ? { serverDropped } : {}),
      })
    }
    // The server's own record of an act performed on somebody else's HOST, at a
    // level the server's default shows. `to`, not `level`: the record shape owns
    // `level` and drops a caller field of that name.
    log.info('daemon log level command', {
      to: input.level,
      ...(input.ttlMs !== undefined ? { ttlMs: input.ttlMs } : {}),
      reached: reached.length,
    })
    return { level: input.level, daemons: reached }
  }
}

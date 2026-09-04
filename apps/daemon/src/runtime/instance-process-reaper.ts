/**
 * REAP ONE INSTANCE'S SESSION PROCESSES BY PROVEN IDENTITY (POD-2691).
 *
 * The server decides that a session must stop. This module is the daemon's
 * last-resort process-table consumer for descendants that the normal runtime
 * registry or binding journal did not retain — notably a child left behind by
 * a crashed daemon. It is deliberately narrow: UUID + session id attribute the
 * process, and the boot id + /proc start time pin the pid to this incarnation.
 *
 * NEVER use pgrep here. Every agent carries the same prompt in its command
 * line, so command-line matching cannot establish ownership. The cwd read is
 * part of the census evidence and is intentionally obtained from
 * readlink(/proc/<pid>/cwd), not inferred from argv.
 *
 * A process that cannot be inspected completely is skipped. Missing proof is
 * not proof of ownership, and a skipped process is safer than a wrongful kill.
 */

import { readFileSync, readdirSync, readlinkSync } from 'node:fs'
import { setTimeout as sleepFor } from 'node:timers/promises'
import { createLogger } from '@podium/logger'
import type { SessionId } from '@podium/model'
import { parseProcStatStartTime } from '@podium/runtime/instance-guard'

const log = createLogger('daemon:instance-process-reaper')

export const INSTANCE_REAP_TERM_GRACE_MS = 3_000
export const INSTANCE_REAP_KILL_GRACE_MS = 2_000
const INSTANCE_REAP_POLL_MS = 250

export interface InstanceProcessReapIo {
  listPids(): readonly number[]
  readEnvironment(pid: number): { instanceUuid?: string; sessionId?: string } | undefined
  readCwd(pid: number): string | undefined
  readStartTime(pid: number): string | undefined
  bootId(): string | undefined
  pidAlive(pid: number): boolean
  signal(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void
  sleep(ms: number): Promise<void>
}

interface ProcessIdentity {
  pid: number
  cwd: string
  instanceUuid: string
  sessionId: string
  bootId: string
  startTime: string
}

function numericPid(entry: string): number | undefined {
  if (!/^\d+$/.test(entry)) return undefined
  const pid = Number(entry)
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined
}

function readEnvironment(pid: number): { instanceUuid?: string; sessionId?: string } | undefined {
  try {
    const values = new Map<string, string>()
    for (const entry of readFileSync(`/proc/${pid}/environ`).toString('utf8').split('\0')) {
      const separator = entry.indexOf('=')
      if (separator <= 0) continue
      values.set(entry.slice(0, separator), entry.slice(separator + 1))
    }
    const instanceUuid = values.get('PODIUM_INSTANCE_UUID')
    const sessionId = values.get('PODIUM_SESSION_ID')
    return instanceUuid && sessionId ? { instanceUuid, sessionId } : undefined
  } catch {
    return undefined
  }
}

const defaultIo: InstanceProcessReapIo = {
  listPids: () => {
    try {
      return readdirSync('/proc').flatMap((entry) => {
        const pid = numericPid(entry)
        return pid === undefined ? [] : [pid]
      })
    } catch {
      return []
    }
  },
  readEnvironment,
  readCwd(pid) {
    try {
      return readlinkSync(`/proc/${pid}/cwd`)
    } catch {
      return undefined
    }
  },
  readStartTime(pid) {
    try {
      return parseProcStatStartTime(readFileSync(`/proc/${pid}/stat`, 'utf8'))
    } catch {
      return undefined
    }
  },
  bootId() {
    try {
      return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || undefined
    } catch {
      return undefined
    }
  },
  pidAlive(pid) {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM'
    }
  },
  signal(pid, signal) {
    try {
      process.kill(pid, signal)
    } catch {
      // The process can exit between the proof and the signal. That is success
      // for this best-effort cleanup, not an unhandled teardown error.
    }
  },
  sleep: (ms) => sleepFor(ms),
}

export interface InstanceProcessReapResult {
  /** Processes whose environment/cwd was inspected in the first census. */
  examined: number
  /** SIGTERM attempts made after immediate identity revalidation. */
  termSignalled: number
  /** SIGKILL attempts made after the TERM grace window and revalidation. */
  killSignalled: number
  /** Pids still alive with the same exact identity after escalation. */
  remaining: number
}

function identityAt(
  io: InstanceProcessReapIo,
  pid: number,
): ProcessIdentity | undefined {
  const bootId = io.bootId()
  const environment = io.readEnvironment(pid)
  const cwd = io.readCwd(pid)
  const startTime = io.readStartTime(pid)
  if (!bootId || !environment?.instanceUuid || !environment.sessionId || !cwd || !startTime)
    return undefined
  return {
    pid,
    cwd,
    instanceUuid: environment.instanceUuid,
    sessionId: environment.sessionId,
    bootId,
    startTime,
  }
}

function sameIdentity(expected: ProcessIdentity, actual: ProcessIdentity | undefined): boolean {
  return (
    actual !== undefined &&
    actual.pid === expected.pid &&
    actual.cwd === expected.cwd &&
    actual.instanceUuid === expected.instanceUuid &&
    actual.sessionId === expected.sessionId &&
    actual.bootId === expected.bootId &&
    actual.startTime === expected.startTime
  )
}

async function waitForIdentityToDisappear(
  identity: ProcessIdentity,
  io: InstanceProcessReapIo,
  windowMs: number,
): Promise<'gone' | 'foreign' | 'alive'> {
  const attempts = Math.max(1, Math.ceil(windowMs / INSTANCE_REAP_POLL_MS))
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!io.pidAlive(identity.pid)) return 'gone'
    if (!sameIdentity(identity, identityAt(io, identity.pid))) return 'foreign'
    if (attempt < attempts - 1) await io.sleep(INSTANCE_REAP_POLL_MS)
  }
  return 'alive'
}

/**
 * Signal all exact-identity descendants for one session in this daemon's
 * instance. The initial list is only a candidate snapshot; every signal is
 * preceded by a fresh complete identity read to close the PID-reuse race.
 */
export async function reapInstanceSessionProcesses(input: {
  instanceUuid: string | undefined
  sessionId: SessionId | string
  io?: InstanceProcessReapIo
  termGraceMs?: number
  killGraceMs?: number
}): Promise<InstanceProcessReapResult> {
  const empty: InstanceProcessReapResult = {
    examined: 0,
    termSignalled: 0,
    killSignalled: 0,
    remaining: 0,
  }
  if (!input.instanceUuid) return empty

  const io = input.io ?? defaultIo
  if (!io.bootId()) {
    log.warn('cannot reap instance processes without a boot id', {
      instanceUuid: input.instanceUuid,
      sessionId: input.sessionId,
    })
    return empty
  }

  const candidates: ProcessIdentity[] = []
  for (const pid of io.listPids()) {
    // Defense in depth: bootstrap clears the daemon's inherited session id,
    // but the authority process is never a session child worth reaping.
    if (pid === process.pid) continue
    const identity = identityAt(io, pid)
    if (
      identity?.instanceUuid === input.instanceUuid &&
      identity.sessionId === String(input.sessionId)
    ) {
      candidates.push(identity)
    }
  }

  let termSignalled = 0
  let killSignalled = 0
  let remaining = 0
  for (const candidate of candidates) {
    // Re-read all identity fields immediately before TERM. A PID that was
    // recycled after the census must be left entirely alone.
    if (!sameIdentity(candidate, identityAt(io, candidate.pid))) continue
    try {
      io.signal(candidate.pid, 'SIGTERM')
      termSignalled += 1
    } catch (error) {
      log.warn('instance process TERM failed', { err: error, pid: candidate.pid })
      continue
    }

    const afterTerm = await waitForIdentityToDisappear(
      candidate,
      io,
      input.termGraceMs ?? INSTANCE_REAP_TERM_GRACE_MS,
    )
    if (afterTerm !== 'alive') continue

    // The same identity proof is required again before escalation. In
    // particular, a recycled PID cannot receive our SIGKILL.
    if (!sameIdentity(candidate, identityAt(io, candidate.pid))) continue
    try {
      io.signal(candidate.pid, 'SIGKILL')
      killSignalled += 1
    } catch (error) {
      log.warn('instance process KILL failed', { err: error, pid: candidate.pid })
      continue
    }

    const afterKill = await waitForIdentityToDisappear(
      candidate,
      io,
      input.killGraceMs ?? INSTANCE_REAP_KILL_GRACE_MS,
    )
    if (afterKill === 'alive') remaining += 1
  }

  return {
    examined: candidates.length,
    termSignalled,
    killSignalled,
    remaining,
  }
}

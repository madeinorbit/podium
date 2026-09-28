import { AsyncLocalStorage } from 'node:async_hooks'
import { basename } from 'node:path'
import { HARNESS_VERSION_POLICIES } from '@podium/harness'
import type { DaemonMessage } from '@podium/protocol/daemon'

type Report = Extract<DaemonMessage, { type: 'machineHarnessVersion' }>
type Send = (message: DaemonMessage) => void
const reporting = new AsyncLocalStorage<Send>()

/** Bind observations to the host handling this command, including asynchronous probes. */
export function withHarnessVersionReporting<T>(send: Send, run: () => T): T {
  return reporting.run(send, run)
}

/** Record successful probe output only; telemetry must never affect a spawn.
 *
 * Which CLIs report is the version-policy set's own answer (POD-4737): a
 * harness with a policy in HARNESS_VERSION_POLICIES reports, one without does
 * not. No harness name lives here — adding a policy enables reporting with no
 * second edit. Binary names coincide with kinds for the harnesses that have
 * policies today; a CLI whose binary differs from its kind simply misses the
 * set, which is the honest answer for a harness with no policy. */
function hasVersionPolicy(harness: string): harness is keyof typeof HARNESS_VERSION_POLICIES {
  return harness in HARNESS_VERSION_POLICIES
}

export function reportHarnessProbe(command: string, output: string): void {
  const harness = basename(command)
  if (!hasVersionPolicy(harness)) return
  const version = output.match(/\d+\.\d+\.\d+(?:[-+][\w.-]+)?/u)?.[0]
  if (!version) return
  sendHarnessVersion(reporting.getStore(), harness, version)
}

export function sendHarnessVersion(
  send: Send | undefined,
  harness: Report['harness'],
  version: string,
  probedAt = new Date().toISOString(),
): void {
  try {
    send?.({ type: 'machineHarnessVersion', harness, version, probedAt })
  } catch {
    // Observations are best-effort data, never an admission requirement.
  }
}

import { AsyncLocalStorage } from 'node:async_hooks'
import { basename } from 'node:path'
import type { DaemonMessage } from '@podium/protocol/daemon'

type Report = Extract<DaemonMessage, { type: 'machineHarnessVersion' }>
type Send = (message: DaemonMessage) => void
const reporting = new AsyncLocalStorage<Send>()

/** Bind observations to the host handling this command, including asynchronous probes. */
export function withHarnessVersionReporting<T>(send: Send, run: () => T): T {
  return reporting.run(send, run)
}

/** Record successful probe output only; telemetry must never affect a spawn. */
export function reportHarnessProbe(command: string, output: string): void {
  const harness = basename(command)
  if (harness !== 'codex' && harness !== 'grok' && harness !== 'opencode') return
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

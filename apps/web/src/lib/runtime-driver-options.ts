import type { AgentKind, MachineWire } from '@podium/model/browser'

export interface HeadlessRuntimeDriver {
  harness: AgentKind
  id: string
  family: string
}

/** The selectable driver set is authority-reported inventory, never a client
 * catalogue. Terminal-family rows are the headed/default path and therefore do
 * not appear as experimental alternatives. */
export function headlessRuntimeDrivers(
  machine: MachineWire | undefined,
  harness?: AgentKind,
): HeadlessRuntimeDriver[] {
  return (machine?.inventory?.runtimeDrivers ?? []).filter(
    (driver) => driver.family !== 'terminal' && (harness === undefined || driver.harness === harness),
  )
}

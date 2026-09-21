/**
 * Install the vendor agent CLIs the "Add machine" command asks for — a thin
 * client of the Inventory install mechanism (POD-4414 §4.4).
 *
 * This module names no harness: which installers exist, what they download,
 * and what they run is declared per harness in `adapters/<harness>/install.ts`
 * and executed by `@podium/harness/inventory`. What stays here is the CLI
 * surface — the spinner per harness, capture-and-show-on-failure vendor
 * output, and keep-going-after-a-failure across harnesses.
 */
import {
  installTargetFor,
  runInstallTarget,
  type InstallRequestPorts,
} from '@podium/harness/inventory'
import type { SetupIO } from './setup-ui'

export interface AgentInstallResult {
  id: string
  ok: boolean
  detail?: string
}

export type InstallAgentsDeps = Omit<InstallRequestPorts, 'note'>

export async function installAgents(
  io: SetupIO,
  ids: string[],
  binDir: string,
  deps: InstallAgentsDeps = {},
): Promise<AgentInstallResult[]> {
  const results: AgentInstallResult[] = []
  for (const raw of ids) {
    // Throws for an unknown id and for a known harness with no declared
    // installer — fail fast with the mechanism's reason, naming nothing here.
    const target = installTargetFor(raw)
    const spin = io.spinner()
    spin.start(`Installing ${target.displayName}`)
    try {
      runInstallTarget(target, binDir, {
        ...deps,
        note: (message) => {
          spin.stop(message)
          spin.start(`Installing ${target.displayName}`)
        },
      })
      spin.stop(`${target.displayName} installed`)
      results.push({ id: raw, ok: true })
    } catch (e) {
      // The vendor's own output is the useful part, and it is only useful on a failure.
      const detail = (e as Error).message
      spin.error(`${target.displayName} failed to install`)
      io.error(detail)
      results.push({ id: raw, ok: false, detail })
    }
  }
  return results
}

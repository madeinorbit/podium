/** Explicit --agents requests use the same managed release mechanism as machine controls. */

import { manifestFor } from '@podium/harness'
import {
  buildResolvedInventory,
  defaultHarnessesDir,
  type ResolvedHarnessInventory,
  requestManagedInstall,
} from '@podium/harness/inventory'
import { isBuiltinHarnessKind } from '@podium/model'
import type { SetupIO } from './setup-ui'

export interface AgentInstallResult {
  id: string
  ok: boolean
  detail?: string
}
export interface InstallAgentsDeps {
  harnessesDir?: string
  snapshot?: () => Promise<ResolvedHarnessInventory>
  install?: typeof requestManagedInstall
}

export async function installAgents(
  io: SetupIO,
  ids: string[],
  deps: InstallAgentsDeps = {},
): Promise<AgentInstallResult[]> {
  for (const id of ids) if (!isBuiltinHarnessKind(id)) throw new Error(`unsupported agent '${id}'`)
  const results: AgentInstallResult[] = []
  for (const raw of ids) {
    if (!isBuiltinHarnessKind(raw)) continue
    const name = manifestFor(raw)?.displayName ?? raw
    const spin = io.spinner()
    spin.start(`Installing ${name} for Podium`)
    try {
      const snapshot = await (deps.snapshot ?? buildResolvedInventory)()
      const own = snapshot.executables.has(raw)
        ? true
        : snapshot.inventory.agents.find((agent) => agent.kind === raw)?.installed === null
          ? null
          : false
      const result = await (deps.install ?? requestManagedInstall)(raw, own, {
        harnessesDir: deps.harnessesDir ?? defaultHarnessesDir(),
        commandEnv: snapshot.commandEnvironment.env,
        requestedBy: 'machine-setup',
        note: (message) => {
          spin.stop(message)
          spin.start(`Installing ${name} for Podium`)
        },
      })
      if (result.outcome !== 'installed')
        throw new Error(
          'error' in result
            ? result.error
            : 'Another harness install is in progress. Try again when it finishes.',
        )
      spin.stop(`${name} ${result.version} installed for Podium`)
      results.push({ id: raw, ok: true })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      spin.error(`${name} failed to install`)
      io.error(detail)
      results.push({ id: raw, ok: false, detail })
    }
  }
  return results
}

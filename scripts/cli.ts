/**
 * `podium` CLI — runnable entry + composition root. The launcher logic moved to
 * apps/cli (Phase 3 step 4); this shim stays at the historical path so
 * `bun scripts/cli.ts`, the bun-compile entry (scripts/cli-compiled.ts) and
 * docs keep working. It is the ONE place that injects the in-process host
 * modules (apps/server + apps/daemon) into the CLI — apps/cli itself never
 * imports app code (boundary rule: the CLI depends only on @podium/protocol,
 * @podium/domain, @podium/core and @podium/issue-client).
 */

import type { HostModules } from '../apps/cli/src/cli'
import { main as cliMain } from '../apps/cli/src/cli'

export {
  type DaemonStartOptions,
  daemonOptionsForPlan,
  type HostModules,
  type LaunchPlan,
  main as cliMain,
  portInUseMessage,
  resolvePlan,
} from '../apps/cli/src/cli'

async function loadHost(): Promise<HostModules> {
  const [server, daemon] = await Promise.all([
    import('../apps/server/src/server'),
    import('../apps/daemon/src/daemon'),
  ])
  return {
    startServer: server.startServer,
    isAddressInUseError: server.isAddressInUseError,
    startDaemon: daemon.startDaemon as HostModules['startDaemon'],
  }
}

export async function main(): Promise<void> {
  return cliMain(loadHost)
}

if (import.meta.main) void main()

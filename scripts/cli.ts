/**
 * `podium` CLI — runnable entry + composition root. The launcher logic moved to
 * apps/cli (Phase 3 step 4); this shim stays at the historical path so
 * `bun scripts/cli.ts`, the bun-compile entry (scripts/cli-compiled.ts) and
 * docs keep working. It is the ONE place that injects the in-process host
 * modules (apps/server + apps/daemon) into the CLI — apps/cli itself never
 * imports app code (boundary rule: the CLI depends only on @podium/protocol,
 * @podium/model, @podium/runtime and @podium/issue-client).
 */

import type { CliRuntimeOptions, HostModules } from '../apps/cli/src/cli'
import { main as cliMain } from '../apps/cli/src/cli'

// This literal env read is replaced by build-bun in the packaged binary. It is therefore the
// composition root's proof that this process is executing directly from a source checkout.
const SOURCE_CHECKOUT = process.env.PODIUM_APP_VERSION === undefined

export {
  alreadyRunningMessage,
  type CliRuntimeOptions,
  type DaemonStartOptions,
  daemonOptionsForPlan,
  type HostModules,
  type LaunchPlan,
  type ModePlan,
  main as cliMain,
  portInUseMessage,
  resolveModePlan,
  resolvePlan,
  unknownLaunchToken,
} from '../apps/cli/src/cli'

async function loadHost(): Promise<HostModules> {
  const [server, daemon, janitor, janitorWorker] = await Promise.all([
    import('../apps/server/src/server'),
    import('../apps/daemon/src/daemon'),
    import('../apps/janitor/src/janitor'),
    import('../apps/janitor/src/worker-client'),
  ])
  return {
    startServer: server.startServer,
    isAddressInUseError: server.isAddressInUseError,
    startDaemon: daemon.startDaemon as HostModules['startDaemon'],
    startJanitorWorker: janitorWorker.startJanitorWorker,
    startJanitor: janitor.startJanitor,
  }
}

export async function main(runtime: CliRuntimeOptions = {}): Promise<void> {
  return cliMain(loadHost, { localSetupDefault: SOURCE_CHECKOUT, ...runtime })
}

if (import.meta.main) void main()

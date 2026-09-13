/**
 * `podium` CLI — runnable entry + composition root. The launcher logic moved to
 * apps/cli (Phase 3 step 4); this shim stays at the historical path so
 * `bun scripts/cli.ts`, the bun-compile entry (scripts/cli-compiled.ts) and
 * docs keep working. It is the ONE place that injects the in-process host
 * modules (apps/server + apps/daemon) into the CLI — apps/cli itself never
 * imports app code (boundary rule: the CLI depends only on @podium/protocol,
 * @podium/model, @podium/runtime and @podium/issue-client). The janitor is no
 * longer among them: every server owns its worker thread and imports
 * @podium/janitor itself (PDM-27).
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
  const [server, store, daemon] = await Promise.all([
    import('../apps/server/src/server'),
    import('../apps/server/src/store'),
    import('../apps/daemon/src/daemon'),
  ])
  return {
    /**
     * WHERE THE CLI'S DATABASE IS NAMED [PDM-346]. `startServer` takes a required
     * `dbPath` and apps/cli must not import apps/server, so the answer is given
     * HERE — this file is the composition root the CLI seam is injected from, and
     * this is the one place in the `podium` binary that decides which database a
     * server boot opens. `HostModules.startServer` stays narrowed to `{ port }`
     * because the CLI has no business choosing.
     */
    startServer: (opts) => server.startServer({ ...opts, dbPath: store.defaultDbPath() }),
    isAddressInUseError: server.isAddressInUseError,
    startDaemon: daemon.startDaemon as HostModules['startDaemon'],
  }
}

export async function main(runtime: CliRuntimeOptions = {}): Promise<void> {
  return cliMain(loadHost, { localSetupDefault: SOURCE_CHECKOUT, ...runtime })
}

/**
 * The recovery-snapshot verifier re-invokes this entry with
 * `PODIUM_VERIFY_SNAPSHOT` set (POD-3068). It is answered BEFORE the CLI so a
 * verification never boots a server, and it adds no public subcommand: the
 * request arrives in the environment and the verdict leaves on stdout.
 */
async function runEntry(): Promise<void> {
  const { runSnapshotVerifierChildIfRequested } = await import(
    '../apps/server/src/migrations/snapshot-verifier-child'
  )
  if (await runSnapshotVerifierChildIfRequested()) return
  await main()
}

if (import.meta.main) {
  try {
    await runEntry()
  } catch (error) {
    // Boot rejection is fatal even after the runtime installs its surviving
    // unhandled-rejection handler. Supervisors must see a failed launch.
    console.error(error)
    process.exit(1)
  }
}

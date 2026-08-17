import {
  buildMachineInventory,
  type MachineHarnessInventory,
  probeAllModels,
} from '@podium/harness'
import { createLogger } from '@podium/logger'
import { asMachineId } from '@podium/model'
import type { ControlMessage } from '@podium/protocol/daemon'
import type { ControlHandlers, DaemonContext } from './context'

const log = createLogger('daemon:inventory')

/**
 * Machine inventory reporting (#222): build os/arch + per-harness
 * install/version/login and push it to the server. Fired unsolicited right
 * after the handshake authenticates (every (re)connect) and on an
 * inventoryRequest frame and periodically while connected. Never throws and
 * never rides the handshake path: a hung CLI probe cannot stall reconnect.
 *
 * The build spawns up to five real CLIs for `--version`, so a definitive result
 * is cached and reconnects re-send it. An inconclusive timeout is sent but NOT
 * cached: the next reconnect/report probes again, while explicit and periodic
 * refreshes also rebuild so live changes converge without a daemon restart.
 *
 * The cache is keyed by `(machineId, homeDir)` and holds `MachineHarnessInventory`
 * — a value that names the machine it describes. Not an instance-global "current
 * inventory": per ADR 1 Amendment 1 D13.5 this is a per-machine fact with
 * visibility class `owned-compute` inheriting its machine's scoping, so a
 * singleton here is what POD-1079 would have to unpick to scope it. (machineId
 * alone would do for a daemon, which serves one machine — homeDir stays in the key
 * because the tests boot daemons against fixture homes.)
 */
const inventoryCache = new Map<string, Promise<MachineHarnessInventory>>()
const inventoryInFlight = new Map<string, Promise<MachineHarnessInventory>>()
const inventoryRebuildQueued = new Map<string, Promise<void>>()

export const DEFAULT_INVENTORY_REFRESH_INTERVAL_MS = 60_000

export async function reportInventory(
  ctx: DaemonContext,
  opts: { rebuild?: boolean; reprobe?: boolean } = {},
): Promise<void> {
  // The separator is a real NUL written as an ESCAPE, deliberately. NUL cannot
  // occur in a machineId or a path, so the composite key can never collide --
  // but a LITERAL NUL byte makes git, grep and `file` classify this module as
  // BINARY, and grep then reports nothing and exits 1 rather than erroring.
  // scripts/check-no-nul-bytes.ts exists for exactly this mistake and caught
  // this line. [POD-758]
  if (ctx.harnessRuntime) {
    try {
      const snapshot = await (opts.rebuild
        ? ctx.harnessRuntime.refresh()
        : opts.reprobe
          ? ctx.harnessRuntime.reprobe()
          : ctx.harnessRuntime.current())
      if (!ctx.harnessRuntime.isCurrent(snapshot)) return
      ctx.send({
        type: 'inventoryReport',
        machineId: asMachineId(ctx.machineId),
        inventory: snapshot.inventory,
      })
    } catch (err) {
      log.warn('inventory report failed', { err })
    }
    return
  }

  const key = `${ctx.machineId}\u0000${ctx.homeDir ?? ''}`
  let pending: Promise<MachineHarnessInventory> | undefined
  try {
    // A refresh interval, credential install, or server request can arrive while
    // a loaded CLI is still consuming the entire probe budget. Coalesce those
    // forced rebuilds into one follow-up wave: dropping the request would leave a
    // newly installed credential invisible until the next periodic refresh.
    const active = inventoryInFlight.get(key)
    if (opts.rebuild && active) {
      let queued = inventoryRebuildQueued.get(key)
      if (!queued) {
        queued = (async () => {
          try {
            await active
          } catch {
            // The active reporter owns logging/eviction. A failed probe still
            // must yield to the queued forced rebuild.
          }
          // The reporter awaiting the same build registered first; let its
          // finally block clear inventoryInFlight before starting the next wave.
          await Promise.resolve()
          inventoryRebuildQueued.delete(key)
          await reportInventory(ctx, { rebuild: true })
        })()
        inventoryRebuildQueued.set(key, queued)
      }
      return await queued
    }
    pending = opts.rebuild ? undefined : inventoryCache.get(key)
    if (!pending) {
      pending = buildMachineInventory({
        machineId: ctx.machineId,
        ...(ctx.homeDir ? { homeDir: ctx.homeDir } : {}),
      })
      inventoryCache.set(key, pending)
      inventoryInFlight.set(key, pending)
    }
    const { machineId, inventory } = await pending
    // A forced rebuild queued while this probe was running means its facts are
    // already superseded (notably, they may predate a credential install).
    // Publish only the coalesced follow-up result.
    if (inventoryRebuildQueued.has(key)) return
    // A credential install can force a rebuild while the initial handshake
    // probe is still shelling out to the agent CLIs. The old probe observed the
    // pre-copy auth files and may finish last; never let that superseded result
    // overwrite the newer logged-in inventory on the server.
    if (inventoryCache.get(key) !== pending) return
    // Mirror the driver admission verdict: an unprobeable binary is a gap, not a
    // stable fact. Publish it honestly, then evict it so the next report retries
    // without requiring a daemon restart or waiting for the periodic refresh.
    const unprobeable =
      inventory.agents.some((agent) => agent.installed === null) ||
      inventory.tools.some((tool) => tool.installed === null)
    if (unprobeable) inventoryCache.delete(key)
    // machineId comes off the probed value, not from ctx a second time: the fact
    // and the machine it is about travel together by construction.
    // The brand is asserted, not validated: this id is the daemon's OWN, read
    // from its state file at boot and carried through `DaemonContext.machineId`
    // and the inventory build, neither of which is a wire boundary.
    ctx.send({ type: 'inventoryReport', machineId: asMachineId(machineId), inventory })
  } catch (err) {
    // Evict only OUR failed build — a concurrent rebuild may have already stored
    // a fresh pending under this key; don't discard it.
    if (inventoryCache.get(key) === pending) inventoryCache.delete(key)
    log.warn('inventory report failed', { err })
  } finally {
    if (inventoryInFlight.get(key) === pending) inventoryInFlight.delete(key)
  }
}

/** Refresh changing agent capabilities while the authenticated daemon remains live. */
export function startInventoryRefresh(
  ctx: DaemonContext,
  intervalMs = DEFAULT_INVENTORY_REFRESH_INTERVAL_MS,
): () => void {
  const timer = setInterval(() => void reportInventory(ctx, { reprobe: true }), intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}

/**
 * LIVE MODEL ENUMERATION FOR THIS MACHINE (POD-1466).
 *
 * The sibling of `reportInventory`, and it runs HERE for the same reason: which
 * models a harness offers is a fact about the host whose CLIs answered. The
 * server used to shell out on its own process for every machineId, so a remote
 * machine's picker was served the SERVER's models (or nothing).
 *
 * Unlike inventory this is request-correlated and NOT cached here: the caching
 * (stale-while-revalidate, per machine, persisted) is the server's ModelCatalog,
 * and a second cache on this side would only make an upgrade take two refreshes
 * to show up. A failed probe answers with `{}` rather than silence — the server
 * keeps its last-good snapshot and the web falls back to its static catalog, and
 * an unanswered request would just burn the correlator's timeout.
 *
 * THE CLAUDE AUTH IS THIS HOST'S, and that is the point rather than a shortcut:
 * the models the picker should offer for a machine are the ones an agent running
 * ON that machine can actually reach. So the key comes from this host's
 * ANTHROPIC_API_KEY, else this host's Claude Code login. The server's
 * `apiKeys.anthropic` secret is deliberately NOT shipped down — a server-side
 * secret does not cross to a machine just to shorten a model list.
 */
async function runModelProbe(
  ctx: DaemonContext,
  msg: Extract<ControlMessage, { type: 'modelProbeRequest' }>,
): Promise<void> {
  let byAgent: Awaited<ReturnType<typeof probeAllModels>> = {}
  try {
    const snapshot = await ctx.harnessRuntime?.current()
    const credentialHome = ctx.accountHome?.path ?? ctx.homeDir
    byAgent = await probeAllModels({
      ...(snapshot
        ? {
            executables: {
              ...(snapshot.executables.get('grok')
                ? { grok: snapshot.executables.get('grok')!.path }
                : {}),
              ...(snapshot.executables.get('cursor')
                ? { cursor: snapshot.executables.get('cursor')!.path }
                : {}),
              ...(snapshot.executables.get('opencode')
                ? { opencode: snapshot.executables.get('opencode')!.path }
                : {}),
              ...(snapshot.executables.get('codex')
                ? { codex: snapshot.executables.get('codex')!.path }
                : {}),
            },
            env: snapshot.commandEnvironment.env,
          }
        : {}),
      ...(credentialHome ? { homeDir: credentialHome } : {}),
      claude: {
        ...(process.env.ANTHROPIC_API_KEY ? { apiKey: process.env.ANTHROPIC_API_KEY } : {}),
        ...(credentialHome ? { homeDir: credentialHome } : {}),
      },
    })
  } catch (err) {
    log.warn('model probe failed', { err, requestId: msg.requestId })
  }
  ctx.send({ type: 'modelProbeResult', requestId: msg.requestId, byAgent })
}

export const inventoryHandlers: Pick<ControlHandlers, 'inventoryRequest' | 'modelProbeRequest'> = {
  inventoryRequest: (ctx) => {
    void reportInventory(ctx, { rebuild: true })
  },
  modelProbeRequest: (ctx, msg) => {
    void runModelProbe(ctx, msg)
  },
}

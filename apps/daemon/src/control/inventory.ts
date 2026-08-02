import { buildMachineInventory, type MachineHarnessInventory, probeAllModels } from '@podium/harness'
import type { ControlMessage } from '@podium/protocol'
import type { ControlHandlers, DaemonContext } from './context'

/**
 * Machine inventory reporting (#222): build os/arch + per-harness
 * install/version/login and push it to the server. Fired unsolicited right
 * after the handshake authenticates (every (re)connect) and on an
 * inventoryRequest frame and periodically while connected. Never throws and
 * never rides the handshake path: a hung CLI probe cannot stall reconnect.
 *
 * The build spawns up to five real CLIs for `--version`, so it runs ONCE and is
 * cached; reconnects re-send the cached value. Explicit and periodic refreshes
 * REBUILD so installs, upgrades, and login changes on a live machine converge
 * without a daemon restart.
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

export const DEFAULT_INVENTORY_REFRESH_INTERVAL_MS = 60_000

export async function reportInventory(
  ctx: DaemonContext,
  opts: { rebuild?: boolean } = {},
): Promise<void> {
  // The separator is a real NUL written as an ESCAPE, deliberately. NUL cannot
  // occur in a machineId or a path, so the composite key can never collide --
  // but a LITERAL NUL byte makes git, grep and `file` classify this module as
  // BINARY, and grep then reports nothing and exits 1 rather than erroring.
  // scripts/check-no-nul-bytes.ts exists for exactly this mistake and caught
  // this line. [POD-758]
  const key = `${ctx.machineId}\u0000${ctx.homeDir ?? ''}`
  let pending: Promise<MachineHarnessInventory> | undefined
  try {
    pending = opts.rebuild ? undefined : inventoryCache.get(key)
    if (!pending) {
      pending = buildMachineInventory({
        machineId: ctx.machineId,
        ...(ctx.homeDir ? { homeDir: ctx.homeDir } : {}),
      })
      inventoryCache.set(key, pending)
    }
    const { machineId, inventory } = await pending
    // A credential install can force a rebuild while the initial handshake
    // probe is still shelling out to the agent CLIs. The old probe observed the
    // pre-copy auth files and may finish last; never let that superseded result
    // overwrite the newer logged-in inventory on the server.
    if (inventoryCache.get(key) !== pending) return
    // machineId comes off the probed value, not from ctx a second time: the fact
    // and the machine it is about travel together by construction.
    ctx.send({ type: 'inventoryReport', machineId, inventory })
  } catch (err) {
    // Evict only OUR failed build — a concurrent rebuild may have already stored
    // a fresh pending under this key; don't discard it.
    if (inventoryCache.get(key) === pending) inventoryCache.delete(key)
    console.warn(
      `[podium:daemon] inventory report failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

/** Refresh changing agent capabilities while the authenticated daemon remains live. */
export function startInventoryRefresh(
  ctx: DaemonContext,
  intervalMs = DEFAULT_INVENTORY_REFRESH_INTERVAL_MS,
): () => void {
  const timer = setInterval(() => void reportInventory(ctx, { rebuild: true }), intervalMs)
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
    byAgent = await probeAllModels({
      claude: {
        ...(process.env.ANTHROPIC_API_KEY ? { apiKey: process.env.ANTHROPIC_API_KEY } : {}),
        ...(ctx.homeDir ? { homeDir: ctx.homeDir } : {}),
      },
    })
  } catch (err) {
    console.warn(
      `[podium:daemon] model probe failed: ${err instanceof Error ? err.message : String(err)}`,
    )
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
